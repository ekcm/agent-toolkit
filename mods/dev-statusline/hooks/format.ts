// Pure parsing and formatting for the status line, kept apart from the hooks
// so it can be tested without a session.

// Segments in the context gauge.
const GAUGE_WIDTH = 10

export type Checks = { passing: number; failing: number; running: number }
export type Threads = { resolved: number; total: number }
export type Pr = { number: number; checks: Checks; threads: Threads | null }

// A rate-limit window: percent used and when it resets (ms since epoch).
export type Window = { percentUsed: number; resetsAt: number | null }

export type StatusData = {
  // The project: the main repository's folder name, also inside a worktree.
  repo: string | null
  // The linked worktree's folder name; null in the main checkout.
  worktree?: string | null
  // The branch, or the short commit when the checkout is detached.
  branch: string | null
  isDetached?: boolean
  // undefined: not looked up yet (or gh unavailable); null: no PR for the branch.
  pr: Pr | null | undefined
  context: { tokens?: number; percent?: number; window: number } | null
  claude: Window | null
  codex: Window | null
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const SKIPPED = new Set(['SKIPPED', 'NEUTRAL', 'STALE'])

// Reads `gh pr view --json statusCheckRollup`: check runs carry status and
// conclusion, commit statuses carry state.
export function parseChecks(rollup: unknown): Checks {
  const checks: Checks = { passing: 0, failing: 0, running: 0 }
  if (!Array.isArray(rollup)) return checks
  for (const item of rollup as { status?: string; conclusion?: string; state?: string }[]) {
    if (item.state !== undefined) {
      if (item.state === 'SUCCESS') checks.passing += 1
      else if (FAILED.has(item.state)) checks.failing += 1
      else checks.running += 1
    } else if (item.status !== 'COMPLETED') checks.running += 1
    else if (FAILED.has(item.conclusion ?? '')) checks.failing += 1
    else if (!SKIPPED.has(item.conclusion ?? '')) checks.passing += 1
  }
  return checks
}

// Reads the GraphQL answer for a PR's review threads.
export function parseThreads(answer: unknown): Threads | null {
  const threads = (answer as { data?: { repository?: { pullRequest?: { reviewThreads?: { totalCount?: number; nodes?: { isResolved?: boolean }[] } } } } })
    ?.data?.repository?.pullRequest?.reviewThreads
  if (!threads || typeof threads.totalCount !== 'number' || !Array.isArray(threads.nodes)) return null
  return { resolved: threads.nodes.filter(n => n.isResolved).length, total: threads.totalCount }
}

// Reads the last Codex `token_count` line that carries rate limits; the
// primary window is the 5-hour one.
export function parseCodexLine(line: string): Window | null {
  try {
    const event = JSON.parse(line) as { payload?: { rate_limits?: { primary?: { used_percent?: number; resets_at?: number } } } }
    const primary = event.payload?.rate_limits?.primary
    if (!primary || typeof primary.used_percent !== 'number') return null
    return { percentUsed: primary.used_percent, resetsAt: typeof primary.resets_at === 'number' ? primary.resets_at * 1000 : null }
  } catch {
    return null
  }
}

// Reads the app server's answer to account/rateLimits/read; the primary
// window is the 5-hour one.
export function parseCodexLive(line: string): Window | null {
  try {
    const answer = JSON.parse(line) as { result?: { rateLimits?: { primary?: { usedPercent?: number; resetsAt?: number } } } }
    const primary = answer.result?.rateLimits?.primary
    if (!primary || typeof primary.usedPercent !== 'number') return null
    return { percentUsed: primary.usedPercent, resetsAt: typeof primary.resetsAt === 'number' ? primary.resetsAt * 1000 : null }
  } catch {
    return null
  }
}

// Terminal colour codes. Green, yellow and red are the terminal's own, so
// they follow its theme; the brand colours need a terminal with 24-bit colour
// (most current ones). `repo` is bold in a darker Claude orange.
export const COLORS = {
  good: '32',
  warn: '33',
  bad: '31',
  claude: '38;2;215;119;87',
  codex: '38;2;180;160;255',
  repo: '1;38;2;193;95;60',
  dim: '2',
} as const

// Below this share left, a 5-hour figure is bold and underlined as well.
export const LOW_LEFT = 10

// `extra` adds styles to the colour, such as '1;4' for bold and underlined.
export function paint(color: keyof typeof COLORS, text: string, extra = ''): string {
  if (!text) return ''
  return `\x1b[${extra ? `${extra};` : ''}${COLORS[color]}m${text}\x1b[0m`
}

// Parts are joined by a dim dot, so they read apart without competing.
const SEPARATOR = ` ${paint('dim', '·')} `

// Removes colour codes, for tests and for anything that needs the plain text.
export function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function checksText(checks: Checks): string {
  if (checks.failing) return paint('bad', `✗ ${checks.failing} failing`)
  if (checks.running) return paint('warn', `◷ ${checks.running} running`)
  if (checks.passing) return paint('good', '✓ checks')
  return paint('dim', 'no checks')
}

// All resolved is good, some is a warning, none is bad.
function threadsText(threads: Threads | null): string | null {
  if (!threads) return null
  if (!threads.total) return paint('dim', 'no threads')
  const color = threads.resolved === threads.total ? 'good' : threads.resolved ? 'warn' : 'bad'
  return paint(color, `${threads.resolved}/${threads.total} resolved`)
}

export function prText(pr: Pr | null | undefined): string | null {
  if (pr === undefined) return null
  if (pr === null) return paint('dim', 'no PR')
  // No PR number: Claude Code's own line under the prompt already shows it.
  return [checksText(pr.checks), threadsText(pr.threads)].filter(Boolean).join(SEPARATOR)
}

// 950 → 950, 222_345 → 222k, 1_000_000 → 1M, 1_250_000 → 1.3M.
export function tokensText(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

// A gauge of the context window used: the used segments and the share in
// Claude orange, the free segments and 60k/200k plain.
function contextText(context: StatusData['context']): string {
  if (!context || !context.window) return `ctx ${paint('dim', '—')}`
  const tokens = context.tokens ?? 0
  const used = Math.max(0, Math.min(100, Math.round(context.percent ?? (tokens / context.window) * 100)))
  // Rounded down, so the gauge is full only when the window is.
  const filled = Math.floor((used / 100) * GAUGE_WIDTH)
  const gauge = `${paint('claude', '▰'.repeat(filled))}${'▱'.repeat(GAUGE_WIDTH - filled)}`
  return `ctx ${gauge} ${paint('claude', `${used}%`)} ${tokensText(tokens)}/${tokensText(context.window)}`
}

function untilText(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000))
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

// `claude 5h 37%` in the agent's colour, then `left (3h20m)` plain. Below
// LOW_LEFT the share is bold and underlined too.
function windowText(agent: 'claude' | 'codex', window: Window | null, now: number): string {
  if (!window) return `${paint(agent, `${agent} 5h`)} ${paint('dim', '—')}`
  // A window that has reset since it was read is whole again.
  if (window.resetsAt !== null && window.resetsAt <= now) return `${paint(agent, `${agent} 5h 100%`)} left`
  const left = Math.max(0, Math.round(100 - window.percentUsed))
  const reset = window.resetsAt !== null ? ` (${untilText(window.resetsAt, now)})` : ''
  return `${paint(agent, `${agent} 5h`)} ${paint(agent, `${left}%`, left < LOW_LEFT ? '1;4' : '')} left${reset}`
}

export function formatStatus(data: StatusData, now: number): string {
  const head = data.isDetached ? `detached ${data.branch}` : data.branch
  const branch = head ? ` ${paint('dim', '(')}${head}${paint('dim', ')')}` : ''
  const worktree = data.worktree ? paint('dim', `/${data.worktree}`) : ''
  const where = data.repo ? `${paint('repo', data.repo)}${worktree}${branch}` : null
  const first = [where, data.repo ? prText(data.pr) : null].filter(Boolean).join(SEPARATOR)
  const second = [contextText(data.context), windowText('claude', data.claude, now), windowText('codex', data.codex, now)].join(SEPARATOR)
  return first ? `${first}\n${second}` : second
}

export type Worktree = { path: string; head: string | null; branch: string | null }

// Reads `git worktree list --porcelain`: a `worktree <path>` line opens each
// entry, `HEAD <sha>` gives its commit, and `branch refs/heads/<name>` names
// its branch unless detached.
export function parseWorktrees(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = []
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) worktrees.push({ path: line.slice('worktree '.length), head: null, branch: null })
    else if (line.startsWith('HEAD ') && worktrees.length) worktrees[worktrees.length - 1]!.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch refs/heads/') && worktrees.length) worktrees[worktrees.length - 1]!.branch = line.slice('branch refs/heads/'.length)
  }
  return worktrees
}

type OpenPrNode = {
  number?: number
  headRefName?: string
  headRefOid?: string
  reviewThreads?: { totalCount?: number; nodes?: { isResolved?: boolean }[] }
  commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: unknown[] } } | null } }[] }
}

// Reads the GraphQL answer listing a repository's open PRs, each with its
// checks and review threads, keyed by branch and by head commit (for detached
// checkouts, which have no branch to go by).
export function parseOpenPrs(answer: unknown): { byBranch: Map<string, Pr>; byCommit: Map<string, Pr> } {
  const byBranch = new Map<string, Pr>()
  const byCommit = new Map<string, Pr>()
  const nodes = (answer as { data?: { repository?: { pullRequests?: { nodes?: OpenPrNode[] } } } })?.data?.repository?.pullRequests?.nodes
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (typeof node.number !== 'number' || !node.headRefName) continue
    const threads = node.reviewThreads
    const pr: Pr = {
      number: node.number,
      checks: parseChecks(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []),
      threads: threads && typeof threads.totalCount === 'number' && Array.isArray(threads.nodes)
        ? { resolved: threads.nodes.filter(n => n.isResolved).length, total: threads.totalCount }
        : null,
    }
    byBranch.set(node.headRefName, pr)
    if (node.headRefOid) byCommit.set(node.headRefOid, pr)
  }
  return { byBranch, byCommit }
}

// The name a worktree's row goes by: its folder, or for a folder named just
// `worktree` (as pr-review-board's are, under pr-<n>/) the folder above it.
export function worktreeName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? path
  return last === 'worktree' && parts.length > 1 ? parts[parts.length - 2]! : last
}
