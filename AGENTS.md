# AGENTS.md

Instructions for any coding agent (Claude Code, Codex, pi, or others) working in this repo. Read `README.md` for the user-facing overview.

## What this repo is

The single source of the user's shared agent tooling: skills now, with Claude Code mods and plugins to come. Installed copies are symlinks back into this repo, so a change here reaches every agent on the machine.

## Layout

```
skills/<name>/SKILL.md   one skill per folder (Agent Skills format)
install.sh               links each skill into ~/.agents/skills and ~/.claude/skills
README.md                install and usage docs for humans
```

Planned, not yet created: `standards/` (shared review rubric and findings schema) and `mods/` (Claude Code mods, starting with a PR review board).

## Rules

- Edit skills in `skills/`, never through the installed links in `~/.agents/skills` or `~/.claude/skills`. Never copy a skill into those folders by hand.
- Run `./install.sh` after adding, removing or renaming a skill. Use `./install.sh --dry-run` first when the change affects existing installs.
- Keep everything agent-neutral. Say "the agent", not a product name, and don't assume one agent's invocation syntax (`/name`, `$name`, `/skill:name`). Claude Code mods under `mods/` are the only Claude-specific content.
- Never commit `NOTES.md`. It is a local session-handover file and is excluded through `.git/info/exclude`.
- Don't push, open pull requests, or create anything on GitHub without asking the user first.
- Write Markdown prose one line per paragraph or list item. Don't hard-wrap.

## Skill conventions

Every skill must work in every agent that reads the [Agent Skills](https://agentskills.io) format:

- The folder name and the `name` field match, using only lowercase letters, digits and single hyphens, at most 64 characters.
- The frontmatter holds only `name` and `description`. Agent-specific fields such as `disable-model-invocation` or `allowed-tools` are not allowed.
- `description` is at most 1024 characters and says both what the skill does and when to use it, since agents pick skills by their descriptions.
- The body uses plain instructions and shell commands, not one agent's tool names.
- A skill adapted from another repo keeps a credit line to its source and that source's licence notice.

## Checking a change

- Codex: `codex debug prompt-input hi` prints what the model would see, without calling the model. Grep it for the skill's name and check that the skill appears once. Paths are shortened to aliases such as `r1/<name>/SKILL.md`; the "Skill roots" list in the same output maps each alias to a folder, and ours should map to `~/.agents/skills`.
- Claude Code: the skill appears in `/skills` after a restart, or immediately in an open session once the link exists.
- pi: start a new session; pi warns on invalid names and on duplicates.
