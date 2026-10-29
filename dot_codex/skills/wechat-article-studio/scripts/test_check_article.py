"""Exercise the checker's observable CLI behavior with isolated draft files."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ArticleChecks(unittest.TestCase):
    def run_check(self, directory, content, *args, suffix="html"):
        article = Path(directory) / f"article.{suffix}"
        article.write_text(content, encoding="utf-8")
        process = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("check_article.py")),
             str(article), *args], capture_output=True, text=True, check=False)
        return process.returncode, json.loads(process.stdout)

    def test_existing_and_remote_images_are_not_claimed_broken(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "配 图.png").write_bytes(b"fixture")
            status, result = self.run_check(directory,
                '<img src="配%20图.png"><img src="https://example.test/a.png">'
                '<pre>【待补图】</pre>')
            self.assertEqual(status, 0)
            self.assertEqual(result["findings"], [])
            self.assertEqual(result["remote_images_unchecked"], 1)

    def test_missing_and_empty_images_block(self):
        with tempfile.TemporaryDirectory() as directory:
            status, result = self.run_check(directory, '<img src="lost.png"><img><img src>')
            self.assertEqual(status, 1)
            self.assertEqual({item["code"] for item in result["findings"]},
                             {"missing-image", "empty-image"})

    def test_ambiguous_cases_warn_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            status, result = self.run_check(directory,
                '<img src="/site.png"><img data-src="lazy.png"><p>【待补图】</p>')
            self.assertEqual(status, 0)
            self.assertEqual(len(result["findings"]), 3)
            self.assertTrue(all(item["level"] == "warning" for item in result["findings"]))

    def test_site_root_can_be_resolved_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "site.png").write_bytes(b"fixture")
            status, result = self.run_check(directory, '<img src="/site.png">',
                                            "--asset-root", directory)
            self.assertEqual((status, result["findings"]), (0, []))

    def test_alternative_sources_need_preview_instead_of_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "candidate.png").write_bytes(b"fixture")
            status, result = self.run_check(directory,
                '<img src="lost.png" srcset="candidate.png 1x">'
                '<img src="placeholder.png" data-src="candidate.png">'
                '<picture><source srcset="candidate.png"><img src="lost.png"></picture>')
            self.assertEqual(status, 0)
            self.assertEqual(len(result["findings"]), 3)
            self.assertTrue(all(item["level"] == "warning" for item in result["findings"]))

    def test_unsupported_input_is_not_reported_as_passed(self):
        with tempfile.TemporaryDirectory() as directory:
            status, result = self.run_check(directory, "# Draft", suffix="md")
            self.assertEqual(status, 2)
            self.assertIn("input_error", result)

    def test_local_uri_warns_and_base_target_keeps_local_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            status, result = self.run_check(directory,
                '<base target="_blank"><img src="missing.png">'
                '<img src="file:///missing-image.png">')
            self.assertEqual(status, 1)
            self.assertEqual({item["code"] for item in result["findings"]},
                             {"missing-image", "file-uri"})

    def test_empty_article_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            status, result = self.run_check(directory, " \n")
            self.assertEqual(status, 1)
            self.assertEqual(result["findings"][0]["code"], "empty-article")


if __name__ == "__main__":
    unittest.main()
