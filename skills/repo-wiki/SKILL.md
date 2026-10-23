---
name: repo-wiki
description: Build a private, interactive wiki for a code repository or one part of a monorepo - a ranked dependency map you can narrow to the most important code, traced request flows with sequence diagrams, key parts, change recipes, state machines, gotchas and a glossary, with every claim linked to file:line and checked against the code. Produces one self-contained HTML page kept outside the repository (in ~/.agent-toolkit/repo-wiki/), which can also be published as a hosted page with built-in questions over the source. Use when the user invokes repo-wiki, asks to map, document, visualise or explain a codebase for onboarding, wants a DeepWiki-style overview of a repo, says "help me understand this repo", or asks to refresh an existing repo wiki. Supports Java, Kotlin, Python, TypeScript/JavaScript, Go, Rust and Ruby. Never modifies, commits or pushes anything in the target repository.
---

# repo-wiki

Builds a wiki page for a codebase in four parts: scripts extract a code graph, the agent researches the code and writes the wiki text, a verifier checks every reference against the code, and a build step renders one HTML page.

The division of labour is the point. Scripts produce structure deterministically (what exists, what calls what, what is important). The agent writes only what needs judgement (what matters, how work flows, where it breaks), and the verifier rejects any reference to a file, line or node that does not exist. Do not skip the verifier and do not hand-edit the generated HTML.

`<skill-dir>` below means the absolute path of the folder that contains this `SKILL.md` (resolve it from where you loaded this file, for example `~/.agents/skills/repo-wiki`), and substitute it into every command.

## Rules

- **Never write inside the target repository.** All output goes in the workspace under `~/.agent-toolkit/repo-wiki/`. Only read-only git commands touch the repository.
- Never commit, push, or create anything on a remote.
- **Never modify this skill's own files during a run** (`SKILL.md`, `scripts/`, `assets/`, `references/`). If a script is slow, fails or gives poor results, work within the workspace (`config.json`, a narrower `--scope`, `--max-embed-kb`) or stop and tell the user. Write each problem you hit to `<workspace>/skill-issues.md` (what happened, the command, the output) so it can be fixed later as a separate task.
- Every fact in `wiki.json` must come from code you read in this session. If you cannot confirm something, leave it out.
- The scripts run in their own Python environment created by `setup.sh` under `~/.agent-toolkit/repo-wiki/.venv`. Do not install anything else.
- The page embeds source code from the repository. Secret-looking values are redacted and secret files (`.env`, keys, credentials) are left out, but tell the user the page contains source before they share it.
- Publish the page as a **private** hosted page automatically at the end of every run where the environment can (see Phase 7); the user does not want to be asked. Making it visible to anyone else (sharing, public links) is the user's step, never yours.
- Write every command with full paths: the interpreter's full path rather than a shell variable, and `<skill-dir>` resolved. Some agents' permission rules match the literal command, and a command they cannot match stops a background run at an approval prompt.

## How a run is organised

**Background mode** is the default wherever you can start a background helper agent that can itself start agents and send you messages. The user keeps working in this conversation while the wiki is built, and sees the run as an agent (with its research agents under it) instead of a stream of tool output.

You, in the conversation with the user (the **front**), do only this:

1. Work out the target (a local path, or a repository URL) and the workspace name from Phase 0 steps 1 to 3, without cloning, extracting or reading code.
2. Tell the user in one line that the wiki for `<name>` is being generated in the background, that they can keep working, and that the page will be published when it is done.
3. Start one background agent, described as `Generating wiki for <name>`, with the brief in `references/lead-brief.md` filled in. It does Phases 0 to 6.
4. Do not watch it, poll it or read its files. If it sends you a question, ask the user in the conversation in a sentence or two, and send the answer back to it. Answer anything you can from the conversation yourself without bothering the user.
5. When it finishes, do Phase 7 (publish and report) from its report, straight away.

**Foreground mode**, where background agents are not available: do every phase yourself in the conversation, as written below.

The **lead** (the background agent, or you in foreground mode) runs Phases 0 to 6. It manages the run on its own: it plans the areas, launches and re-briefs research agents, has their work checked, re-runs failed steps and logs skill problems. It asks the user (through the front) only for a decision that is genuinely theirs, such as which part of a very large monorepo to cover, never for something it can find out or decide.

## Phase 0: Target, scope and workspace

1. Find the repository root: `git -C <path> rev-parse --show-toplevel`. If the path is not in a git repository, stop and say so. For a repository URL, work on a clone in `~/.agent-toolkit/repo-wiki/.sources/<repo-name>`: `git clone --filter=blob:none <url> ~/.agent-toolkit/repo-wiki/.sources/<repo-name>` the first time (full history, file contents fetched as needed); afterwards `git -C <clone> fetch --quiet origin` and `git -C <clone> checkout --detach --quiet origin/HEAD`. Never clone into, or run a git command that changes, a checkout the user works in.
2. Decide the scope:
   - The user named a folder, service or package: use it as `--scope <path relative to root>`.
   - Otherwise cover the whole repository. If the extract in Phase 2 reports more than about 1,500 units or more than 8 components, still build the whole-repository graph, but write flows and key parts in depth only for the two or three components that matter most, and tell the user they can ask for a scoped wiki of any other component.
3. Workspace: `~/.agent-toolkit/repo-wiki/<repo-folder-name>` for a whole repository, or `~/.agent-toolkit/repo-wiki/<repo-folder-name>--<scope with / replaced by ->` for a scope.
4. If the workspace already has `manifest.json` and `wiki.json`, this is a **refresh**: follow "Refreshing" at the end instead of starting over.

## Phase 1: Setup

```sh
PY="$(sh <skill-dir>/scripts/setup.sh | tail -n 1)"
```

The first run creates the environment and installs tree-sitter (it needs network access once). Later runs print the path immediately. If it fails, show the user the error and stop. Below, `"$PY"` stands for the printed path; write that full path in each command (see Rules).

## Phase 2: Extract

```sh
"$PY" -I <skill-dir>/scripts/extract.py --repo <root> --out <workspace> [--scope <path>]
```

Parsing runs in parallel on large repositories (one process per usable CPU core, at most 8); `--workers 1` forces a serial run, which is the way to find a file that crashes a parser.

Read the report it prints. It lists languages, components, feature groups (with cohesion), detected infrastructure (databases, caches, brokers, object storage, search, identity provider, each with the config line that proves it), entry points, the top 30 units by importance, units nothing references, unresolved call names, and how many secret-looking values were redacted.

The extract reads the working tree as it is, including uncommitted changes (the page marks this). If the tracked files change while you work (an edit, a stash, a checkout), `verify.py` fails and asks you to extract again. Do that rather than working around it.

Check the classification before going further. If units are clearly in the wrong layer (for example a repository shown as `logic`, or a whole folder of handlers shown as `util`), or the feature groups do not match how the team thinks about the system (one huge group, or a concept split across several), write `<workspace>/config.json` and re-run the extract:

```json
{
  "exclude": ["scripts/**", "**/fixtures/**"],
  "layers": [
    {"match": "/adapters/http/", "layer": "client"},
    {"match": "Facade$", "layer": "service"}
  ],
  "groups": [
    {"match": "/(cache|redis)/", "group": "caching"}
  ]
}
```

`match` is a regular expression tested against the file path and the node id; the first matching rule wins. Groups default to the feature package below the component's source root (one level deeper for very large packages). Layers: `entry`, `interface`, `job`, `ui`, `service`, `logic`, `client`, `data`, `table`, `external`, `mapper`, `model`, `config`, `util`.

Use the query helper throughout the research:

```sh
"$PY" -I <skill-dir>/scripts/query.py <workspace> entries
"$PY" -I <skill-dir>/scripts/query.py <workspace> top 30
"$PY" -I <skill-dir>/scripts/query.py <workspace> node <id-or-name>
"$PY" -I <skill-dir>/scripts/query.py <workspace> callees <Unit>.<method>
"$PY" -I <skill-dir>/scripts/query.py <workspace> callers <Unit>.<method>
"$PY" -I <skill-dir>/scripts/query.py <workspace> path <from> <to>
"$PY" -I <skill-dir>/scripts/query.py <workspace> search <text>
"$PY" -I <skill-dir>/scripts/query.py <workspace> orphans
"$PY" -I <skill-dir>/scripts/query.py <workspace> groups
"$PY" -I <skill-dir>/scripts/query.py <workspace> infra
"$PY" -I <skill-dir>/scripts/query.py <workspace> brief <group-id or folder>
```

Call edges are resolved by name, imports and field types. Direct calls between units and calls within a unit (`this.x()`, `self.x()`) are recorded; dynamic dispatch, reflection, decorators that route work elsewhere, task queues (`.delay()`, `.send()`), dependency injection by interface (partly covered by `dispatch` edges) and anything in libraries are not. Treat `callees` and `callers` as leads, and open the source to confirm every step before writing it.

## Phase 3: Choose single or parallel mode

- **Parallel mode** (the default) when you can run several helper agents at once (sub-agents, or more processes of your own agent CLI) and the extract reports more than about 80 units. Research is split into areas researched at the same time, and you write the parts that span areas while they work. It roughly halves the time on a medium repository.
- **Single mode** otherwise: you research and write everything yourself.

Both produce the same `wiki.json` and go through the same verifier.

## Phase 4a: Single mode

Follow `references/writing-guide.md`: entry points, then the main flows traced call by call, then state, then the top units, noting gotchas and tests as you go. Read the actual source for every claim. Then write `<workspace>/wiki.json` in the format in `references/wiki-format.md`: title, overview, groups (what each main feature group is for), components (for monorepos), key parts, flows, recipes, state machines, gotchas, glossary, summaries, extras (external systems and other things static analysis cannot see) and Ask starters. Put an `expect` on every key part and gotcha: a short piece of text that must appear within three lines of the ref, which is what lets a later refresh catch references that drifted.

## Phase 4b: Parallel mode

1. **Plan the areas.** From `query.py <workspace> groups`, split the code into 4-6 areas of about 40 units or fewer each, following the feature groups: combine small related groups, and split a big group by sub-folder (an agent core into "supervisor and planning" and "orchestrator, sub-agents and tools", for example). Smaller areas finish faster; the slowest area sets the pace. Give each area a short lowercase slug.
2. **Brief and launch every area at once.** For each area, run `query.py <workspace> brief <group-id or folder>` and fill the template in `references/research-brief.md` with its output, the area, its slug and the paths. Write all the briefs first, then start every research agent in a single step (one message with all the launches, in the background), not one after another: each launch takes seconds, and no area should wait for another to be launched. Describe each agent as `Research <slug>`. If you can pick their model, use a fast one (for example Sonnet) for areas that are mostly plumbing (CRUD, configuration, UI glue, persistence) and keep the strongest for the core logic, where the subtle bugs are.
3. **Write the base while they work.** Each agent writes `<workspace>/wiki.d/<slug>.json` and checks it with `verify.py --fragment`. Meanwhile write `<workspace>/wiki.base.json` yourself: `title`, `overview`, `groups` (labels and bodies), `components`, `glossary` for terms that span areas, `extras` for infrastructure and external services the extractor missed (each with a ref), `starters`, and `uncoveredEntries`, and check it with `verify.py <workspace> --base`. Do not wait idle.
4. **Have each fragment checked as it arrives.** When a research agent finishes, read its short reply, then start a checker agent (described as `Check <slug>`, on a fast model where you can choose) on its fragment in the background with the brief in `references/checker-brief.md`. The checker did not write the fragment and is told nothing of what you think of it: it re-reads the code behind every gotcha, flow step and state machine, corrects or deletes what does not hold, and verifies the fragment again. Carry on with your own work meanwhile. If a research agent fails or its fragment cannot pass the verifier, brief a new agent for that area (with what went wrong) rather than writing the area yourself. Where you cannot start more agents, spot-check the most serious claims, the bugs and risks above all, yourself.
5. **Stitch, then have the base checked.** Once every fragment is in, add to `wiki.base.json` the one or two end-to-end flows that cross areas (a request from the UI through the API into the core, for example), built from the steps the fragments found, plus summaries the verifier will ask for. Then start one more checker, described as `Check base`, on `wiki.base.json` with the same brief: the overview, group descriptions, extras and cross-area flows are claims like any other. Wait for every checker to report before merging, and read what each changed: a claim a checker deleted must not come back through the base.
6. **Merge.**

   ```sh
   "$PY" -I <skill-dir>/scripts/merge.py <workspace>
   ```

   It writes `wiki.json` from the base plus the fragments. When two sources describe the same thing the first wins (the base, then fragments by name) and the report lists what was dropped; read it, since a dropped item can be the better one. Two different flows, recipes or state machines with the same id stop the merge: rename one in its fragment and merge again.

## Phase 5: Verify

```sh
"$PY" -I <skill-dir>/scripts/verify.py <workspace>
```

Fix every error and run it again until it passes. Errors are untracked or missing files, lines out of range, `expect` text not found, unknown node ids, malformed sections, and a repository that changed since the extract. Then deal with the warnings that matter: add summaries for the important units it lists, and add flows for groups of uncovered entry points. For entry points you deliberately leave out (health checks, metrics, duplicate legacy routes), list them in `uncoveredEntries` and say why in the overview.

## Phase 6: Build

```sh
"$PY" -I <skill-dir>/scripts/build.py <workspace>
```

It verifies again, then writes `<workspace>/repo-wiki.html`: one HTML file with all data inline, under 15 MB. It fetches only the graph library (cdnjs) and fonts (Google Fonts); without network the map is replaced by a notice and everything else still works. If the page is too large, re-run the extract with `--max-embed-kb 1500` or a narrower `--scope`.

Optionally, open the page in a headless browser and take one screenshot to check it renders. Do not loop on visual polish; the template is fixed.

## Phase 7: Deliver

In background mode the front does this phase, as soon as the lead reports; publishing from the conversation with the user is what makes the page appear for them straight away.

- **If you can publish an HTML file as a private hosted page:** publish `repo-wiki.html` right away, without asking, as the last step of every run (first build and refresh alike), so the page appears for the user as soon as it is built. It must be private to the user; never share it or make it public. The Ask tab works only on hosts that give pages a `sample` capability through `window.claude.use("sample")`; where that exists, declare `sample` and nothing else, and mention in your report that asking sends the viewer's question and the source the model reads to that host's model. If `manifest.json` already has an `artifactUrl`, update that page instead of creating a new one; if the host says that page was deleted, publish a new one instead (the user removed the old one on purpose) and record the new URL. Then record the URL:

  ```sh
  "$PY" -I <skill-dir>/scripts/build.py <workspace> --set-url <url>
  ```

- **Otherwise:** give the user the full path of `repo-wiki.html` to open in a browser. Everything works locally except the Ask tab, which needs the hosted page.

Report back in a few lines: the link to the published page (or the local path if you could not publish), what it covers in depth, the most important gotchas you found (one line each, with `file:line`), any verifier warnings you chose to leave, and how to refresh. Remind the user the page embeds source code.

## Refreshing

When the repository has moved on:

1. Re-run the extract with the same arguments. Its report ends with what changed since the last extract: nodes added and removed, and how many files changed.
2. Run `verify.py`. Broken refs and failed `expect` checks show exactly which parts of the wiki are stale.
3. Re-read the changed code and update only the affected sections. If the workspace has `wiki.base.json` and `wiki.d/` (a parallel-mode build), edit those and run `merge.py` again; editing `wiki.json` directly would be overwritten by the next merge. Check the new top units and entry points for missing summaries and flows.
4. Verify, build, and publish to the same URL from `manifest.json`.

## Files

| Path | Purpose |
|---|---|
| `scripts/setup.sh` | Creates the Python environment with tree-sitter and prints its interpreter |
| `scripts/extract.py` | Parses the repository into `graph.json` (units, entry points, tables, components, edges, call sites, tests, git history, importance scores) and `sources.json` |
| `scripts/query.py` | Research helper over `graph.json`; `brief <area>` prints an area's structure for a research brief |
| `scripts/verify.py` | Checks `wiki.json` (or, with `--fragment`, one research fragment; with `--base`, the lead's `wiki.base.json`) against the graph and the repository |
| `scripts/merge.py` | Merges `wiki.base.json` and the fragments in `wiki.d/` into `wiki.json` |
| `scripts/build.py` | Verifies, then renders `repo-wiki.html`; records the published URL |
| `assets/template.html` | The page: architecture view (entry points, feature groups with coupling metrics, infrastructure with icons), grouped code map, flows and sequence diagrams, key parts, recipes, state machines, gotchas, glossary, source viewer, Ask tab |
| `references/wiki-format.md` | The `wiki.json` format |
| `references/writing-guide.md` | How to research and write each section |
| `references/lead-brief.md` | The brief for the background agent that runs Phases 0 to 6 |
| `references/research-brief.md` | The brief template for research agents in parallel mode |
| `references/checker-brief.md` | The brief for the agents that check a research fragment, or the lead's base, against the code |
