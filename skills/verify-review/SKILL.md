---
name: verify-review
description: >
  Perform a second-pass verification review of uncommitted code changes after a
  prior code-review has already been given to an AI coding agent (e.g. Codex,
  Claude Code, pi) for implementation. Use this skill when the user asks to "verify the
  fixes", "check if the review was implemented", "second pass", "re-review after
  Codex", "did it implement the changes correctly", or any phrasing that implies
  a previous review round has already occurred and the user wants to confirm
  the implementation is correct and complete. This skill does two things the
  initial code-review does not: (1) it cross-references the current diff against
  the prior review feedback to check for addressed, missed, and incorrectly
  implemented items; (2) it performs a dedicated regression scan to catch new
  problems introduced during the fix pass. The bar for code quality is identical
  to code-review — no issue is too small to flag.
---

# Verify-Review Skill

This skill is the second gate in a two-agent development workflow:

1. `code-review-uncommitted-changes` — first-pass review of changes written by an AI coding agent
2. **`verify-review`** — verification that the AI correctly acted on that review,
   plus a regression scan of everything it touched

The key difference from a fresh `code-review`: this skill has **prior context**.
It knows what was asked, and it holds the implementation accountable to that ask.
It does not give the benefit of the doubt. If a requested fix is absent, partial,
or wrong, that is a failure — not a gap to work around.

---

## Before starting — obtain the prior review

The user must supply the prior `code-review` output. If they have not, ask for
it before proceeding:

> "Please paste the prior code-review output so I can verify against it."

Do not proceed without it. Proceeding without the prior review degrades this
skill to a generic second review, which loses all accountability tracking.

Store the prior review mentally as a structured list of items, each tagged as:
- **Critical** 🔴, **Major** 🟠, or **Minor** 🟡
- With its file, description, and requested fix

---

## Step 1 — Gather the current diff

> **You must run every command in this step right now and show the live output before continuing.**
> Do not rely on any diff, file listing, or git output that appeared earlier in this conversation —
> even if a `code-review` just ran moments ago in the same session. The working tree may have been
> modified between then and now. Assuming it is unchanged without actually checking is the most
> common failure mode of this skill, and it makes the entire review invalid.
>
> Run each command, display its output, and only then proceed to Step 2.

Run these first to get orientation:

```bash
git status --short
git diff HEAD --stat
git diff HEAD --name-only
```

Then capture the full diff:

```bash
git diff HEAD
```

If the working tree is clean but there are staged changes:

```bash
git diff --cached
```

**If all commands return empty output**, that is a finding in itself — do not silently
conclude nothing changed based on session context. Report it explicitly:
> "No uncommitted changes detected in the working tree. The prior review has not been acted upon."
> Then issue a 🔴 FAIL verdict immediately and stop.

---

## Step 2 — Reconstruct codebase context

Re-orient in the repository even if a prior review exists. The AI coding agent
may have touched files not covered in the original review, introduced new
dependencies, or restructured things. Never assume the prior review's structural
observations are still fully accurate.

```bash
find . -maxdepth 3 \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.venv/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  | sort
```

Read config files that signal conventions:
- `pyproject.toml` / `setup.cfg` / `setup.py`
- `package.json` / `tsconfig.json`
- `.eslintrc*` / `ruff.toml` / `.flake8`
- `Makefile` / `justfile`

For each file in the diff, skim the **full current file**, not just the changed
lines. The AI may have made changes outside the visible diff hunks (e.g.,
reordered imports, altered unrelated functions in the same file).

---

## Step 3 — Cross-reference: prior review vs. current diff

This step has no equivalent in `code-review`. It is the core accountability
layer of this skill.

For **every item** in the prior review, determine its implementation status:

### Status classifications

**✅ Correctly Implemented**
The fix matches what was requested. The problem described in the prior review is
gone. No new problems were introduced in the fix. No shortcut was taken.

**⚠️ Partially Implemented**
The fix exists but is incomplete. Examples:
- The rename was applied in one place but not its call sites
- The error handling was added but uses the wrong exception type
- The duplication was removed from one module but a second instance was missed
- The logic is restructured but the original problem persists under different
  conditions

**❌ Not Implemented**
The prior review item is entirely absent from the diff. The code is unchanged
from what was originally flagged.

**🔄 Incorrectly Implemented**
An attempt was made but the result is wrong. The fix either:
- Does not solve the original problem
- Introduces a new problem in the same location
- Misunderstood the intent of the feedback and changed the wrong thing

**🆕 New Issue in Fix Area**
The fix is correct, but the AI introduced a new problem in the same code block
or adjacent code while making the change. This is a regression local to the fix.

Classify every prior review item. Do not skip Minor items — a pattern of
ignored Minor issues indicates the agent is triaging feedback, which is not
acceptable.

---

## Step 4 — Regression scan

The AI coding agent may have introduced new problems entirely outside the scope
of the prior review items. This step scans for regressions across the full diff.

### 4.1 Scope creep
Did the agent modify files or functions that were not flagged in the prior
review and were not necessary to implement the requested fixes? Every
out-of-scope change must be examined with heightened scrutiny — it was not
reviewed and was not requested.

### 4.2 Duplication introduced during fixes
```bash
# For each new utility or helper introduced in the diff:
grep -rn "def <function_name>\|function <name>\|const <name>" \
  --include="*.py" --include="*.ts" --include="*.js" .
```
AI agents frequently re-implement helpers that already exist when refactoring.
Search actively, do not assume.

### 4.3 Correctness regressions
- Did a refactor change observable behaviour?
- Were any guards, validations, or checks removed that were previously present?
- Did a rename or restructure break call sites not shown in the diff?
- Were any return values or side effects altered silently?

### 4.4 Error handling regressions
- Did the agent remove try/except or try/catch blocks that existed before?
- Were error propagation paths altered?
- Were new failure modes introduced by the refactor that are now unhandled?

### 4.5 Import and dependency regressions
- Were imports removed that are still needed elsewhere?
- Were new dependencies added without justification?
- Were circular imports introduced?

### 4.6 Type safety regressions (TypeScript / typed Python)
- Were types weakened (e.g., `string` → `any`, `str` → `Optional[str]`)?
- Were type assertions added to paper over a type mismatch?
- Were new `# type: ignore` or `@ts-ignore` annotations introduced?

### 4.7 All original code-review dimensions on the full diff
Run the complete review checklist from `code-review` on the entire current diff,
not just the changed lines. The AI may have written new code alongside the fixes
that has never been reviewed.

Dimensions to cover (apply the same rigour as `code-review`):
- **Correctness** — logic errors, missing edge cases, wrong conditionals
- **Code smells** — long functions, deep nesting, god objects, magic literals,
  dead code, side effects in wrong places
- **Naming** — descriptive, unambiguous, predicate booleans, verb functions,
  no custom abbreviations
- **Duplication** — repeated blocks, copy-paste with variation, re-implemented
  stdlib/framework functionality
- **Structure & Architecture Fit** — correct module placement, layering,
  no new cross-layer deps
- **Interface & API Design** — minimal signatures, correct visibility,
  no excessive parameters, no mutable defaults
- **Error Handling** — correct layer, useful messages, specific exceptions
- **Testing Considerations** — testability, meaningful tests if included
- **Performance & Resource Management** — algorithmic efficiency, N+1 patterns,
  unclosed resources
- **Security** — unsanitised input, hardcoded secrets, missing auth checks
- **Documentation & Comments** — complex logic explained, no misleading comments

---

## Step 5 — Format the output

The output has two distinct sections: the **accountability report** (how well the
AI implemented the prior review) and the **regression report** (new problems
found in this pass). Both sections apply the same severity model. Do not merge
them — keeping them separate makes it clear what is a follow-through failure vs.
a new problem.

---

### SECTION A — Prior Review Implementation Status

#### Summary
2–3 sentences. What percentage of the prior review was correctly implemented?
Were all Critical and Major items addressed? Is the implementation trustworthy?

#### Implementation Scorecard

| Item | Severity | Status | Notes |
|------|----------|--------|-------|
| [brief description of prior review item] | 🔴/🟠/🟡 | ✅/⚠️/❌/🔄 | What was done / what was missed |

Include every item from the prior review. Do not omit Minor items.

#### Items Requiring Re-work

For each item that is not ✅ Correctly Implemented, provide a dedicated entry:

**[File:Line] — [Prior review item title]**
- **Status**: ⚠️ Partial / ❌ Not Implemented / 🔄 Incorrectly Implemented
- **What was requested**: [exact ask from prior review]
- **What was done**: [what the diff actually shows, or "nothing"]
- **What is still needed**: [concrete, specific fix required]

Be precise. If the agent misunderstood the feedback, say so explicitly and
restate what was actually meant.

---

### SECTION B — Regression & New Issues Report

#### Summary
2–3 sentences. Were new problems introduced during the fix pass? How significant
are they? Does the fix pass leave the codebase in a better or worse state than
before the AI acted on the review?

#### Critical Regressions 🔴
*New correctness, security, or architectural problems introduced by the fix pass.*

For each:
- **File:Line** — Issue title
- What the problem is
- Why it was introduced (scope creep, misrefactoring, etc.)
- Concrete fix

#### Major New Issues 🟠
*New code smells, structural problems, naming failures, or duplication
introduced during the fix pass — not present in the original diff.*

Same format as Critical.

#### Minor New Issues 🟡
*Style, small naming issues, marginal improvements. Can be listed concisely.*

#### New Duplication Findings 🔁
*Logic re-implemented or duplicated during the fix pass.*

For each:
- **New location** vs **existing location**
- What is duplicated
- Recommendation

#### Out-of-Scope Changes ⚠️
*Files or functions modified by the AI that were not touched in the prior review
and were not necessary to implement the requested fixes.*

For each:
- **File** — What changed
- Was the change safe? Did it introduce any problems?
- Should it be reverted?

---

### Overall Verdict

One of:

**🟢 PASS — Ready to commit**
All Critical and Major prior review items correctly implemented. No critical
regressions. Minor issues noted above but do not block commit.

**🟡 CONDITIONAL PASS — Minor rework needed**
All Critical prior review items addressed. One or more Major items partially
implemented or a small number of new Major issues introduced. List the specific
blockers.

**🔴 FAIL — Send back for rework**
One or more Critical prior review items not implemented, incorrectly
implemented, or critical regressions introduced. Do not commit. List exactly
what must be fixed before re-review.

---

## Tone guidelines

These are stricter than `code-review` because this is a verification pass, not
an initial review. The AI has already been told what to fix.

- **Do not give credit for partial fixes.** A 90% correct implementation of a
  Critical issue is still a failure. Say so.
- **Name the pattern when the AI consistently misunderstands feedback.** If
  multiple items show the same class of misimplementation (e.g., renames applied
  at definition but not call sites), say that explicitly.
- **Do not soften verdicts.** "Mostly addressed" is not a verdict. It was
  addressed or it was not.
- **Out-of-scope changes are always suspicious.** An AI that modifies unrequested
  code may be drifting. Flag every out-of-scope change, even if it looks benign.
- **Be precise about what the fix should be.** The output of this review will be
  fed back to the AI agent. Vague feedback produces vague fixes. Every re-work
  item must be actionable without interpretation.
- **Do not manufacture positives.** If the AI did a poor job, the What's Done
  Well section is omitted entirely.

---

## Edge cases

**No prior review supplied**: Do not proceed. Ask for it. A verify-review
without the prior review is just a second `code-review` and misses the
accountability layer entirely.

**Prior review is partially legible / cut off**: Work with what is available.
Note which items could not be verified due to missing context and flag them
explicitly in the scorecard as "⚠️ Unverifiable — prior review incomplete".

**Diff is empty / clean working tree**: The AI made no changes. This is itself
a finding — report it as "❌ No changes detected. Prior review was not acted
upon." Do not silently exit.

**AI added entirely new files not mentioned in prior review**: Treat new
unreviewed files as out-of-scope changes. Review them fully under Section B.
New files are not exempt from scrutiny simply because they are new.

**AI reverted changes instead of fixing them**: Flag as 🔄 Incorrectly
Implemented. Reverting is not a fix unless the prior review explicitly asked
for a revert.

**Large diff (>500 lines)**: Prioritise cross-referencing prior review items
first (Section A), then focus the regression scan (Section B) on the highest-
risk areas: new files, modified error handling, modified auth/validation logic,
and any out-of-scope changes. Note that the regression scan is necessarily
higher-level for large diffs.

**Unfamiliar framework or language**: State this upfront. Proceed with
language-agnostic checks for both sections. Flag where domain expertise would
be needed to verify correctness of framework-specific patterns.
