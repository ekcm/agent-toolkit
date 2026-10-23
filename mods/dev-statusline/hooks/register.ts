import type { EngineInterface, Register } from 'claude-code'
import { READER_SCRIPT, SUBAGENT_SCRIPT } from './reader'
import {
  activityText, agentsText, formatStatus, parseChecks, parseCodexLine, parseCodexLive, parseOpenPrs, parseThreads, parseWorktrees, prText, worktreeName,
  type AgentActivity, type StatusData, type Window,
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

// Agent activity changes with every tool call, so it is written at most this
// often; the agents line is redrawn this often while any agent is about, so
// an idle one shows as idle without waiting for a turn to end.
const AGENTS_WRITE_MS = 500
const AGENTS_TICK_MS = 15_000

// An agent that ended this long ago is dropped from the file.
const AGENTS_KEEP_MS = 10 * 60_000

const data: StatusData = { repo: null, worktree: null, branch: null, isDetached: false, pr: undefined, context: null, claude: null, codex: null }
let ticker: { cancel: () => void } | null = null
let agentsTicker: { cancel: () => void } | null = null
let isRefreshing = false

// Every subagent's activity by agent id, and its tool calls in flight (an
// agent can run several at once).
let agents: Record<string, AgentActivity> = {}
const toolsInFlight = new Map<string, number>()
let isAgentsWritePending = false

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

function agentsFile(dir: string, sessionId: string): string {
  return `${dir}/${sessionId}.agents.json`
}

// Writes every subagent's activity for the row script, with each one's
// parent from the engine's own list, and sums them up for the agents line.
async function writeAgents($: $) {
  isAgentsWritePending = false
  const now = await $.clock.now()
  const list = await $.agent.list().catch(() => null)
  if (list) {
    for (const info of list) {
      const seen = agents[info.id] ?? (agents[info.id] = { phase: null, since: now })
      if (info.parentId) seen.parent = info.parentId
    }
    const listed = new Set(list.map(info => info.id))
    agents = Object.fromEntries(Object.entries(agents).filter(([id, seen]) => listed.has(id) || !seen.endedAt || now - seen.endedAt < AGENTS_KEEP_MS))
  }
  data.agents = list ? agentsText(list, agents, now) : null
  await $.fs.write(agentsFile(await linesDir($), await $.session.id()), JSON.stringify(agents))
  await show($)
}

function scheduleAgentsWrite($: $) {
  if (isAgentsWritePending) return
  isAgentsWritePending = true
  try {
    $.clock.after(AGENTS_WRITE_MS, () => void writeAgents($).catch(() => { isAgentsWritePending = false }))
  } catch {
    isAgentsWritePending = false
  }
}

// Never throws: it runs inside every subagent's tool calls and model
// requests, which must go on whatever happens to the row.
async function mark($: $, agentId: string, change: Partial<AgentActivity>) {
  try {
    const now = await $.clock.now()
    agents[agentId] = { phase: null, ...agents[agentId], since: now, ...change }
    scheduleAgentsWrite($)
  } catch {
    // The row stays as it was.
  }
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
    await run($, ['find', dir, '(', '-name', '*.txt', '-o', '-name', '*.worktrees.json', '-o', '-name', '*.agents.json', ')', '-mtime', '+1', '-delete'])
    // A reload starts the module over: pick up what it last wrote.
    try {
      agents = JSON.parse(await $.fs.read(agentsFile(dir, await $.session.id()))) as Record<string, AgentActivity>
    } catch {
      agents = {}
    }
    const usage = await $.session.usage()
    data.context = usage.context
    data.claude = claudeWindow(usage.rateLimits)
    await show($)
    void refresh($)
    ticker?.cancel()
    ticker = $.clock.every(REFRESH_MS, () => void refresh($))
    agentsTicker?.cancel()
    agentsTicker = $.clock.every(AGENTS_TICK_MS, () => {
      if (Object.keys(agents).length) scheduleAgentsWrite($)
    })
    return next(e)
  })

  // A subagent's model request: it is thinking until the response is in.
  // Tools can start while the response is still streaming in, so a tool call
  // in flight outranks thinking at either end.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    const agentId = e.agentId
    if (!toolsInFlight.get(agentId)) await mark($, agentId, { phase: 'thinking', activity: undefined, endedAt: undefined })
    try {
      return yield* next(e)
    } finally {
      if (!toolsInFlight.get(agentId)) await mark($, agentId, { phase: null })
    }
  })

  // A subagent's tool call: what it runs, until the last call in flight ends.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const agentId = e.agentId
    toolsInFlight.set(agentId, (toolsInFlight.get(agentId) ?? 0) + 1)
    await mark($, agentId, { phase: 'tool', activity: activityText(e.tool, e as unknown as Record<string, unknown>) })
    try {
      return await next(e)
    } finally {
      const left = (toolsInFlight.get(agentId) ?? 1) - 1
      toolsInFlight.set(agentId, left)
      if (!left) await mark($, agentId, { phase: null, activity: undefined })
    }
  })

  // Context and the Claude window come pushed from the engine after each turn.
  on('session.measure', async ($, e, next) => {
    data.context = e.context
    data.claude = claudeWindow(e.rateLimits)
    await show($)
    return next(e)
  })

  // The main session's turns refresh the line; a subagent's turn ending is
  // only noted, since its row says how long it took.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await mark($, e.agentId, { phase: null, activity: undefined, endedAt: await $.clock.now() })
    else void refresh($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = null
    agentsTicker?.cancel()
    agentsTicker = null
    const dir = await linesDir($)
    await run($, ['rm', '-f', `${dir}/${e.sessionId}.txt`, `${dir}/${e.sessionId}.worktrees.json`, agentsFile(dir, e.sessionId)])
    return next(e)
  })
}
