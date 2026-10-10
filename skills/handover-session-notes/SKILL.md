---
name: handover-session-notes
description: >
  Preserve full session context before the context window is depleted by
  generating a structured NOTES.md file in the root of the repository.
  Use this skill when the user invokes handover-session-notes by name, asks to "save context",
  "save progress", "dump context", "context is running out", "preserve session",
  "save notes", "save our work", or any phrasing indicating they want to
  capture the current session state before context is lost. This skill scans
  the full conversation, extracts the original task, all decisions and
  rationale, rejected approaches, dead ends, architecture, tradeoffs,
  unresolved questions, feature-level progress, git state, and TODO scan,
  then writes a NOTES.md structured for both human readability and agent
  re-ingestion at the start of the next session. Overwrites any existing
  NOTES.md after warning the user. Does not run tests. Does not make any
  code changes. Does not execute anything beyond read-only filesystem and
  git commands.
---

# handover-session-notes

Captures the full working state of a session into a structured NOTES.md at
the root of the repository. Optimised for two consumers simultaneously:
a human reviewing progress, and a coding agent reconstructing working state at the
start of the next session.

This skill is read-only except for writing NOTES.md. It does not modify
code, run tests, commit anything, or execute non-read commands.

---

## Phase 0 — Environment check

Confirm the current directory is inside a git repository:

```bash
git rev-parse --show-toplevel
```

Store the repo root. All subsequent file operations use this path.
NOTES.md will be written to this root.

If not a git repo, stop:
```
✗ Not a git repository. Cannot determine repo root for NOTES.md placement.
```

---

## Phase 1 — Check for existing NOTES.md

```bash
ls "$(git rev-parse --show-toplevel)/NOTES.md" 2>/dev/null
```

If NOTES.md already exists, warn the user before proceeding:

```
⚠️  NOTES.md already exists at <repo_root>/NOTES.md
    This will be overwritten. Proceeding in 3 seconds unless you cancel (Ctrl+C)...
```

Wait a visible beat — write this message clearly so the user has a chance
to cancel. Then proceed and overwrite. Do not ask a follow-up question —
the user has already invoked the skill intentionally.

---

## Phase 2 — Extract the original task

Scan the conversation history for the original task or goal. Look for:
- The first substantive user message that describes what should be built
- Any explicit task description, brief, or requirements statement
- A message framed as "I want to build X" / "We need to implement Y" /
  "The goal is Z"

If a clear original task is found, extract it verbatim or near-verbatim.

If no clear original task is identifiable (e.g., the conversation started
mid-work), infer the task from the aggregate of what has been discussed and
built. Frame it as: "Inferred from session: [inferred task description]."

This becomes the `TASK` field in NOTES.md.

---

## Phase 3 — Gather git state

```bash
# Current branch
git rev-parse --abbrev-ref HEAD

# Uncommitted changes (staged and unstaged)
git status --short

# Last 5 commit messages and their hashes
git log --oneline -5

# Files modified since the last commit
git diff HEAD --name-only

# Files that are staged
git diff --cached --name-only

# Untracked files
git ls-files --others --exclude-standard
```

Record:
- Current branch name
- Whether there are uncommitted changes (yes/no + count of files)
- Names of uncommitted/untracked files
- Last commit hash and message
- Recent commit history (last 5)

---

## Phase 4 — Scan the codebase state

### 4.1 Repository structure

```bash
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

### 4.2 TODO / FIXME / stub scan

```bash
grep -rn \
  --include="*.py" --include="*.ts" --include="*.js" \
  --include="*.tsx" --include="*.jsx" --include="*.go" \
  -E "TODO|FIXME|HACK|XXX|NOCOMMIT|raise NotImplementedError|throw new Error\(\"not implemented" \
  . 2>/dev/null
```

Record every hit with file path, line number, and the full line text.

### 4.3 Key configuration files

Read whichever exist:
```bash
cat pyproject.toml 2>/dev/null
cat package.json 2>/dev/null
cat tsconfig.json 2>/dev/null
cat docker-compose.yml 2>/dev/null
cat .env.example 2>/dev/null
```

Note any significant dependencies, environment variables, or tooling
configuration that future sessions must be aware of.

---

## Phase 5 — Extract session knowledge from the conversation

Scan the entire conversation history and extract the following. Be thorough
— this is the core value of the skill. Do not summarise prematurely.

### 5.1 Architecture and design decisions

For each significant architectural or design decision made during the session:
- What was decided
- Why it was decided (the explicit or implied rationale)
- What alternatives were considered
- What constraints drove the decision

Examples: choice of framework, data model design, API structure, queue
architecture, authentication approach, state management strategy, file
organisation.

### 5.2 Rejected approaches

For each approach that was considered and ruled out:
- What the approach was
- Why it was rejected (performance, complexity, incompatibility, cost,
  correctness issue, etc.)
- Whether the rejection is permanent or conditional ("ruled out for now
  because X, but worth revisiting if Y")

This is the highest-value section for preventing re-debate in future sessions.
Extract these carefully. They are often expressed as "we decided not to...",
"the problem with X is...", "we tried Y but...", "X won't work because...".

### 5.3 Dead ends

Code paths, implementations, or approaches that were actively built or
prototyped and then abandoned. Different from rejected approaches — these
are things that were actually tried, not just discussed.
- What was built or attempted
- What went wrong or why it was abandoned
- Whether any of the work is salvageable

### 5.4 Explicit tradeoffs

Decisions where the session explicitly acknowledged a downside being accepted:
- What was chosen
- What was sacrificed (performance, simplicity, flexibility, etc.)
- Why the tradeoff was considered acceptable

### 5.5 Unresolved questions and open decisions

Scan for anything that was:
- Deferred: "we'll come back to this", "decide later", "TBD", "not sure yet"
- Debated without resolution
- Flagged as uncertain: "I think X but not sure", "need to check if..."
- Explicitly left open: "open question:", "still need to figure out..."

For each: state the question clearly and any partial context or options
that were mentioned.

### 5.6 Known issues and bugs

Any bugs, defects, or incorrect behaviour identified during the session
that have not yet been fixed. Include: what the issue is, where it was
observed, and any hypotheses about the cause.

### 5.7 External dependencies and integrations

Services, APIs, databases, queues, or third-party tools involved in the
project. For each: what it is, how it is used, what credentials or config
it requires, and whether it is currently mocked or real in the codebase.

---

## Phase 6 — Assess feature-level progress

Based on the original task (Phase 2) and the full conversation, construct
a feature-level breakdown of progress.

For each feature or component of the task:

| Status | Meaning |
|--------|---------|
| ✅ Complete | Built, working, and not known to have issues |
| 🔧 In Progress | Started but not finished — partially implemented |
| ❌ Not Started | Not yet touched |
| ⚠️ Broken | Built but known to be broken or incorrect |
| 🚫 Descoped | Explicitly removed from scope during the session |

Group features by logical area if the task has multiple domains
(e.g., backend, frontend, infrastructure, testing).

For "In Progress" items, note specifically what is done and what remains.

---

## Phase 7 — Compose NOTES.md

Write the file to `<repo_root>/NOTES.md` using the exact structure below.

The structure is two-layer throughout:
- A terse structured block per section (optimised for agent re-ingestion)
- A short human-readable narrative paragraph below it

The resume prompt goes first — it is the highest-use section.

---

```markdown
# NOTES.md
<!-- Generated by the handover-session-notes skill. Overwrite freely. Feed to your coding agent at session start. -->
<!-- Last saved: <ISO datetime> | Branch: <branch> | Repo: <repo_root_name> -->

---

## ⚡ RESUME PROMPT
<!-- Paste this at the start of a new coding agent session to restore context -->

```
I'm resuming work on: <one-line task description>.

Previous session context is in NOTES.md at the repo root — please read it
in full before we continue.

We were last working on: <specific thing in progress at context save time>.

Immediate next step: <the single most actionable next thing to do>.

Known blockers: <any blocking issues or unresolved questions that must be
addressed before proceeding — "none" if clear>.
```

---

## 🎯 TASK

**Original goal:**
<Verbatim or near-verbatim task description. If inferred, prefix with
"[INFERRED]".>

**Scope clarifications made during session:**
- <Any scope changes, additions, or removals agreed during the session>
- <"None" if unchanged>

*Human note: The above is the original task as stated at the start of the
session, plus any scope changes agreed during our conversation.*

---

## 🏗️ ARCHITECTURE

**Stack:**
- <Layer>: <Technology> — <one-line rationale>
- <Layer>: <Technology> — <one-line rationale>
- (repeat for each component)

**Key structural decisions:**
- <Decision>: <Rationale in one sentence>
- <Decision>: <Rationale in one sentence>

**Data flow (if applicable):**
<Terse description or ASCII diagram of how data moves through the system>

*Human note: <2–3 sentence narrative explaining the architecture in plain
language, including any non-obvious choices.>*

---

## ✅ DECISIONS AND RATIONALE

<!-- Terse structured block -->
| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| <What was decided> | <Why> | <What else was considered> |

*Human note: <Narrative paragraph summarising the most significant decisions
and why they were made. Focus on decisions that would be non-obvious to
someone reading the code cold.>*

---

## 🚫 REJECTED APPROACHES

<!-- These exist to prevent re-debating settled questions. Do not revisit
     without new information. -->

**[<Approach name>]**
- What: <What this approach was>
- Why rejected: <Specific reason — be precise>
- Permanent or conditional: <Permanent / Conditional on: <condition>>

**[<Approach name>]**
- What: <...>
- Why rejected: <...>
- Permanent or conditional: <...>

*Human note: <Narrative paragraph summarising the rejected directions and
the key insight that made them unworkable.>*

---

## 💀 DEAD ENDS

<!-- Things actually attempted and abandoned, not just discussed -->

**[<What was tried>]**
- Attempted: <What was built or prototyped>
- Outcome: <What broke or why it was abandoned>
- Salvageable: <Yes — <what can be reused> / No>

*Human note: <Brief narrative of what was tried and what the failure mode
revealed about the problem.>*

---

## ⚖️ TRADEOFFS ACCEPTED

| Chose | Sacrificed | Justification |
|-------|-----------|---------------|
| <What was picked> | <What was given up> | <Why acceptable> |

*Human note: <Narrative noting the most significant tradeoffs and whether
they should be revisited as the project scales.>*

---

## 📊 PROGRESS

**Overall status:** <one-line assessment — e.g., "Core backend complete,
frontend not started, tests partial">

| Feature / Component | Status | Notes |
|---------------------|--------|-------|
| <Feature> | ✅ Complete | <any caveats> |
| <Feature> | 🔧 In Progress | <what's done / what remains> |
| <Feature> | ❌ Not Started | <any prereqs or blockers> |
| <Feature> | ⚠️ Broken | <what's wrong> |
| <Feature> | 🚫 Descoped | <why> |

*Human note: <Narrative paragraph describing where things stand. What works
end-to-end right now, what's partially wired, and what hasn't been touched.>*

---

## ❓ UNRESOLVED QUESTIONS

<!-- These MUST be addressed before or at the start of the next session -->

1. **<Question>**
   Context: <Relevant background, options discussed, any partial answer>
   Blocking: <Yes — blocks <feature> / No>

2. **<Question>**
   Context: <...>
   Blocking: <...>

*Human note: <Narrative noting which of these are the most pressing and
what information or decision is needed to unblock them.>*

---

## 🐛 KNOWN ISSUES

| Issue | Location | Severity | Hypothesis |
|-------|----------|----------|------------|
| <Description> | <file:line or component> | 🔴 / 🟠 / 🟡 | <suspected cause> |

*Human note: <Brief narrative on any issues that need to be addressed before
the work is considered production-ready.>*

---

## 🔗 EXTERNAL DEPENDENCIES

| Service / Tool | Purpose | Config / Credentials | Status |
|----------------|---------|---------------------|--------|
| <Name> | <What it does in this project> | <Env vars or config keys needed> | Real / Mocked |

*Human note: <Any integration-specific notes — known quirks, rate limits,
auth patterns, or setup steps needed for a fresh environment.>*

---

## 📁 CODE STATE

**Branch:** `<branch_name>`
**Last commit:** `<hash>` — <message>
**Uncommitted changes:** <N files> — <list of filenames>
**Untracked files:** <list or "none">

**Recent commits:**
```
<git log --oneline -5 output>
```

**TODOs and stubs in codebase:**
| File | Line | Type | Content |
|------|------|------|---------|
| <path> | <N> | TODO/FIXME/HACK/STUB | <full line text> |

*Human note: <Any relevant notes about the current git state — e.g., "mid-way
through a refactor", "waiting to commit until X is working", etc.>*

---

## 🗂️ REPOSITORY STRUCTURE

```
<output of find command, trimmed to relevant paths>
```

**Key files:**
- `<path>` — <one-line description of what this file does>
- `<path>` — <one-line description>
- (list only files that are non-obvious or central to the task)

---
<!-- End of NOTES.md — generated by the handover-session-notes skill -->
```

---

## Phase 8 — Confirm and report

After writing the file, print to the terminal:

```
✅ NOTES.md written to <full_path>
   Sections: task, architecture, decisions (<N>), rejected approaches (<N>),
             dead ends (<N>), tradeoffs (<N>), progress (<N> features),
             unresolved questions (<N>), known issues (<N>),
             external dependencies (<N>), TODOs (<N>)

   Resume prompt is at the top of the file — paste it into a new session
   to restore context.
```

If any section came up empty (e.g., no dead ends, no known issues), still
include the section header in NOTES.md with "None identified." — do not
omit sections. An empty section is itself informative.

---

## Extraction guidelines

These apply to Phase 5 across all sub-sections.

**Be precise, not generic.** "We decided to use Celery" is not useful.
"We use Celery with SQS as the broker because the LangGraph approach caused
visibility timeout issues under high concurrency — Redis was ruled out due
to persistence requirements" is useful.

**Preserve specificity.** Variable names, function names, file paths,
error messages, benchmark numbers, latency figures, and schema details
mentioned in the conversation should be preserved verbatim where relevant.
Do not round them into generalities.

**The terse block is for the agent.** Write it as you would write a system
prompt or context injection — dense, labelled, unambiguous. Avoid filler.
Every word should carry information.

**The narrative paragraph is for the human.** Write it as a knowledgeable
colleague would write a handoff note — clear, conversational, highlighting
the non-obvious.

**Err toward more, not less.** If uncertain whether something belongs in
NOTES.md, include it. Context is cheap in a file. Missing context is
expensive in a session.

**The resume prompt must be immediately usable.** Someone must be able to
copy it, paste it into a fresh session of any coding agent, and have the agent
immediately understand the full context without needing to ask clarifying
questions.

---

## Edge cases

**Conversation is very short / session just started**: Write NOTES.md with
whatever is available. Mark most sections "Insufficient session history to
extract." The git state and codebase scan sections will still be fully
populated.

**No git uncommitted changes**: Note "Working tree clean." in the Code State
section.

**No TODOs found in codebase**: Write "No TODOs, FIXMEs, or stubs found."
in the TODOs table.

**No external dependencies identified**: Write "None identified." in that
section.

**Task cannot be extracted or inferred**: Write the Task section as:
"[UNKNOWN] — task description not recoverable from conversation history.
Infer from codebase structure and progress sections."

**NOTES.md write fails** (e.g., permission error): Report the error and
print the full NOTES.md content to the terminal as a fallback so nothing
is lost.

**Very large conversation**: Do not truncate the extraction. The entire
conversation should be scanned for decisions, rejected approaches, and
dead ends. If the conversation is so large that summarisation is lossy,
note in the resume prompt: "Session was large — verify key decisions
against conversation history if anything seems incomplete."
