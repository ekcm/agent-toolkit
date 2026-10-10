import type { EngineInterface, Register } from 'claude-code'
import { READER_SCRIPT } from './reader'
import { formatStatus, parseChecks, parseCodexLine, parseCodexLive, parseThreads, type StatusData, type Window } from './format'

type $ = EngineInterface

// gh and the Codex logs are slow or unchanging between turns, so they are
// read at the end of each turn and once a minute, never on every redraw.
const REFRESH_MS = 60_000

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

const data: StatusData = { repo: null, branch: null, pr: undefined, context: null, claude: null, codex: null }
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

async function readGit($: $, cwd: string) {
  const root = await run($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
  data.repo = root ? root.split('/').pop() ?? root : null
  data.branch = root
    ? (await run($, ['git', '-C', cwd, 'symbolic-ref', '--short', 'HEAD'])) ?? await run($, ['git', '-C', cwd, 'rev-parse', '--short', 'HEAD'])
    : null
}

// Leaves the PR unknown (undefined) when gh is missing, logged out or offline,
// so the line drops the PR part instead of claiming there is none.
async function readPr($: $, cwd: string) {
  if (!data.repo || !data.branch) {
    data.pr = undefined
    return
  }
  const result = await $.process.run(['gh', 'pr', 'view', '--json', 'number,statusCheckRollup'], { cwd, timeoutMs: 20_000 }).catch(() => null)
  if (!result) {
    data.pr = undefined
    return
  }
  if (result.exitCode !== 0) {
    data.pr = /no pull requests found/i.test(result.stderr) ? null : undefined
    return
  }
  const view = JSON.parse(result.stdout) as { number: number; statusCheckRollup?: unknown }
  const threads = await run($, ['gh', 'api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `pr=${view.number}`, '-f', `query=${THREADS_QUERY}`], cwd)
  data.pr = { number: view.number, checks: parseChecks(view.statusCheckRollup), threads: threads ? parseThreads(JSON.parse(threads)) : null }
}

async function readCodex($: $) {
  const live = await run($, ['sh', '-c', CODEX_LIVE_SCRIPT])
  const fromLive = live ? parseCodexLive(live) : null
  if (fromLive) {
    data.codex = fromLive
    return
  }
  const home = (await $.env.get('CODEX_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.codex`
  const line = await run($, ['sh', '-c', CODEX_LOG_SCRIPT, 'sh', home])
  data.codex = line ? parseCodexLine(line) : null
}

async function refresh($: $) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const cwd = await $.session.cwd()
    await readGit($, cwd)
    await Promise.all([readPr($, cwd).catch(() => { data.pr = undefined }), readCodex($)])
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
    // Lines of sessions that ended without cleaning up (a crash, a kill).
    await run($, ['find', dir, '-name', '*.txt', '-mtime', '+1', '-delete'])
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
    await run($, ['rm', '-f', `${await linesDir($)}/${e.sessionId}.txt`])
    return next(e)
  })
}
