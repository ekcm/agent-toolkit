---
name: code-review-uncommitted-changes
description: >
  Perform a rigorous, senior-engineer-level review of uncommitted code changes
  in the current repository. Use this skill whenever the user asks to review,
  audit, check, critique, or inspect their current changes, diffs, or staged
  files. Triggers on phrases like "review my changes", "check my diff",
  "review what I've written", "is my code good", "audit my PR", or any request
  to evaluate code quality before committing or opening a pull request.
  This skill is extremely critical by design — it checks for code smells,
  duplication of existing logic, naming issues, structural misalignment, and
  all common best-practice violations.
---

# Code Review Skill

A thorough, unsparing review of uncommitted code changes. This skill functions
as a senior engineer performing a pre-commit review: it reads the diff,
understands the surrounding codebase context, and provides actionable,
prioritised feedback. It does not soften criticism. If code is poor, it says so.

---

## Step 1 — Gather the diff

Run the following to capture all uncommitted changes (staged + unstaged):

```bash
git diff HEAD
```

If the working tree is clean but there are staged changes only:

```bash
git diff --cached
```

If the user specifies a branch or commit range, use:

```bash
git diff <base>..<head>
```

Also collect the list of changed files for structural analysis:

```bash
git diff HEAD --name-only
```

If there are **untracked new files** the user wants reviewed:

```bash
git status --short
# then read new files individually
```

---

## Step 2 — Understand the repository structure

Before reviewing, orient yourself in the codebase. Run:

```bash
# Top-level structure
find . -maxdepth 3 \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.venv/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  | sort
```

Read key configuration files that reveal conventions:
- `pyproject.toml` / `setup.cfg` / `setup.py` (Python)
- `package.json` (JS/TS)
- `tsconfig.json` (TypeScript strictness)
- `.eslintrc*` / `ruff.toml` / `.flake8` (linting rules)
- `Makefile` / `justfile` (workflow scripts)

Skim adjacent modules to the changed files to understand naming conventions,
patterns, and whether similar logic already exists elsewhere.

---

## Step 3 — Detect duplicate logic

This is critical. Fast-moving codebases accumulate duplicated logic quickly.

For each substantive piece of logic introduced in the diff:

1. Search for similar functions/classes/utilities already in the codebase:
   ```bash
   # Search by function name pattern
   grep -rn "def <function_name>\|function <name>\|const <name>" \
     --include="*.py" --include="*.ts" --include="*.js" .

   # Search by logic pattern (e.g., a specific operation)
   grep -rn "<distinctive_keyword_or_pattern>" \
     --include="*.py" --include="*.ts" --include="*.js" .
   ```

2. If similar logic exists, flag it explicitly: show the existing location, the
   new code, and explain the duplication. Always prefer pointing the author to
   the existing utility over accepting the duplicate.

3. Check for re-implemented standard library / framework functionality.

---

## Step 4 — Perform the review

Evaluate every changed file against all of the following dimensions. Be
exhaustive. Do not skip a dimension because "it looks mostly fine."

### 4.1 Correctness
- Logic errors, off-by-one errors, incorrect conditionals
- Missing edge case handling (null/None, empty collections, zero values)
- Race conditions or concurrency issues
- Incorrect error handling (swallowed exceptions, wrong exception types)
- Wrong return types or missing returns

### 4.2 Code Smells
Flag any of the following:
- **Long functions** — functions doing more than one thing
- **Deep nesting** — more than 2–3 levels of indented logic
- **God objects / classes** — classes with too many responsibilities
- **Primitive obsession** — overuse of raw strings/ints where typed structures belong
- **Magic numbers/strings** — unexplained literals inline
- **Feature envy** — a function that works heavily with another class's data
- **Dead code** — unreachable branches, commented-out blocks, unused imports
- **Side effects in unexpected places** — e.g., mutation inside a predicate
- **Overly defensive code** — guards that can never trigger
- **Shotgun surgery smell** — a change that touched many unrelated files

### 4.3 Naming
Apply strict standards:
- Variable names must be descriptive and unambiguous. Single-letter names
  outside of loop indices or mathematical contexts are not acceptable.
- Boolean variables must read as predicates: `is_valid`, `has_error`, not
  `valid`, `flag`, `check`.
- Functions must be named for what they **do**, not what they **are**.
  `process_data()` is unacceptable. `normalize_transaction_amount()` is not.
- Avoid misleading names: a function named `get_X` must not mutate state.
- Abbreviations are acceptable only if they are industry-standard (e.g., `url`,
  `id`, `db`). Custom abbreviations like `cfg`, `mgr`, `tmp_res` are not.
- Class names must be nouns. Method names must be verbs.

### 4.4 Duplication
(See Step 3 above — surface the findings here.)
- Repeated logic blocks that should be extracted to a shared utility
- Copy-pasted code with minor variation (should be parameterised)
- Re-implementation of something already in the codebase

### 4.5 Structure & Architecture Fit
- Does the new code belong in the file/module it was placed in?
- Does it follow the layering/separation of concerns established elsewhere in
  the repo (e.g., service layer, data layer, utility layer)?
- Are new files placed in the correct directory per the existing structure?
- Does it introduce inappropriate cross-layer dependencies?
- Is a new abstraction introduced where one already exists?

### 4.6 Interface & API Design
- Are function signatures minimal and purposeful?
- Is anything in the public interface that should be private?
- Are there too many parameters? (>4 is a warning sign — consider a config
  object)
- Do default argument values make sense and avoid mutable defaults?
- Is the function/class doing too much work that the caller should own?

### 4.7 Error Handling
- Are errors handled at the right layer?
- Are error messages useful to a developer debugging in production?
- Are exceptions specific (not bare `except Exception` or `catch (e)`)?
- Are failures surfaced rather than silently swallowed?

### 4.8 Testing Considerations
- Is the new logic testable? (i.e., not tightly coupled, dependencies injectable)
- Are there obvious test cases missing?
- If tests are included in the diff, are they meaningful or superficial?

### 4.9 Performance & Resource Management
- Obvious algorithmic inefficiencies (e.g., O(n²) where O(n) is straightforward)
- N+1 query patterns in DB-adjacent code
- Missing pagination / unbounded queries
- File handles, DB connections, or network resources not closed properly
- Unnecessary re-computation inside loops

### 4.10 Security (flag where applicable)
- User-controlled input flowing into queries, shell commands, file paths, or
  eval-like functions without sanitisation
- Secrets or credentials hardcoded or logged
- Overly permissive access patterns
- Missing authentication/authorisation checks on new endpoints/handlers

### 4.11 Documentation & Comments
- Complex logic without explanation
- Misleading or out-of-date comments
- Missing docstrings on public-facing functions/classes
- Over-commented obvious code (noise)

---

## Step 5 — Format the output

Structure the review as follows. Be direct. Do not hedge.

---

### Summary
2–4 sentences. Overall quality assessment. Is this ready to commit? What is the
single most important thing to fix?

---

### Critical Issues 🔴
*Must fix before committing. Correctness, security, or major architectural
problems.*

For each issue:
- **File:Line** — Issue title
- Clear explanation of the problem
- Concrete fix or direction

---

### Major Issues 🟠
*Should fix before committing. Code smells, duplication, structural problems,
naming failures.*

Same format as Critical.

---

### Minor Issues 🟡
*Nice to fix. Style, minor naming, small improvements.*

Can be listed more briefly.

---

### Duplication Findings 🔁
*Dedicated section for any logic that already exists elsewhere in the repo.*

For each finding:
- **New code location** vs **existing code location**
- What the duplication is
- Recommendation (use the existing utility / merge / extract shared helper)

---

### What's Done Well ✅
1–3 things that are genuinely good. Skip this section if there is nothing
noteworthy. Do not manufacture praise.

---

## Tone guidelines

- Be specific. "This is unclear" is not feedback. "The variable `data` on
  line 42 could be anything — name it `raw_transaction_payload`" is feedback.
- Do not soften findings with "might", "perhaps", "could consider". If it is a
  problem, say it is a problem.
- Do not praise mediocrity. A function that does its job without being
  exceptional does not deserve a compliment.
- Prioritise ruthlessly. If there are 20 issues, make clear which 3 matter most.
- If a piece of logic already exists in the codebase and the author has
  re-implemented it, this is always a Critical or Major issue, never Minor.

---

## Edge cases

**No diff / clean working tree**: Inform the user there are no uncommitted
changes detected. Suggest `git status` to verify.

**Binary files in diff**: Skip binary files. Note them as skipped.

**Large diffs (>500 lines)**: Prioritise review breadth over exhaustive
line-by-line coverage. Focus on architecture, duplication, and the most
egregious issues. Note that the review is necessarily higher-level for large
diffs and recommend the author break future PRs into smaller units.

**Unfamiliar framework/language**: State the unfamiliarity upfront, proceed
with language-agnostic checks (naming, structure, duplication, logic), and flag
where domain expertise would be needed for a deeper review.
