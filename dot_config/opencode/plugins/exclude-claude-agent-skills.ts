import { Plugin } from "@opencode/plugin"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Keep skills from ~/.config/opencode/skills, project .opencode/skills, and project .agents/skills.
// Drop every .claude/skills (global + project) and the global ~/.agents/skills.
// ctx.skill.transform cannot see file-discovered skills on this build, so the
// advertised list is filtered out of the assembled system prompt instead.
// shortcut: matches the "<available_skills>" text block; update if that format changes.

const home = homedir()

function collect(dir: string, into: Set<string>) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue
    into.add(name.endsWith(".md") ? name.slice(0, -3) : name)
  }
}

export default Plugin.define({
  id: "exclude-claude-agent-skills",
  async setup(ctx) {
    const dropped = new Set<string>()
    collect(join(home, ".claude", "skills"), dropped)
    collect(join(home, ".agents", "skills"), dropped)

    // An ID that also exists in a kept source (e.g. a project override) stays.
    const kept = new Set<string>()
    collect(join(home, ".config", "opencode", "skills"), kept)
    let d = ctx.location.directory
    for (;;) {
      collect(join(d, ".opencode", "skills"), kept)
      if (d !== home) collect(join(d, ".agents", "skills"), kept)
      const parent = dirname(d)
      if (d === home || parent === d) break
      d = parent
    }
    for (const id of kept) dropped.delete(id)

    // Try to drop them from the registry too (TUI /skills catalog), not just the prompt.
    await ctx.skill.transform((editor) => {
      for (const id of dropped) editor.remove(id)
    })

    await ctx.session.hook("context", (event) => {
      for (let i = 0; i < event.system.length; i++) {
        const block = event.system[i]
        if (block.type !== "text" || !block.text.includes("<available_skills>")) continue
        const text = block.text.replace(/[ \t]*<skill>\s*<id>([^<]*)<\/id>[\s\S]*?<\/skill>\r?\n/g, (m, id) =>
          dropped.has(id) ? "" : m,
        )
        if (text !== block.text) event.system[i] = { ...block, text }
      }
    })
  },
})
