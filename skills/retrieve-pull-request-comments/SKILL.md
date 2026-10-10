---
name: retrieve-pull-request-comments
description: >
  Retrieve all review comments from a GitHub Pull Request on the current branch
  using the GitHub CLI (gh), analyse them, and render a structured summary table
  in the terminal. Use this skill when the user invokes retrieve-pull-request-comments by name
  or asks to "get PR comments", "show review comments", "what did reviewers say",
  "pull request feedback", "retrieve comments from my PR", or any phrasing that
  indicates they want to see and analyse review feedback on their current PR.
  Automatically detects the PR from the current branch — no PR number needed.
  Fetches both inline code comments and PR-level conversation comments, reads
  the full changed files to determine implementation status, infers severity
  from comment content, tracks response status, detects outdated threads, and
  groups multiple reviewers on the same line into a single row. Does not post,
  reply to, or modify anything on GitHub. Terminal output only.
---

# retrieve-pull-request-comments

Fetches all review comments from the current branch's PR using the GitHub CLI,
analyses them against the current diff and changed files, and renders a
structured severity-sorted table in the terminal.

This skill is read-only. It does not post comments, reactions, or replies to
GitHub. It does not modify any files. It does not make any mutating API calls.

---

## Phase 0 — Environment check

Verify the GitHub CLI is available and authenticated:

```bash
gh --version
gh auth status
```

If `gh` is not installed: stop — "The GitHub CLI is required. Install it from
https://cli.github.com and run `gh auth login`."

If not authenticated: stop — "Run `gh auth login` before using this skill."

Confirm the current directory is inside a git repo:

```bash
git rev-parse --show-toplevel
```

---

## Phase 1 — Detect the PR from the current branch

Never ask the user for a PR number. Always auto-detect from the current branch.

```bash
# Get current branch
git rev-parse --abbrev-ref HEAD

# Find the PR associated with this branch
gh pr view --json number,title,url,state,isDraft,author,baseRefName,headRefName \
  -q '"#\(.number) | \(.title) | \(.state) | \(.url)"'
```

If a PR is found, record: number, title, state, base branch, head branch,
PR author (to distinguish reviewer comments from the author's own comments).

If **no PR exists** for the current branch, stop immediately and output:

```
═══════════════════════════════════════════════════════
  No pull request found for branch: <branch_name>
  Create a PR first with: gh pr create
═══════════════════════════════════════════════════════
```

Do not attempt to guess or list other PRs. The user said this command is only
run when a valid PR is ready.

---

## Phase 2 — Fetch all comments

Fetch both inline review comments and PR-level conversation comments.

### Inline review comments (attached to specific files and lines)

```bash
gh api "repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments" \
  --paginate \
  --jq '.[] | {
    id: .id,
    type: "inline",
    author: .user.login,
    body: .body,
    path: .path,
    line: (.line // .original_line),
    original_line: .original_line,
    diff_hunk: .diff_hunk,
    created_at: .created_at,
    updated_at: .updated_at,
    in_reply_to_id: .in_reply_to_id,
    pull_request_review_id: .pull_request_review_id,
    position: .position,
    outdated: (if .position == null then true else false end)
  }'
```

`position` being `null` indicates the comment is outdated — the line it
referenced has since changed or been removed.

### PR-level conversation comments

```bash
gh api "repos/{owner}/{repo}/issues/<PR_NUMBER>/comments" \
  --paginate \
  --jq '.[] | {
    id: .id,
    type: "pr_level",
    author: .user.login,
    body: .body,
    path: "PR Conversation",
    line: null,
    created_at: .created_at,
    updated_at: .updated_at,
    in_reply_to_id: null
  }'
```

### Review-level summary comments (the top-level review body when a reviewer
submits a review with a summary message)

```bash
gh api "repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews" \
  --paginate \
  --jq '.[] | select(.body != "" and .body != null) | {
    id: .id,
    type: "review_summary",
    author: .user.login,
    body: .body,
    state: .state,
    path: "Review Summary",
    line: null,
    submitted_at: .submitted_at
  }'
```

### Reactions on comments

For each comment, fetch reactions to determine if the PR author has reacted:

```bash
gh api "repos/{owner}/{repo}/pulls/comments/<COMMENT_ID>/reactions" \
  --jq '[.[] | select(.user.login == "<PR_AUTHOR>") | .content]'
```

Do this for inline comments. For PR-level comments:

```bash
gh api "repos/{owner}/{repo}/issues/comments/<COMMENT_ID>/reactions" \
  --jq '[.[] | select(.user.login == "<PR_AUTHOR>") | .content]'
```

---

## Phase 3 — Build comment threads

Group comments into threads. A thread is either:
- A single top-level inline comment and all its replies (linked by
  `in_reply_to_id`)
- A single PR-level comment and all its replies
- A review summary comment (standalone)

For each thread, identify:
- **Root comment**: the first comment in the thread (no `in_reply_to_id`)
- **Replies**: all comments with `in_reply_to_id` pointing to the root or
  to another reply in the same chain
- **Authors in thread**: all distinct `author` logins who commented
- **PR author replies**: any reply in the thread where `author == PR_AUTHOR`
- **Reviewer last reply**: whether the most recent reply in the thread is
  from a reviewer (not the PR author) — indicates the ball is in the author's
  court

### Grouping by file:line

For inline comments, multiple threads on the same `path:line` combination
should be grouped into a single table row. Within that row, list all
distinct authors. This is what the user requested — do not split them into
separate rows.

For PR-level and review summary comments, each thread is its own row since
there is no file:line to group by.

---

## Phase 4 — Fetch the full diff and changed files

```bash
gh pr diff <PR_NUMBER>
gh pr diff <PR_NUMBER> --name-only
```

For each changed file, read the full current (head branch) version:

```bash
git show origin/<HEAD_BRANCH>:<FILE_PATH>
# fallback if not checked out:
gh api "repos/{owner}/{repo}/contents/<FILE_PATH>?ref=<HEAD_BRANCH>" \
  -q '.content' | base64 --decode
```

This is used in Phase 5 to determine whether each comment has been acted on.
Do not rely on the diff hunks alone — read the full file.

---

## Phase 5 — Determine per-thread status

For each thread, derive two status fields:

### A. Your Response

Determines whether the PR author has responded to or acknowledged the thread.

| Status | Condition |
|--------|-----------|
| ✅ Resolved | Thread is marked resolved on GitHub (`gh api .../pulls/<N>/reviews` or conversation state shows resolved) |
| 💬 Replied | PR author has written at least one reply in the thread |
| 👍 Reacted | PR author has reacted (e.g., +1, heart) to the root comment but written no reply |
| 🏓 Pending Reply | The most recent message in the thread is from a reviewer — the PR author has not responded to the latest message |
| 🔇 No Response | PR author has neither replied, reacted, nor resolved the thread |

Apply these in priority order: Resolved > Replied > Reacted > Pending Reply >
No Response. A thread marked Resolved on GitHub always shows ✅ Resolved
regardless of other signals.

### B. Implementation Status

Determines whether the code change requested or implied by the comment has
been made. Cross-reference the comment content against the full changed files
and diff.

| Status | Condition |
|--------|-----------|
| ✅ Implemented | The concern raised in the comment is addressed in the current diff. The relevant code has changed in a way that resolves it. |
| ⚠️ Partial | Some related change exists in the diff but does not fully address the comment. |
| ❌ Not Started | No related change found in the diff for the file and area referenced. |
| 🚫 Rejected | PR author explicitly disagreed with the comment in a reply and no change was made. |
| 📎 Outdated | The comment's `position` is null — the line it referenced no longer exists in the current diff. Treat as a separate signal rather than inferring implementation. |
| ❓ Needs Discussion | Unresolved back-and-forth in the thread with no clear conclusion and no code change. |

**How to determine implementation status:**

1. Identify the file and line the comment references
2. Read the full current version of that file
3. Look at the surrounding context (±20 lines of the original comment location)
4. Compare to the diff — did that area change?
5. If changed: does the change address what the comment described?
   - If yes and fully → ✅ Implemented
   - If yes but partially → ⚠️ Partial
6. If not changed → check the thread for a rejection reply → 🚫 Rejected or
   ❌ Not Started
7. If the comment position is null (outdated) → 📎 Outdated
8. If the thread has unresolved back-and-forth → ❓ Needs Discussion

For PR-level and review summary comments that do not reference a specific line,
use the thread reply history and the overall diff to infer status. If the
comment describes a broad concern (e.g., "the overall architecture feels wrong")
and no structural change is visible in the diff, mark ❌ Not Started.

---

## Phase 6 — Infer severity

PR comments do not carry explicit severity labels. Infer severity from the
comment body text. When in doubt, err on the side of higher severity — it is
better to over-flag than to miss a blocking issue.

### 🔴 Blocking

Mark Blocking if the comment contains any of:
- Words: `bug`, `broken`, `incorrect`, `wrong`, `crash`, `fail`, `error`,
  `exception`, `race condition`, `deadlock`, `security`, `vulnerability`,
  `unsafe`, `data loss`, `corrupt`, `never`, `always`, `must`, `critical`,
  `blocks`, `blocker`, `required`, `cannot merge`, `do not merge`
- Description of incorrect behaviour, a defect, or a contract violation
- A security or data integrity concern of any kind
- A statement that the PR should not be merged as-is

### 🟠 Should-fix

Mark Should-fix if the comment contains:
- Words: `should`, `better`, `prefer`, `refactor`, `clean`, `smell`,
  `duplicate`, `naming`, `rename`, `structure`, `missing test`, `no test`,
  `coverage`, `performance`, `inefficient`, `n+1`, `unnecessary`
- Design concerns, structural feedback, naming issues, missing tests,
  significant code smells
- Anything that does not rise to a defect but clearly indicates the code
  needs improvement before it should be considered complete

### 🟡 Suggestion

Mark Suggestion if the comment:
- Uses words like `nit`, `optional`, `minor`, `style`, `consider`,
  `might`, `could`, `personal preference`, `up to you`
- Is phrased as a question without an implied correction
- Is purely stylistic with no functional implication

### Ambiguous comments

If a comment does not clearly fall into any tier, default to 🟠 Should-fix.
Do not default to 🟡 Suggestion — erring toward lower severity risks burying
a real issue.

---

## Phase 7 — Compose the summary line

Before the table, print a single summary line:

```
<N> comments from <N> reviewers — 🔴 <N> blocking  🟠 <N> should-fix  🟡 <N> suggestions
— ✅ <N> implemented  ⚠️ <N> partial  ❌ <N> not started  🚫 <N> rejected  📎 <N> outdated  ❓ <N> needs discussion
```

Count comment threads, not individual comment messages. A 5-message thread
is 1 comment for counting purposes.

---

## Phase 8 — Render the table

### Table columns (in this order):

```
# | Author(s) | File : Line | Comment Summary | Severity | Implementation | Your Response
```

- **#** — sequential row number
- **Author(s)** — all distinct reviewer logins who commented on this
  file:line, comma-separated. Exclude the PR author from this column.
- **File : Line** — relative file path and line number. For PR-level comments
  use `PR Conversation`. For review summaries use `Review Summary`.
  For outdated inline comments, append `†` to the line number (e.g., `42†`)
  to signal the line no longer exists.
- **Comment Summary** — a concise 1–2 sentence summary of what the reviewer
  said, written in your own words. Do not quote verbatim. Capture the
  substance of the concern. If multiple reviewers commented on the same
  line with different concerns, summarise each concern separated by ` / `.
- **Severity** — 🔴 Blocking / 🟠 Should-fix / 🟡 Suggestion. If multiple
  reviewers on the same row have different severity inferences, show the
  highest severity for the row.
- **Implementation** — ✅ Implemented / ⚠️ Partial / ❌ Not Started /
  🚫 Rejected / 📎 Outdated / ❓ Needs Discussion
- **Your Response** — ✅ Resolved / 💬 Replied / 👍 Reacted /
  🏓 Pending Reply / 🔇 No Response

### Sort order

Sort rows by severity descending: 🔴 first, then 🟠, then 🟡.

Within the same severity tier, sort by file path alphabetically, then by
line number ascending.

PR-level and review summary rows appear at the top of their severity tier,
before inline comments.

### Table format

Render as a plain ASCII table that fits cleanly in a standard 120-character
terminal. Truncate long file paths from the left (e.g.,
`…/services/ingest.py`) and long comment summaries from the right with `…`
if they exceed column width. Full comment text is available via the detail
view described below.

Example format:

```
 #  Author(s)          File : Line                   Comment Summary                          Severity   Implementation   Your Response
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 1  alice               services/ingest.py : 42       Bare except swallows all errors —        🔴          ❌ Not Started   🔇 No Response
                                                       should catch specific exception types
 2  bob, alice          api/handlers.py : 118         get_user() mutates state despite          🟠          ✅ Implemented   💬 Replied
                                                       name implying a read
 3  alice               PR Conversation               Overall retry logic needs backoff,        🟠          ⚠️ Partial       🏓 Pending Reply
                                                       currently retries immediately
 4  bob                 utils/auth.py : 77†           Token expiry not checked — comment        📎          📎 Outdated      👍 Reacted
                                                       is outdated, line no longer exists
 5  carol               Review Summary                Good structure overall but missing        🟡          ❌ Not Started   🔇 No Response
                                                       tests for the error path
```

`†` on the line number = outdated comment (line no longer in current diff).

---

## Phase 9 — Full comment detail block

After the table, print the full text of every comment thread in the same
sorted order as the table. This gives the user access to the complete
reviewer message without having to open GitHub.

Format for each entry:

```
──────────────────────────────────────────────────────────────────
 #1 — alice  |  services/ingest.py : 42  |  🔴 Blocking  |  ❌ Not Started  |  🔇 No Response
──────────────────────────────────────────────────────────────────
[alice] Bare except here will swallow KeyboardInterrupt and
SystemExit. You should catch the specific exception type you
expect, e.g. ValueError or requests.HTTPError.

  ↳ No reply from PR author.
──────────────────────────────────────────────────────────────────
 #2 — bob, alice  |  api/handlers.py : 118  |  🟠 Should-fix  |  ✅ Implemented  |  💬 Replied
──────────────────────────────────────────────────────────────────
[bob] Function is named get_user but it updates the last_seen
timestamp as a side effect. This violates the principle of least
surprise — either rename it or split the mutation out.

[alice] Agreed with bob, this tripped me up when reading the code.

  ↳ [you] Fixed — split the mutation into a separate update_last_seen()
    call in the controller. get_user() is now read-only.
──────────────────────────────────────────────────────────────────
```

Conventions:
- `[author]` prefix for each distinct message in the thread
- `↳` prefix for PR author replies
- If the thread has no reply from the PR author, write `↳ No reply from PR
  author.`
- If the comment is outdated, prepend: `⚠️  This comment is outdated — the
  referenced line no longer exists in the current diff.`
- If the thread is resolved on GitHub, append: `✅ Marked as resolved on
  GitHub.`

---

## Phase 10 — Report header

Print this before the summary line and table:

```
═══════════════════════════════════════════════════════════════
  PR COMMENT REVIEW — #<NUMBER>: <TITLE>
  Author  : <pr_author>
  Branch  : <headRefName> → <baseRefName>
  Repo    : <owner>/<repo>
  State   : <OPEN|DRAFT|MERGED>
  Reviewers: <comma-separated list of all distinct comment authors>
═══════════════════════════════════════════════════════════════
```

---

## Edge cases

**No comments on the PR**: Output the header, then:
```
No review comments found on this PR.
```

**PR author commenting on their own PR**: Exclude these from the table
entirely. The table is for reviewer feedback only. The PR author's own
comments only appear as replies (the `↳` lines) in the detail block.

**Bot comments** (authors ending in `[bot]` or known bot logins such as
`github-actions[bot]`, `dependabot[bot]`, `codecov[bot]`): Exclude from
the table by default. Note in the header: "N bot comment(s) excluded."

**Resolved threads**: Include in the table with ✅ Resolved in the
Your Response column. Do not hide them — the user wants the full picture.

**Outdated comments with replies**: If a thread is outdated but has
subsequent discussion, include the full thread in the detail block.
Mark the row with `†` and 📎 Outdated in the Implementation column.

**Multiple reviewers on the same line with conflicting severity**: Use the
highest severity for the row. Summarise both concerns in the Comment Summary
column separated by ` / `.

**Very long PR with many comments (>30 threads)**: Render the full table
and full detail block. Do not truncate or paginate — the terminal can scroll.

**Draft PR**: Note `[DRAFT]` in the State field of the header. Fetch and
display all comments normally.

**Merged PR**: Note `[MERGED]` in the State field. Fetch and display all
comments normally — post-merge review is valid.

**Pagination**: Always use `--paginate` on all `gh api` calls that return
lists. PRs with many comments will exceed the default page size.

**Rate limiting**: If any `gh api` call returns a rate limit error, surface
it clearly:
```
⚠️  GitHub API rate limit hit. Wait a few minutes and retry,
    or authenticate with a token with higher limits: gh auth login
```

**No local checkout for file reading**: If `git show` fails, fall back to
the GitHub API for file content. Note in the output:
```
ℹ️  Reading files via GitHub API (local branch not checked out).
    Implementation status accuracy may be reduced.
```
