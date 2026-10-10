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


Invoke a skill by name — `/name` in Claude Code, `$name` in Codex.

## Claude Code mods

[Mods](https://www.claudemod.com/) change Claude Code itself (panels, commands, hooks), so unlike the skills they work in Claude Code only. Each lives in `mods/<name>/`, and this repo is a plugin marketplace that lists them.

### pr-review-board

Reviews several PRs at once with Claude and Codex side by side, in a live panel. For each PR it runs both reviewers independently, combines their findings, runs the PR's install, tests and build, then has the two agents debate whatever they disagree on, and shows what both agree on, what was confirmed, withdrawn or still disputed, colour-coded by severity and tagged by source.

![The PR review panel reviewing two PRs: each reviewer's live activity, verification results and a debate in progress](docs/pr-review-board-panel.png)

Install it in Claude Code:

```
/plugin install pr-review-board --marketplace ekcm/agent-toolkit
```

Or install from your local clone:

```
claude plugin marketplace add ~/Documents/GitHub/agent-toolkit
/plugin install pr-review-board@agent-toolkit
```

An install runs from a cached copy of the mod, so editing the clone changes nothing until you bump `version` in its `plugin.json`, run `claude plugin marketplace update agent-toolkit` and `claude plugin update pr-review-board@agent-toolkit`, and restart Claude Code. While working on the mod, start Claude Code with `claude --plugin-dir ~/Documents/GitHub/agent-toolkit/mods/pr-review-board` instead: it loads the clone directly, and `/reload-plugins` picks up edits.

It needs `gh` logged in, the `claude` and `codex` CLIs on your `PATH`, and the `review-pull-request` skill installed with `./install.sh`.


| Command                            | What it does                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `/review-prs ~/path/to/repo 19 22` | Review PRs 19 and 22 of that repo (inside the repo, `/review-prs 19 22` is enough) |
| `/review-prs`                      | Open the panel                                                                     |
| `/review-prs trust owner/repo`     | Let PRs of a repo you don't own run their install, tests and build                 |
| `/review-prs untrust owner/repo`   | Undo that; `/review-prs trust` lists the approved repos                            |


Using the panel:

- Press ctrl+x tab to focus the panel, then a PR's number key to open its results (or click its title). Inside a PR, `1` shows the combined result, `2` Claude's review and `3` Codex's; `b` goes back.
- `x` (or `close`) closes the panel. Reviews keep running while it is closed, and `/review-prs` opens it again.
- Each row has `cancel` and `retry` per reviewer, `recombine` to redo the combine, verify and debate from the saved reviews, and `remove` to drop a finished review from the panel (its files stay).
- A PR number the repo doesn't have is reported in the command's reply and not added. Running a PR again after it finished starts a fresh review and overwrites its saved results.

What it touches:

- Each PR is checked out as a detached worktree at `~/.agent-toolkit/pr-reviews/<repo>/pr-<n>/worktree`, fetched into `refs/pr-review/<n>` of your local clone. Your own checkout and uncommitted changes are left alone.
- Both reviewers and the debate are read-only. Verification runs the PR's code, so it runs only for your own repos or ones you approved, and never for a branch from someone else's fork.
- Reviews, logs and the combined result (`reconciled.md`) are saved in `~/.agent-toolkit/pr-reviews/<repo>/pr-<n>/`, next to the worktree. To remove a review's worktree and ref:

```sh
git -C <repo> worktree remove --force ~/.agent-toolkit/pr-reviews/<repo>/pr-<n>/worktree
git -C <repo> update-ref -d refs/pr-review/<n>
```

