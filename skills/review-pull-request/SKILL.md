---
name: review-pull-request
description: >
  Perform a deep, senior-engineer-level review of a GitHub Pull Request
  entirely within the terminal using the GitHub CLI (gh). Use this skill when
  the user asks to "review a PR", "review pull request", "review my PR",
  "check this PR", "analyse PR #N", "/review-pull-request", or any phrasing
  that references reviewing a GitHub pull request — with or without a PR
  number. If no PR number or URL is given, automatically detect and review
  the PR associated with the current branch. This skill fetches the full diff
  and complete file contents, reads surrounding codebase context, actively
  hunts for duplicated logic across the entire repo, checks all 11 review
  dimensions (correctness, smells, naming, duplication, architecture, API
  design, error handling, testing, performance, security, documentation),
  and generates a structured severity-tiered terminal report with exact
  file:line citations for every finding. For complex PRs it also generates
  ASCII diagrams. It does not soften criticism. It does not manufacture praise.
---

# review-pull-request

A rigorous, self-contained pull request review executed entirely in the
terminal using the GitHub CLI. This skill retrieves the PR metadata and diff,
reads every changed file in full, reconstructs codebase context, hunts for
duplicated logic, and produces a severity-tiered report with file:line
precision. For structurally complex PRs it generates ASCII diagrams so the
reader can orient themselves before reviewing the findings.

No issue is too small to flag. No severity is softened. No praise is
manufactured. Every finding carries a file path, line number, root cause, and
a concrete fix.

---

## Phase 0 — Environment check

Before anything else, verify the GitHub CLI is available and authenticated:

```bash
gh --version
gh auth status
```

If `gh` is not installed: stop and inform the user — "The GitHub CLI is
required. Install it from https://cli.github.com and run `gh auth login`."

If `gh` is installed but not authenticated: stop and inform the user —
"Run `gh auth login` to authenticate before using this skill."

Also confirm the current directory is inside a git repository:

```bash
git rev-parse --show-toplevel
```

If it is not a git repo, stop and inform the user.

---

## Phase 1 — Identify the PR

### If the user provides a PR number or URL

Extract the PR number. Accept any of these formats:
- `142` — bare number
- `#142` — hash-prefixed
- `https://github.com/owner/repo/pull/142` — full URL (parse the number)
- `owner/repo#142` — cross-repo reference (use that repo, not the detected one)

Detect the current repository:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

### If the user provides NO PR number or URL

Automatically detect the PR for the current branch. Do not ask the user —
resolve it silently:

```bash
# Get the current branch name
git rev-parse --abbrev-ref HEAD

# Find the PR associated with this branch
gh pr view --json number,title,url,state \
  -q '"PR #\(.number): \(.title) [\(.state)] \(.url)"'
```

If a PR is found, proceed with it and state in the output header which PR was
auto-detected.

If no PR is found for the current branch, try finding the most recent open PR
in the repo as a fallback:

```bash
gh pr list --state open --limit 5 \
  --json number,title,headRefName,author \
  -q '.[] | "#\(.number) \(.headRefName) — \(.title) by \(.author.login)"'
```

If multiple open PRs exist and none match the current branch, ask the user
which one to review and list the options. Do not guess.

If no open PRs exist at all, inform the user.

---

## Phase 2 — Fetch PR metadata

```bash
gh pr view <PR_NUMBER> --json \
  number,title,body,author,baseRefName,headRefName,\
  additions,deletions,changedFiles,commits,labels,\
  milestone,reviewRequests,state,isDraft,createdAt,\
  reviewDecision
```

Record and retain:
- **Title** — claimed purpose of the PR
- **Body / description** — what the author says this PR does; cross-check this
  against what the code actually does later
- **Base branch** (`baseRefName`) — what this merges into
- **Head branch** (`headRefName`) — what this merges from
- **Author** — for context only, not for leniency
- **State** — open, merged, draft, closed
- **isDraft** — note in header if true; still review fully
- **Additions / deletions / changedFiles** — used to calibrate review depth
- **Commit count** — a high commit count on a tightly scoped PR is a smell
- **Labels / milestone** — may signal urgency, release-blocking status, etc.
- **reviewDecision** — note if already approved; review independently regardless

---

## Phase 3 — Fetch the full diff

```bash
gh pr diff <PR_NUMBER>
```

Get the changed file list with per-file stats:

```bash
gh pr diff <PR_NUMBER> --name-only
```

Get a stat summary for large PR triage:

```bash
gh pr diff <PR_NUMBER> --stat
```

Determine review depth:
- **Small PR** (≤200 lines): full line-by-line review of every file
- **Medium PR** (201–600 lines): full review, call out if any file warrants
  extra attention
- **Large PR** (>600 lines): state upfront that scope is large; prioritise
  high-risk files (auth, error handling, new abstractions, DB queries);
  recommend the author split future PRs; do not skip duplication scan

---

## Phase 4 — Read every changed file in full

Do not review diff hunks in isolation. The surrounding code — unchanged lines,
neighbouring functions, module-level imports, class structure — determines
whether a change is correct, consistent, and non-duplicative.

For each file in the diff, read the full head-branch version:

```bash
# If the branch is checked out locally (preferred):
git show origin/<HEAD_BRANCH>:<FILE_PATH>

# If not checked out locally, use the API:
gh api "repos/{owner}/{repo}/contents/<FILE_PATH>?ref=<HEAD_BRANCH>" \
  -q '.content' | base64 --decode
```

Also read the base-branch version for files where understanding what was
there before is important for assessing the change:

```bash
git show origin/<BASE_BRANCH>:<FILE_PATH>
# or
gh api "repos/{owner}/{repo}/contents/<FILE_PATH>?ref=<BASE_BRANCH>" \
  -q '.content' | base64 --decode
```

New files (additions): read the full file from the head branch.
Deleted files (deletions): note them — confirm deletion is intentional and
that no other file still imports or depends on the deleted path.

---

## Phase 5 — Reconstruct codebase context

Orient fully in the repository before forming any judgement. This step is
what separates a diff-level skim from a real review.

```bash
# Repository structure (top 3 levels, excluding noise)
find . -maxdepth 3 \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.venv/*' \
  -not -path '*/venv/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/.next/*' \
  -not -path '*/coverage/*' \
  | sort
```

Read whichever of the following exist — they define the conventions the PR
must conform to:

```bash
cat pyproject.toml 2>/dev/null    # Python: deps, linting, tooling config
cat setup.cfg 2>/dev/null         # Python: legacy config
cat package.json 2>/dev/null      # JS/TS: deps, scripts, engines
cat tsconfig.json 2>/dev/null     # TypeScript: strictness settings
cat .eslintrc* 2>/dev/null        # JS/TS linting rules
cat ruff.toml 2>/dev/null         # Python linting rules
cat .flake8 2>/dev/null           # Python linting rules (legacy)
cat Makefile 2>/dev/null          # Workflow scripts and naming conventions
cat justfile 2>/dev/null          # Workflow scripts
```

For each changed file, read at minimum:
- The directory it lives in (`ls -la <dir>/`)
- The sibling files in that directory (to understand what belongs there)
- Any `__init__.py`, `index.ts`, or barrel files that control what is exported
- The primary module or service that imports or depends on the changed file

This context answers: does the changed code belong here, and does it follow
the patterns established by everything around it?

---

## Phase 6 — Detect duplicated logic

This step is mandatory and must not be skipped, even for small PRs.
Fast-moving codebases accumulate duplicated logic. The PR author and the
AI agent that wrote the code both have limited visibility into the full
codebase. You do not.

For every substantive function, class, utility, constant, or logic block
introduced or modified in the PR, run targeted searches:

```bash
# Search by the exact name introduced
grep -rn "def <function_name>" --include="*.py" .
grep -rn "class <ClassName>" --include="*.py" --include="*.ts" .
grep -rn "const <name>\|function <name>\|export function <name>" \
  --include="*.ts" --include="*.js" .

# Search by distinctive logic pattern or operation
grep -rn "<distinctive_keyword_or_expression>" \
  --include="*.py" --include="*.ts" --include="*.js" .

# Search for similar error handling patterns
grep -rn "<exception_name>\|<error_string_fragment>" \
  --include="*.py" --include="*.ts" .
```

Flag any of the following without exception:
- A function re-implemented that already exists in a utils / helpers / lib
  module
- Logic copy-pasted from another part of the codebase with minor variation
  (should be parameterised into the existing function)
- A data transformation or validation pattern that already exists in a shared
  module elsewhere
- Standard library or framework functionality being manually re-implemented
  (e.g., manual retry loops where a decorator or middleware exists, manual
  pagination where a utility already handles it)
- Constants or configuration values defined a second time rather than imported
  from their canonical source

Every duplication finding is **Major** or **Critical** — never Minor.
Duplication is not a style issue. It is a maintenance liability that compounds
with every future change.

---

## Phase 7 — Assess complexity and diagram need

Evaluate whether the PR warrants one or more ASCII diagrams. Generate a
diagram if any of the following apply:

- The PR introduces or modifies a multi-step request/response lifecycle
- Retry logic, timeouts, or failure handling branches at multiple levels
- A task queue, background job, or async pipeline is introduced or changed
- New relationships between services, components, or modules are established
- Data flows through multiple layers in a non-obvious sequence
- Concurrency, locking, or async patterns are introduced or changed
- The PR description itself describes a complex interaction or state machine
- New API endpoints with non-trivial middleware or handler chains are added

If none apply, skip diagram generation.

If diagrams are warranted, generate them **before** the findings in the final
report so the reader can build a mental model first. See Phase 9 for diagram
format rules.

---

## Phase 8 — Perform the full review

Evaluate every changed file against all of the following dimensions. Be
exhaustive. Do not skip a dimension because the code "looks mostly fine."
Do not batch multiple files together — assess each file individually.

### 8.1 Correctness

Flag every instance of:
- Logic errors, wrong conditionals, inverted boolean checks
- Off-by-one errors in loops, slices, pagination, or index access
- Missing edge case handling: null/None, empty collections, zero, negative
  values, empty strings, missing keys
- Race conditions or concurrency hazards: shared mutable state accessed from
  multiple threads/tasks without appropriate locking
- Incorrect error handling: exceptions caught at the wrong layer, wrong
  exception type caught, exception message discarded, bare re-raise losing
  context
- Wrong return types or functions that return None implicitly where a value
  is expected
- Incorrect assumptions about the shape or type of inputs from callers
- State mutations that produce incorrect results under concurrent access or
  repeated calls

### 8.2 Code Smells

Flag every instance of:
- **Long functions** — a function doing more than one well-defined thing;
  if you need to describe what it does with "and", it should be split
- **Deep nesting** — more than 2–3 levels of indented logic; use early
  returns to flatten
- **God objects / classes** — a class with too many responsibilities; if
  its methods span more than one domain concept, it should be split
- **Primitive obsession** — raw strings or integers used where a typed
  model, enum, or dataclass belongs
- **Magic numbers / strings** — unexplained numeric or string literals
  inline rather than named constants
- **Feature envy** — a function that works predominantly on data from
  another class or module, suggesting it belongs there instead
- **Dead code** — unreachable branches, permanently commented-out blocks,
  unused imports, unused variables, unused function parameters
- **Side effects in wrong places** — state mutation inside a function named
  as a query or predicate
- **Overly defensive guards** — null checks or fallback branches that can
  never be reached given the caller contract
- **Shotgun surgery** — a single logical change scattered across many
  unrelated files, signalling a missing abstraction layer
- **Inappropriate intimacy** — a module directly accessing internals of
  another module rather than going through its public interface
- **Unnecessary abstraction** — an abstraction layer added that serves no
  current purpose and adds indirection without benefit

### 8.3 Naming

Apply strict standards — no exceptions for expediency:

- Variable names must be descriptive and unambiguous. Single-letter names
  are only acceptable for conventional loop indices (`i`, `j`, `k`) and
  established mathematical variables (`x`, `y`, `n`).
- Boolean variables and parameters must read as predicates: `is_valid`,
  `has_error`, `should_retry`, `is_authenticated`. Not `valid`, `flag`,
  `check`, `result`, `done`, `ok`.
- Functions must be named for what they **do**: `normalise_transaction_amount`,
  `fetch_user_by_email`, `validate_request_payload`. Not `process_data`,
  `handle`, `run`, `execute`, `do_thing`.
- A function named `get_X` must not mutate state. A function named `set_X`
  must not return a value used for branching. A function named `is_X` must
  return a boolean.
- Abbreviations are acceptable only if they are unambiguous industry-standard
  conventions: `url`, `id`, `db`, `api`, `ctx`, `env`, `cfg` (only for
  configuration objects when universally understood in context). Custom
  abbreviations like `mgr`, `proc`, `tmp_res`, `req_obj` are not acceptable.
- Class names must be nouns or noun phrases. Method names must begin with
  a verb.
- If a name implies narrower scope than the implementation (`save_user` that
  also sends an email), either rename it or split the function.

### 8.4 Duplication

Surface all findings from Phase 6 here. For each:
- Where the duplication occurs (new file:line)
- Where the existing implementation lives (existing file:line)
- What the functional overlap is
- Whether the fix is "delete new code, use existing" or "extract shared helper
  at [suggested location]"

### 8.5 Structure & Architecture Fit

- Does the new code belong in the file and module it was placed in?
- Does it respect the established layering — service layer, data access
  layer, utility layer, domain layer, presentation layer?
- Are new files placed in the correct directory per the conventions observed
  in the surrounding structure?
- Does it introduce inappropriate cross-layer dependencies (e.g., a utility
  module importing from a service module)?
- Is a new abstraction introduced where one already exists?
- Does the PR change the public interface of a module in a way that could
  break callers not shown in this diff?
- Does the new code follow the module's existing patterns for initialisation,
  dependency injection, and configuration?

### 8.6 Interface & API Design

- Are function signatures minimal? Do parameters all have clear, independent
  purposes?
- Is anything exposed in the public interface that should be private?
- Are there more than 4 parameters? Consider a typed options/config object.
- Do default argument values make sense? Are mutable defaults avoided
  (Python: `def f(items=[])` is a defect)?
- Does the function or class do work that the caller should own?
- Are new HTTP endpoints or handler functions consistent with the naming,
  structure, and response shape of existing endpoints in the codebase?
- Is the interface change backwards-compatible, or does it break existing
  callers?

### 8.7 Error Handling

- Are errors caught and handled at the correct layer?
- Are error messages useful to an engineer debugging in production — do they
  include context (what failed, what the inputs were, what was expected)?
- Are exceptions specific — not bare `except Exception`, `except:`, or
  `catch (e: any)` without re-raising or logging?
- Are failures surfaced to the caller, or silently swallowed?
- If retries are implemented: is backoff correct, is idempotency guaranteed,
  is there a maximum attempt count, are terminal failures clearly signalled?
- Are timeouts applied at every network or I/O boundary?
- Are resources (files, DB connections, HTTP sessions) cleaned up correctly
  even on the error path?

### 8.8 Testing

- Is the changed logic covered by tests in this PR? If not, call it out
  explicitly — absent tests are a finding, not an oversight to mention in
  passing.
- If tests are included, are they testing observable behaviour or
  implementation details?
- Do tests cover edge cases (empty input, error paths, boundary values)?
- Are tests isolated — do they share mutable state that could cause
  order-dependent failures?
- Are mocks used appropriately — mocking external dependencies but not
  internal logic?
- Are test names descriptive enough to identify the scenario without reading
  the test body?

### 8.9 Performance & Resource Management

- Algorithmic inefficiencies: O(n²) or worse where O(n) or O(n log n) is
  straightforward
- N+1 query patterns: database queries inside loops that should be batched
- Unbounded queries: queries with no LIMIT or pagination that will degrade
  as data grows
- Missing caching where results are stable and reuse within a request or
  across requests is clearly beneficial
- Resource leaks: file handles, DB connections, HTTP sessions, or thread
  pool resources not closed on the error path
- Unnecessary re-computation: expensive operations inside loops that produce
  the same result each iteration

### 8.10 Security

- User-controlled input flowing into SQL queries, shell commands, file paths,
  template rendering, or eval-like functions without sanitisation or
  parameterisation
- Secrets, API keys, or credentials hardcoded in source files or log
  statements
- Sensitive data (PII, tokens, passwords) written to logs or error messages
- Missing authentication or authorisation checks on new endpoints or handlers
- Overly permissive CORS, file permissions, or IAM roles
- Insecure deserialization patterns
- Path traversal vulnerabilities in file handling
- Missing CSRF protection on state-mutating endpoints (if applicable to
  the framework in use)

### 8.11 Documentation & Comments

- Complex or non-obvious logic without an explanatory comment
- Misleading comments that describe what the code used to do rather than
  what it does now
- Missing docstrings on public-facing functions and classes — especially
  on anything that is part of an external or internal API
- Over-commented trivial code: comments that state the obvious add noise
  and obscure the signal
- PR description that does not accurately reflect what the code does
  (misleading title or body is itself a finding — note it in the Overview)

---

## Phase 9 — ASCII diagram format

Generate diagrams only if Phase 7 determined they are warranted.

Choose the format that makes the structure most immediately legible.

### Tree format — flows, lifecycles, decision trees, retry logic, state machines

```
Request enters task queue
├── Task executes successfully
│   └── Result persisted, caller notified
├── OpenAI call exceeds 120s timeout
│   ├── Attempt 1 — retried with exponential backoff
│   └── Attempt 2 — terminal failure, error surfaced to caller
├── SoftTimeLimitExceeded (9 min)
│   ├── Attempt 1 — task retried
│   └── Attempt 2 — terminal failure, logged and surfaced
├── HardTimeLimitExceeded (10 min)
│   └── Task killed immediately, no retry, failure logged
├── Worker process killed (OOM / Nomad / external signal)
│   └── Task re-queued immediately (child process killed, parent acks)
└── Entire allocation killed
    └── No process alive to ack — visibility_timeout (900s) expires,
        task re-queued after 15 minutes
```

### Box-and-arrow format — data flows, component relationships, layer topology

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  API Layer   │────▶│ Service Layer│────▶│  Data Layer  │
│  (FastAPI)   │     │  (LangGraph) │     │  (Postgres)  │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────▼───────┐     ┌──────────────┐
                     │ Queue Layer  │────▶│  Worker Pool │
                     │  (Celery)    │     │  (Celery)    │
                     └──────────────┘     └──────────────┘
```

### Diagram rules — follow these without exception

- Only diagram what the PR actually introduces or changes. Do not diagram
  pre-existing architecture the PR does not touch.
- Label every node and every edge. No generic labels like "Component A"
  or "Service B". Use the actual class names, module names, or endpoint paths.
- Show error paths explicitly. A diagram of only the happy path is incomplete
  and misleading.
- Keep all diagrams within terminal width — max 90 characters per line.
- Generate as many diagrams as needed to cover distinct concerns. If the PR
  has both a data flow and a retry lifecycle, generate two separate diagrams.
- Place diagrams in the report before the findings, after the Overview.

---

## Phase 10 — Compose and print the report

Print the full structured report to the terminal. Use the exact format below.

---

```
═══════════════════════════════════════════════════════════════
  PR REVIEW — #<NUMBER>: <TITLE>
  Author : <login>
  Branch : <headRefName> → <baseRefName>
  Repo   : <owner>/<repo>
  Stats  : <changedFiles> files changed  +<additions> −<deletions>
  Commits: <count>
  State  : <OPEN|DRAFT|MERGED|CLOSED>
  Auto-detected: <yes/no — yes only when no PR number was supplied>
═══════════════════════════════════════════════════════════════
```

---

### Overview

3–5 sentences. Describe what this PR actually does based on the code — not
just the description. Is it coherent and appropriately scoped? Does the
description match the implementation? What is the single most important
finding? Is this PR ready to merge?

---

### Diagrams
*(Only rendered if Phase 7 determined they are warranted. Each diagram
has a heading describing what it shows.)*

---

### CRITICAL ISSUES 🔴
*Correctness errors, security vulnerabilities, data loss risks, broken
caller contracts, hard architectural violations. Every item here blocks merge.*

Format for each finding:

```
🔴 [CRITICAL] <Short descriptive title>
   File   : <relative/path/to/file.py>
   Line   : <N>  (or <N>–<M> for a range)
   Origin : <The root location where the defect is introduced — may differ
             from where it manifests>

   <2–4 sentences: what is wrong, why it is wrong, and what breaks or could
   break if this merges as-is. Be concrete — reference the specific variable,
   function, or conditional at fault.>

   Fix:
   <Exact description of what must change. Name the function, variable, or
   logic. If an existing pattern in the codebase should be followed instead,
   cite it by file and function name.>
```

If there are no Critical issues, write: "None."

---

### MAJOR ISSUES 🟠
*Code smells, structural misfit, naming failures, duplicated logic, missing
error handling, API design problems, absent tests. These should be fixed
before merge.*

Same format as Critical issues.

If there are no Major issues, write: "None."

---

### MINOR ISSUES 🟡
*Style, marginal naming, missing comments, small inefficiencies. Should be
addressed but do not block merge on their own.*

One short paragraph per finding is sufficient. Still include file and line.

If there are no Minor issues, write: "None."

---

### DUPLICATION FINDINGS 🔁
*Logic that already exists in the codebase and has been re-implemented in
this PR. Always Major or Critical — never Minor.*

Format for each finding:

```
🔁 [DUPLICATE] <Short title>
   New code  : <path/to/new_file.py>  line <N>
   Existing  : <path/to/existing_file.py>  line <N>

   <What is duplicated. Why the new implementation should be removed in
   favour of the existing one, or how both should be consolidated.>

   Fix:
   <"Delete new implementation, import and call existing function at
   <existing_file>:<function_name>." Or: "Extract shared helper to
   <suggested_path>, replace both usages.">
```

If there are no duplication findings, write: "None."

---

### OUT-OF-SCOPE CHANGES ⚠️
*Files or functions this PR modifies that are not necessary to achieve its
stated purpose. Flag even if the changes appear harmless — they were not
requested, were not part of the stated scope, and have not been reviewed
in the context of why they were changed.*

For each:
- **File** and what changed
- Why it appears out of scope relative to the PR title and description
- Is the change safe as written?
- Recommendation: revert and raise as a separate PR, or accept with a
  stated justification from the author

If there are no out-of-scope changes, write: "None."

---

### WHAT'S DONE WELL ✅

1–3 things that are genuinely good — sound design decisions, well-handled
edge cases, clear naming, good test coverage for a particular path.

Omit this section entirely if there is nothing genuinely noteworthy.
Do not manufacture praise to soften the report.

---

### VERDICT

Print exactly one of the following boxes:

```
┌──────────────────────────────────────────────────────────┐
│  🔴 DO NOT MERGE                                         │
│  <N> critical issue(s), <N> major issue(s)               │
│  Resolve all critical issues before this PR is accepted. │
└──────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────┐
│  🟠 CHANGES REQUESTED                                    │
│  0 critical issues, <N> major issue(s)                   │
│  Address all major findings before merging.              │
└──────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────┐
│  🟡 APPROVED WITH COMMENTS                               │
│  Minor issues only — safe to merge.                      │
│  Address minor findings before squash or in follow-up.   │
└──────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────┐
│  🟢 APPROVED                                             │
│  No significant issues found.                            │
└──────────────────────────────────────────────────────────┘
```

---

## Tone and conduct

- **Be specific.** "This is unclear" is not feedback. "The variable `data`
  on line 42 of `services/ingest.py` could mean anything — rename it to
  `raw_transaction_payload`" is feedback.
- **Do not hedge.** Do not write "might", "perhaps", "could consider",
  "you may want to". If something is a problem, state that it is a problem.
- **Do not soften severity.** A Critical issue is Critical. If it would cause
  data loss, a security breach, or a broken caller contract, it is Critical
  regardless of how small the code change is.
- **Do not praise mediocrity.** A function that does its job adequately,
  without any particularly good design decisions, does not earn a mention in
  What's Done Well.
- **Prioritise ruthlessly.** If there are 15 findings, make clear which 3
  matter most. Do not bury the critical issue on page 4.
- **Every finding must have a citation.** File path and line number are
  non-negotiable. A finding with no location is not a finding.
- **If the PR description lies, say so.** A PR titled "Fix null check in
  payment handler" that also rewrites the entire authentication layer is
  misrepresented. Call it out in the Overview.
- **Duplication is always Major or Critical.** It is not a style issue.
  Treat it accordingly.

---

## Edge cases

**No PR number given and current branch has no PR**: List open PRs and ask
the user to choose. Do not guess.

**Draft PR**: Note `[DRAFT]` prominently in the header. Review fully — the
user explicitly invoked this skill.

**PR already merged**: Note `[MERGED]` in the header. Review fully — the
findings are still useful for follow-up work or post-merge fixes.

**PR already has approvals**: Note this in the header. Review independently
regardless — prior approvals do not reduce the review bar.

**Very large PR (>800 lines of diff)**: State this upfront in the Overview.
Prioritise: (1) high-risk areas — auth, error handling, DB queries, new
public interfaces; (2) duplication scan across all new code; (3) architecture
fit; (4) correctness of core logic. Note that the review is necessarily
higher-level. Recommend the author split future PRs.

**Deleted files**: Verify that the deletion is intentional. Check for
remaining imports or references to the deleted path:
```bash
grep -rn "<deleted_module_name>\|<deleted_file_basename>" \
  --include="*.py" --include="*.ts" --include="*.js" .
```
If references remain, it is a Critical issue (broken imports at runtime).

**Binary files in diff**: Skip binary files. Note them as skipped in the
report header.

**Monorepo**: Scope the duplication scan and codebase context reads to the
packages or workspaces touched by the PR. Note explicitly if a change in one
package could affect another.

**Cross-repo PR reference (`owner/repo#N`)**: Use the specified repo for all
`gh` commands. Note in the header that this is a cross-repo review.

**No local checkout**: Full file reads and grep-based duplication scans
require a local checkout. If the repo is not checked out locally, use the
GitHub API for file content. Note in the report that the grep duplication
scan is limited to files fetchable via the API and may be incomplete.
Recommend the user run the review from a locally checked out working tree
for full coverage.

**`gh` API rate limit hit**: Surface the error. Suggest `gh auth status`
and waiting before retrying, or authenticating with a token with higher
rate limits.
