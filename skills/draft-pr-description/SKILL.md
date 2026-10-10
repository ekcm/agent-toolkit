---
name: draft-pr-description
description: >
  Generate a pull request description by reading all commits and changed files
  on the current branch, then write a PR.md to the repository root ready to
  copy-paste into GitHub. Use this skill when the user invokes draft-pr-description by name
  or asks to "write a PR description", "draft my PR", "create PR.md",
  "write up this PR", "generate PR description", or any phrasing that indicates
  they want a pull request write-up based on the current branch's work.
  Automatically detects the base branch, reads every commit and every changed
  file, groups changes by functional area (backend, frontend, infra, tests,
  cleanup, etc.), writes a Context section with a before/after diagram when
  the change is architectural, and outputs structured Changes sections with
  file references. Overwrites any existing PR.md after warning. Does not
  commit, push, or open a PR.
---

# draft-pr-description

Generates a complete, copy-paste-ready GitHub PR description by reading the
branch's commits and diff, then writing PR.md at the repo root.

This skill is read-only except for writing PR.md. It does not commit, push,
open a PR, or modify any source files.

---

## Phase 0 — Environment check

Confirm the current directory is inside a git repository:

```bash
git rev-parse --show-toplevel
```

Store the repo root. PR.md will be written here.

If not a git repo, stop:
```
✗ Not a git repository. Cannot determine repo root for PR.md placement.
```

---

## Phase 1 — Check for existing PR.md

```bash
ls "$(git rev-parse --show-toplevel)/PR.md" 2>/dev/null
```

If PR.md already exists, warn before proceeding:

```
⚠️  PR.md already exists at <repo_root>/PR.md
    This will be overwritten. Proceeding...
```

Then overwrite. Do not ask a follow-up question.

---

## Phase 2 — Detect branch and base

```bash
# Current branch
git rev-parse --abbrev-ref HEAD

# Detect the most likely base branch (main or master or develop)
git branch -r | grep -E "origin/(main|master|develop)" | head -1
```

Determine the merge base — the point where this branch diverged from the
base:

```bash
git merge-base HEAD origin/main   # or origin/master / origin/develop
```

Store this as `MERGE_BASE`. All subsequent commit and diff queries use this
as the comparison point, not `HEAD~N`, to avoid including base-branch commits.

---

## Phase 3 — Read all commits on this branch

```bash
git log <MERGE_BASE>..HEAD --oneline
git log <MERGE_BASE>..HEAD --format="%H %s%n%b"
```

Read every commit message in full (subject + body). These are the raw
inputs for understanding the intent behind the changes. Do not skip merge
commits — their messages sometimes describe integration decisions.

Also count commits:

```bash
git rev-list --count <MERGE_BASE>..HEAD
```

---

## Phase 4 — Read the full diff and changed files

```bash
# Full stat summary
git diff <MERGE_BASE>..HEAD --stat

# List of all changed files
git diff <MERGE_BASE>..HEAD --name-only

# Full diff for context
git diff <MERGE_BASE>..HEAD
```

For large diffs (>800 lines), read the full file list and stat, but read
individual file diffs selectively — focus on files that carry the most
semantic weight (new files, significantly changed files, deleted files).

Also identify:
- **New files** (added): `git diff <MERGE_BASE>..HEAD --diff-filter=A --name-only`
- **Deleted files** (removed): `git diff <MERGE_BASE>..HEAD --diff-filter=D --name-only`
- **Modified files**: `git diff <MERGE_BASE>..HEAD --diff-filter=M --name-only`

---

## Phase 5 — Understand the codebase structure

Before grouping changes, orient in the repository:

```bash
find . -maxdepth 3 \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.venv/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/.next/*' \
  | sort
```

Read config files to understand the stack:

```bash
cat pyproject.toml 2>/dev/null
cat package.json 2>/dev/null
cat tsconfig.json 2>/dev/null
```

This determines how to label and group changes in the PR description.

---

## Phase 6 — Group changed files by functional area

Assign every changed file to exactly one functional group. Groups are
inferred from the repo structure — do not use a fixed list. Common groups
include but are not limited to:

- **Backend API / contracts** — route definitions, event types, models,
  serialisers, validators
- **Backend services / agents** — business logic, orchestration, service
  classes, agents
- **Frontend state / hooks** — reducers, hooks, stream processors, types
- **Frontend UI** — components, views, panels, layouts, renderers
- **Infrastructure / config** — Docker, CI, environment config, deployment
- **Tests** — anything under `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`
- **Cleanup / removal** — deleted files or files whose primary change is
  removing old code

For each group, collect:
- The group label (what to call this section)
- All files changed within the group, formatted as
  `filename.ext` (just the basename) with the full relative path in
  parentheses if needed for disambiguation
- The nature of the changes (what was added, modified, removed, and why)

---

## Phase 7 — Synthesise the Context section

The Context section explains **why** this PR exists and **what problem it
solves**, not just what files changed. It is written in plain prose and
optionally includes a before/after diagram when the change is architectural
or affects data flow.

### 7.1 Extract the "why" from commits and diff

Scan all commit messages and the diff for:
- The problem being solved or the feature being added
- The state of the system before this branch
- The state of the system after merging this branch
- Any significant architectural decisions or directional changes

### 7.2 Decide if a before/after diagram is warranted

Generate a before/after code-block diagram if ANY of the following apply:
- The PR changes how data flows between layers or components
- The PR replaces one rendering or processing path with another
- The PR introduces a new channel, pipeline, queue, or streaming mechanism
- The PR fundamentally changes how the backend and frontend communicate
- The PR restructures state management in a non-trivial way

If none apply (e.g., the PR is purely a bug fix or a small feature addition),
skip the diagram. A diagram of a trivial change adds noise.

### 7.3 Before/after diagram format

Use a plain `text` code block. Keep it within 80 characters per line.
Show the before state first, then the after state. Label each section.
Use `→` for flow direction. Indent sub-steps with spaces for readability.

Example structure (adapt to the actual change — do not copy this literally):

```text
Before
<component or system name>
  → <how data/events flowed or how things worked>
  → <what was absent or handled differently>

After
<component or system name>
  → <existing flow that stays the same>
  → <new path or mechanism>
        <sub-step>
        <sub-step>
  → <new downstream consumer or result>
```

The diagram must reflect the actual code, not a generic template.
Name the real components, services, hooks, and data structures.

---

## Phase 8 — Compose the Changes section

For each functional group (Phase 6), write a subsection with:

1. **A bold group header** followed by a parenthesised list of the primary
   files involved, formatted as:

   ```
   **Group label** (`file1.ext`, `file2.ext`, `file3.ext`)
   ```

   Use only the filename (basename) in the inline list. If two files in
   different directories share a name, use `dir/file.ext` for disambiguation.
   Do not list every file if there are more than ~6 — name the most
   significant ones and add "and N others" if needed.

2. **Bullet points** describing what changed, one bullet per logical change.
   Each bullet should:
   - State what was added, changed, or removed
   - Explain the purpose or effect in one sentence
   - Use sub-bullets for specific details when a top-level bullet covers
     multiple related items

### Bullet writing rules

- Write in present tense: "Add a...", "Extend...", "Replace...", "Remove..."
- Be specific — name the actual function, class, hook, event type, or
  component involved
- Do not write "Updated X" without saying what changed about X
- Do not pad with filler like "Various improvements to..."
- Sub-bullets should be indented with two spaces and use a dash (`-`)
- Keep each bullet focused: one change, one sentence, one sub-bullet list
  if needed

### Ordering of groups

Order groups from most foundational to most surface-level:
1. Contracts / schemas / types (things everything else depends on)
2. Backend services / agents
3. Frontend state / stream processing
4. Frontend UI
5. Infrastructure / config
6. Tests
7. Cleanup (always last)

---

## Phase 9 — Compose PR.md

Write the file using the exact structure below. Do not add extra sections.
Do not add a title heading — the PR title is set separately in GitHub.

```markdown
## Context
<3–6 bullet points or a short prose paragraph describing the problem this
PR solves, the motivation, and the high-level approach. Do not list files
here — this is the "why", not the "what".>

<If a before/after diagram is warranted (Phase 7.2), include it here as a
```text code block immediately after the prose, with a blank line separating
prose from the diagram.>

## Changes
<Group 1 header and bullets>

<Group 2 header and bullets>

<... repeat for all groups ...>
```

### Formatting rules for the file

- Use `##` for section headers only (`## Context`, `## Changes`)
- Use `**bold**` for group labels within Changes
- Use backticks for file names: `` `filename.ext` ``
- Use standard markdown bullets (`-`) for all lists
- No horizontal rules, no emoji, no extra headers
- Blank line between each group within Changes
- The file must be immediately copy-pasteable into a GitHub PR description
  field with no edits required

---

## Phase 10 — Write and confirm

Write PR.md to `<repo_root>/PR.md`.

Then print to terminal:

```
✅ PR.md written to <full_path>

Title suggestion: <a concise, imperative PR title derived from the commits
and context, e.g. "Add tree SSE channel and graph trace UI for deep research">

Groups: <comma-separated list of group names written>
Files changed: <total count>
Commits on branch: <count>

Copy PR.md into the GitHub PR description field.
```

---

## Edge cases

**Branch has no commits ahead of base**: Stop and output:
```
✗ No commits found ahead of <base_branch>.
  Are you on the right branch? Run: git log --oneline origin/<base>..HEAD
```

**Very large diff (>1000 lines)**: Read the file list and stat fully.
Read individual file diffs for new files, deleted files, and files with the
most additions. For heavily modified existing files, read the first 100 lines
of the diff to understand the nature of the change. Note in the PR.md
Changes section if any group is summarised at a higher level due to diff
size.

**Single-commit branch**: The PR description is still generated in full.
A single commit with a detailed message is sufficient input — do not
produce a shorter output just because there is one commit.

**No tests in the diff**: Omit the Tests group. Do not add a "Tests: none"
entry — the absence of the section communicates this already.

**No cleanup / deleted files**: Omit the Cleanup group.

**Ambiguous base branch** (both `main` and `master` exist, or neither does):
Use `git log --oneline -20` to inspect recent history and identify the most
likely base by finding where the branch diverged from a long-running branch.
State which base was used in the terminal confirmation output.

**PR.md write fails**: Print the full PR.md content to the terminal as a
fallback so nothing is lost.
