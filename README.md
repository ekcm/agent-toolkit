# agent-toolkit

Shared skills, mods and plugins for coding agents — Claude Code, Codex, pi, and anything else that reads the [Agent Skills](https://agentskills.io) format.

## Install

```sh
git clone https://github.com/ekcm/agent-toolkit.git ~/Documents/GitHub/agent-toolkit
cd ~/Documents/GitHub/agent-toolkit
./install.sh --dry-run   # preview
./install.sh
```

Then restart any running agents so they pick up the skills.

`install.sh` symlinks each folder in `skills/` into the user-level skill folder of every supported agent, so this repo stays the only copy:


| Folder                    | Read by                                           |
| ------------------------- | ------------------------------------------------- |
| `~/.agents/skills/<name>` | Codex, pi, and other Agent Skills tools           |
| `~/.claude/skills/<name>` | Claude Code (it does not read `~/.agents/skills`) |


It also:

- **Backs up instead of deleting.** Anything already at a target path is moved to `~/.agent-toolkit-backups/<timestamp>/`.
- **Removes old copies from** `~/.codex/skills`**.** Codex still reads that legacy folder as well as `~/.agents/skills`, so a copy left there makes each skill appear twice.
- **Links skill by skill**, never replacing a whole folder, so skills installed by other tools (e.g. `npx skills`) are left alone.
- **Is safe to re-run.** Links that are already correct are left as they are.

Don't also link skills into `~/.pi/agent/skills`: pi already reads `~/.agents/skills` and warns about duplicate names.

### Updating

Edits to a skill take effect immediately, since the agents read it through the symlink — just restart the agent. After adding, removing or renaming a skill, run `./install.sh` again. If the repo moves, run it again from the new location.

### Uninstalling

```sh
./install.sh --uninstall
```

This removes only the symlinks that point into this repo. Backups stay in `~/.agent-toolkit-backups/`; move a folder back from there to restore it.

The target folders can be overridden with `AGENTS_SKILLS_DIR`, `CLAUDE_SKILLS_DIR`, `CODEX_HOME` and `AGENT_TOOLKIT_BACKUP_DIR`.

## Skills

Each folder in `skills/` is a standard `SKILL.md` skill: frontmatter with only `name` and `description`, and plain instructions with no agent-specific tools.


| Skill                             | What it does                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `code-review-uncommitted-changes` | Strict review of uncommitted changes                                          |
| `verify-review`                   | Second-pass check that a prior review was implemented, plus a regression scan |
| `review-pull-request`             | Deep review of a GitHub PR via `gh`                                           |
| `retrieve-pull-request-comments`  | Fetch and summarise review comments on the current branch's PR                |
| `draft-pr-description`            | Write `PR.md` from the branch's commits and changes                           |
| `handover-session-notes`          | Save session context to `NOTES.md` for the next session                       |


Invoke a skill by name — `/name` in Claude Code, `$name` in Codex

