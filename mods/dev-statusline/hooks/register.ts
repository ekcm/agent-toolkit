import type { EngineInterface, Register } from 'claude-code'
import { READER_SCRIPT, SUBAGENT_SCRIPT } from './reader'
import {
  formatStatus, parseChecks, parseCodexLine, parseCodexLive, parseOpenPrs, parseThreads, parseWorktrees, prText, worktreeName,
  type StatusData, type Window,
} from './format'

type $ = EngineInterface

// gh and the Codex logs are slow or unchanging between turns, so they are
// read at the end of each turn and once a minute, never on every redraw.
const REFRESH_MS = 60_000

// Every open PR of the repository with its checks and review threads, for the
// subagent rows of the repo's other worktrees.
const OPEN_PRS_QUERY = 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number headRefName headRefOid reviewThreads(first: 100) { totalCount nodes { isResolved } } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } } } } } }'

// One Codex reading serves every session for this long, so several open
// sessions don't each start a Codex app server every minute.
const CODEX_SHARED_MS = 55_000

const THREADS_QUERY = 'query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100) { totalCount nodes { isResolved } } } } }'

// Asks a short-lived Codex app server for the account's live rate limits,
// which spends no tokens. The server quits when its input closes, before it
// answers, so the input is held open until the answer comes, then the server
// is stopped.
const CODEX_LIVE_SCRIPT = `
d=$(mktemp -d) || exit 1
trap 'exec 3>&-; kill "$pid" 2>/dev/null; rm -rf "$d"' EXIT
mkfifo "$d/in"
codex app-server < "$d/in" > "$d/out" 2>/dev/null &
pid=$!
exec 3> "$d/in"
printf '%s\\n' '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"dev-statusline","version":"1"}}}' '{"method":"initialized"}' '{"id":2,"method":"account/rateLimits/read"}' >&3
i=0
while [ "$i" -lt 100 ] && ! grep -q '"id":2' "$d/out"; do sleep 0.1; i=$((i + 1)); done
grep -m 1 '"id":2' "$d/out"`

// The fallback when the live query fails (an older Codex, no network): the
// newest session logs, newest first; the first token_count line with rate
// limits in any of them is the latest reading Codex wrote down.
const CODEX_LOG_SCRIPT = `
for f in $(ls -t "$1"/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -5); do
  line=$(tail -c 4000000 "$f" | grep '"rate_limits":{' | tail -1)
  if [ -n "$line" ]; then printf '%s\\n' "$line"; exit 0; fi
done`

const data: StatusData = { repo: null, worktree: null, branch: null, isDetached: false, pr: undefined, context: null, claude: null, codex: null }
let ticker: { cancel: () => void } | null = null
let isRefreshing = false

async function run($: $, argv: string[], cwd?: string): Promise<string | null> {
  try {
    const result = await $.process.run(argv, { cwd, timeoutMs: 20_000 })
    return result.exitCode === 0 ? result.stdout.trim() : null
  } catch {
    return null
  }
}

// ~/.agent-toolkit/dev-statusline: the reader script and one file of lines
// per session, named by the session's id.
async function linesDir($: $): Promise<string> {
  return `${(await $.env.get('HOME')) ?? ''}/.agent-toolkit/dev-statusline`
}

// Writes the latest lines for the status line to print. The id is read each
// time, since /clear goes on under a new one.
async function show($: $) {
  const text = formatStatus(data, await $.clock.now())
  await $.fs.write(`${await linesDir($)}/${await $.session.id()}.txt`, `${text}\n`)
}

// The project is named after the folder holding the shared .git, so a linked
// worktree still shows as its repository; git's own directory differing from
// the shared one is what marks a linked worktree.
async function readGit($: $, cwd: string) {
  const paths = await run($, ['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  const [top, gitDir, commonDir] = paths ? paths.split('\n') : []
  if (!top || !gitDir || !commonDir) {
    Object.assign(data, { repo: null, worktree: null, branch: null, isDetached: false })
    return
  }
  data.repo = commonDir.endsWith('/.git') ? worktreeName(commonDir.slice(0, -'/.git'.length)) : worktreeName(commonDir).replace(/\.git$/, '')
  data.worktree = gitDir === commonDir ? null : worktreeName(top)
  const branch = await run($, ['git', '-C', cwd, 'symbolic-ref', '--short', 'HEAD'])
  data.isDetached = !branch
  data.branch = branch ?? await run($, ['git', '-C', cwd, 'rev-parse', '--short', 'HEAD'])
}

// Leaves the PR unknown (undefined) when gh is missing, logged out or offline,
// so the line drops the PR part instead of claiming there is none. A detached
// checkout has no branch to look up, so its PR is the open one containing its
// commit (how pr-review-board's review checkouts find theirs).
async function readPr($: $, cwd: string) {
  if (!data.repo || !data.branch) {
    data.pr = undefined
    return
  }
  let view: { number: number; statusCheckRollup?: unknown } | null
  if (data.isDetached) {
    const sha = await run($, ['git', '-C', cwd, 'rev-parse', 'HEAD'])
    const found = sha ? await run($, ['gh', 'pr', 'list', '--state', 'open', '--search', sha, '--json', 'number,statusCheckRollup'], cwd) : null
    if (found === null) {
      data.pr = undefined
      return
    }
    view = (JSON.parse(found) as { number: number; statusCheckRollup?: unknown }[])[0] ?? null
  } else {
    const result = await $.process.run(['gh', 'pr', 'view', '--json', 'number,statusCheckRollup'], { cwd, timeoutMs: 20_000 }).catch(() => null)
    if (!result || (result.exitCode !== 0 && !/no pull requests found/i.test(result.stderr))) {
      data.pr = undefined
      return
    }
    view = result.exitCode === 0 ? JSON.parse(result.stdout) as { number: number; statusCheckRollup?: unknown } : null
  }
  if (!view) {
    data.pr = null
    return
  }
  const threads = await run($, ['gh', 'api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `pr=${view.number}`, '-f', `query=${THREADS_QUERY}`], cwd)
  data.pr = { number: view.number, checks: parseChecks(view.statusCheckRollup), threads: threads ? parseThreads(JSON.parse(threads)) : null }
}

// Writes, for the subagent rows, each of the repository's worktrees with its
// name and its PR's state, keyed by path. A detached worktree's PR is the one
// whose head is its commit; with none, its PR is left unknown rather than
// "no PR", since its commit may sit inside a PR that has moved on. With only
// one worktree there are no other worktrees to describe, so gh isn't asked.
async function writeWorktrees($: $, cwd: string) {
  const file = `${await linesDir($)}/${await $.session.id()}.worktrees.json`
  const porcelain = data.repo ? await run($, ['git', '-C', cwd, 'worktree', 'list', '--porcelain']) : null
  const worktrees = porcelain ? parseWorktrees(porcelain) : []
  const rows: Record<string, { name: string; pr: string }> = {}
  if (worktrees.length > 1) {
    const answer = await run($, ['gh', 'api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${OPEN_PRS_QUERY}`], cwd)
    const prs = answer ? parseOpenPrs(JSON.parse(answer)) : null
    for (const worktree of worktrees) {
      const pr = !prs ? undefined
        : worktree.branch ? prs.byBranch.get(worktree.branch) ?? null
        : worktree.head ? prs.byCommit.get(worktree.head)
        : undefined
      rows[worktree.path] = { name: worktreeName(worktree.path), pr: prText(pr) ?? '' }
    }
  }
  await $.fs.write(file, JSON.stringify(rows))
}

// Reuses another session's reading when it is fresh, else asks Codex live,
// falling back to its session logs, and shares what it found.
async function readCodex($: $) {
  const shared = `${await linesDir($)}/codex.json`
  const now = await $.clock.now()
  try {
    const saved = JSON.parse(await $.fs.read(shared)) as { at: number; codex: Window | null }
    if (now - saved.at < CODEX_SHARED_MS) {
      data.codex = saved.codex
      return
    }
  } catch {
    // No reading yet, or an unreadable one: ask Codex.
  }
  const live = await run($, ['sh', '-c', CODEX_LIVE_SCRIPT])
  let codex = live ? parseCodexLive(live) : null
  if (!codex) {
    const home = (await $.env.get('CODEX_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.codex`
    const line = await run($, ['sh', '-c', CODEX_LOG_SCRIPT, 'sh', home])
    codex = line ? parseCodexLine(line) : null
  }
  data.codex = codex
  await $.fs.write(shared, JSON.stringify({ at: now, codex }))
}

async function refresh($: $) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const cwd = await $.session.cwd()
    await readGit($, cwd)
    await Promise.all([
      readPr($, cwd).catch(() => { data.pr = undefined }),
      readCodex($),
      writeWorktrees($, cwd).catch(() => undefined),
    ])
  } finally {
    isRefreshing = false
  }
  await show($)
}

function claudeWindow(limits: { kind: string; percentUsed: number; resetsAt?: string }[]): Window | null {
  const five = limits.find(limit => limit.kind === 'five_hour')
  return five ? { percentUsed: five.percentUsed, resetsAt: five.resetsAt ? Date.parse(five.resetsAt) : null } : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Clears a notice pinned by 0.1.0, which drew the line with $.ui.status.
    $.ui.status(undefined)
    const dir = await linesDir($)
    await $.fs.write(`${dir}/statusline.sh`, READER_SCRIPT)
    await $.fs.write(`${dir}/subagents.sh`, SUBAGENT_SCRIPT)
    // Files of sessions that ended without cleaning up (a crash, a kill).
    await run($, ['find', dir, '(', '-name', '*.txt', '-o', '-name', '*.worktrees.json', ')', '-mtime', '+1', '-delete'])
    const usage = await $.session.usage()
    data.context = usage.context
    data.claude = claudeWindow(usage.rateLimits)
    await show($)
    void refresh($)
    ticker?.cancel()
    ticker = $.clock.every(REFRESH_MS, () => void refresh($))
    return next(e)
  })

  // Context and the Claude window come pushed from the engine after each turn.
  on('session.measure', async ($, e, next) => {
    data.context = e.context
    data.claude = claudeWindow(e.rateLimits)
    await show($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = null
    const dir = await linesDir($)
    await run($, ['rm', '-f', `${dir}/${e.sessionId}.txt`, `${dir}/${e.sessionId}.worktrees.json`])
    return next(e)
  })
}
