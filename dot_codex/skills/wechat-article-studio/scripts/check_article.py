#!/usr/bin/env python3
"""Read-only checks for local HTML drafts; no dependencies or network access."""

import argparse
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class ArticleParser(HTMLParser):
    def __init__(self, source, asset_root=None):
        super().__init__(convert_charrefs=True)
        self.source = source
        self.asset_root = asset_root
        self.findings = []
        self.remote_images = 0
        self.skip_text = 0
        self.has_base = False
        self.picture_depth = 0

    def report(self, level, code, message):
        self.findings.append(dict(level=level, code=code,
                                  line=self.getpos()[0], message=message))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"script", "style", "pre", "code"}:
            self.skip_text += 1
        if tag == "base" and (attrs.get("href") or "").strip():
            self.has_base = True
        if tag == "picture":
            self.picture_depth += 1
        if tag != "img":
            return
        has_alternative = self.picture_depth > 0 or any(
            (attrs.get(key) or "").strip() for key in ("srcset", "data-src"))
        src = (attrs.get("src") or "").strip()
        if not src:
            if has_alternative:
                self.report("warning", "dynamic-image", "图片使用候选来源或懒加载，需在实际预览中检查。")
            else:
                self.report("error", "empty-image", "图片缺少 src。")
            return
        url = urlsplit(src)
        if url.scheme == "file":
            self.report("warning", "file-uri", "本地文件 URI 未检查，请确认它在目标发布环境中可用。")
            return
        if url.scheme or url.netloc:
            self.remote_images += 1
            return
        if self.has_base:
            self.report("warning", "base-url", "文档使用 base，需按实际站点检查相对图片。")
            return
        path = unquote(url.path)
        if not path:
            self.report("warning" if has_alternative else "error", "empty-image", "图片 src 没有可用路径，请核对图片来源。")
            return
        if path.startswith("/"):
            if self.asset_root is None:
                self.report("warning", "root-image", "站点根路径图片需指定 --asset-root 或在实际预览中检查。")
                return
            image = self.asset_root / path.lstrip("/")
        else:
            image = self.source.parent / path
        if not image.is_file():
            if has_alternative:
                self.report("warning", "dynamic-image", f"本地 src 不存在，但可能使用替代来源，需预览检查：{path}")
            else:
                self.report("error", "missing-image", f"本地图片不存在：{path}")

    def handle_startendtag(self, tag, attrs):
        if tag in {"img", "base"}:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "picture":
            self.picture_depth = max(0, self.picture_depth - 1)
        if tag in {"script", "style", "pre", "code"}:
            self.skip_text = max(0, self.skip_text - 1)

    def handle_data(self, data):
        # Editorial markers can be quoted intentionally, so require human review.
        if not self.skip_text and re.search(r"\[\[TODO[^\]]*\]\]|【待补(?:图|充|写)[^】]*】", data):
            self.report("warning", "editorial-marker", "发现可能未完成的编辑标记，请结合上下文确认。")


def check(source, asset_root=None):
    if source.suffix.lower() not in {".html", ".htm"}:
        raise ValueError("仅支持本地 HTML；其他格式请使用对应编辑器复核。")
    content = source.read_text(encoding="utf-8")
    if not content.strip():
        return {"findings": [{"level": "error", "code": "empty-article", "line": 1,
                              "message": "文章为空。"}], "remote_images_unchecked": 0}
    parser = ArticleParser(source, asset_root)
    parser.feed(content)
    parser.close()
    return {"findings": parser.findings, "remote_images_unchecked": parser.remote_images}


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("article", type=Path)
    cli.add_argument("--asset-root", type=Path, help="站点根路径对应的本地目录")
    args = cli.parse_args()
    try:
        result = check(args.article, args.asset_root)
    except (OSError, UnicodeError, ValueError) as exc:
        print(json.dumps({"input_error": str(exc)}, ensure_ascii=False))
        return 2
    result["file"] = str(args.article)
    result["scope"] = "仅检查 HTML img 的基础路径和显式编辑标记；不验证远程资源、事实或版式。"
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return int(any(item["level"] == "error" for item in result["findings"]))


if __name__ == "__main__":
    raise SystemExit(main())
