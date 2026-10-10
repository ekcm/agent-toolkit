import { describe, expect, test } from 'claude-code/testing'
import { COLORS, formatStatus, paint, plain, parseChecks, parseCodexLine, parseCodexLive, parseThreads, tokensText, type StatusData } from './format'

// The status line as plain text, colour codes removed.
const show = (data: StatusData, now: number) => plain(formatStatus(data, now))

const NOW = Date.parse('2026-10-11T10:00:00Z')
const base: StatusData = {
  repo: 'agent-toolkit', branch: 'feat/statusline', pr: undefined,
  context: { tokens: 150_000, percent: 15, window: 1_000_000 },
  claude: { percentUsed: 42, resetsAt: NOW + (2 * 60 + 10) * 60_000 },
  codex: { percentUsed: 45, resetsAt: NOW + 65 * 60_000 },
}

describe('parseChecks', () => {
  test('counts check runs and commit statuses, ignoring skipped ones', () => {
    expect(parseChecks([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
      { status: 'IN_PROGRESS', conclusion: '' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
      { state: 'SUCCESS' },
      { state: 'PENDING' },
      { state: 'ERROR' },
    ])).toEqual({ passing: 2, failing: 2, running: 2 })
  })

  test('no rollup is no checks', () => {
    expect(parseChecks(null)).toEqual({ passing: 0, failing: 0, running: 0 })
  })
})

test('parseThreads counts resolved threads out of the total', () => {
  const answer = { data: { repository: { pullRequest: { reviewThreads: { totalCount: 5, nodes: [
    { isResolved: false }, { isResolved: true }, { isResolved: true }, { isResolved: false }, { isResolved: true },
  ] } } } } }
  expect(parseThreads(answer)).toEqual({ resolved: 3, total: 5 })
  expect(parseThreads({ errors: [] })).toBe(null)
})

test('parseCodexLine reads the 5-hour window from a token_count event', () => {
  const line = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 45.0, window_minutes: 300, resets_at: 1791664998 },
    secondary: { used_percent: 34.0, window_minutes: 10080, resets_at: 1791958419 },
  } } })
  expect(parseCodexLine(line)).toEqual({ percentUsed: 45, resetsAt: 1791664998000 })
  expect(parseCodexLine('not json')).toBe(null)
})

test('parseCodexLive reads the 5-hour window from the app server answer', () => {
  const line = JSON.stringify({ id: 2, result: { rateLimits: {
    primary: { usedPercent: 96, windowDurationMins: 300, resetsAt: 1791664998 },
    secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1791958419 },
  } } })
  expect(parseCodexLive(line)).toEqual({ percentUsed: 96, resetsAt: 1791664998000 })
  expect(parseCodexLive(JSON.stringify({ id: 2, error: { message: 'not logged in' } }))).toBe(null)
})

test('tokensText shortens to k and M', () => {
  expect([950, 222_345, 1_000_000, 1_250_000].map(tokensText)).toEqual(['950', '222k', '1M', '1.3M'])
})

describe('formatStatus', () => {
  test('a PR with passing checks and some threads resolved', () => {
    const pr = { number: 12, checks: { passing: 3, failing: 0, running: 0 }, threads: { resolved: 4, total: 7 } }
    expect(show({ ...base, pr }, NOW)).toBe(
      'agent-toolkit (feat/statusline) · ✓ checks · 4/7 resolved\n' +
      'ctx ▰▱▱▱▱▱▱▱▱▱ 15% 150k/1M · claude 5h 58% left (2h10m) · codex 5h 55% left (1h05m)',
    )
  })

  test('failing beats running, running beats passing', () => {
    const line = (checks: { passing: number; failing: number; running: number }) =>
      show({ ...base, pr: { number: 12, checks, threads: { resolved: 0, total: 0 } } }, NOW).split('\n')[0]
    expect(line({ passing: 1, failing: 2, running: 1 })).toBe('agent-toolkit (feat/statusline) · ✗ 2 failing · no threads')
    expect(line({ passing: 1, failing: 0, running: 3 })).toBe('agent-toolkit (feat/statusline) · ◷ 3 running · no threads')
    expect(line({ passing: 0, failing: 0, running: 0 })).toBe('agent-toolkit (feat/statusline) · no checks · no threads')
  })

  test('no PR, an unknown PR, and outside a repo', () => {
    expect(show({ ...base, branch: 'main', pr: null }, NOW).split('\n')[0]).toBe('agent-toolkit (main) · no PR')
    expect(show({ ...base, branch: 'main' }, NOW).split('\n')[0]).toBe('agent-toolkit (main)')
    expect(show({ ...base, repo: null, branch: null }, NOW)).not.toContain('\n')
  })

  test('missing windows show a dash, and a window past its reset shows 100% left', () => {
    const text = show({ ...base, context: null, claude: null, codex: { percentUsed: 80, resetsAt: NOW - 1 } }, NOW)
    expect(text.split('\n')[1]).toBe('ctx — · claude 5h — · codex 5h 100% left')
  })

  test('the context gauge shows the share used and tokens used out of the window', () => {
    expect(show({ ...base, context: { tokens: 222_000, percent: 22, window: 1_000_000 } }, NOW)).toContain('ctx ▰▰▱▱▱▱▱▱▱▱ 22% 222k/1M')
    expect(show({ ...base, context: { tokens: 190_000, percent: 95, window: 200_000 } }, NOW)).toContain('ctx ▰▰▰▰▰▰▰▰▰▱ 95% 190k/200k')
    expect(show({ ...base, context: { window: 200_000 } }, NOW)).toContain('ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/200k')
  })
})

describe('colours', () => {
  const pr = (checks: { passing: number; failing: number; running: number }, resolved: number, total: number) =>
    formatStatus({ ...base, pr: { number: 12, checks, threads: { resolved, total } } }, NOW)

  test('checks are green, yellow or red', () => {
    expect(pr({ passing: 1, failing: 0, running: 0 }, 0, 0)).toContain(paint('good', '✓ checks'))
    expect(pr({ passing: 1, failing: 0, running: 2 }, 0, 0)).toContain(paint('warn', '◷ 2 running'))
    expect(pr({ passing: 1, failing: 1, running: 2 }, 0, 0)).toContain(paint('bad', '✗ 1 failing'))
  })

  test('threads are green when all are resolved, yellow when some are, red when none are', () => {
    const none = { passing: 0, failing: 0, running: 0 }
    expect(pr(none, 3, 3)).toContain(paint('good', '3/3 resolved'))
    expect(pr(none, 1, 3)).toContain(paint('warn', '1/3 resolved'))
    expect(pr(none, 0, 3)).toContain(paint('bad', '0/3 resolved'))
    expect(plain(pr(none, 0, 0))).toContain('no threads')
  })

  test('the used segments and the share are Claude orange, the free segments and tokens plain', () => {
    const gauge = (percent: number) => formatStatus({ ...base, context: { tokens: percent * 2_000, percent, window: 200_000 } }, NOW)
    expect(gauge(10)).toContain(`ctx ${paint('claude', '▰')}▱▱▱▱▱▱▱▱▱ ${paint('claude', '10%')} 20k/200k`)
    expect(gauge(90)).toContain(`ctx ${paint('claude', '▰▰▰▰▰▰▰▰▰')}▱ ${paint('claude', '90%')} 180k/200k`)
    expect(gauge(0)).toContain(`ctx ▱▱▱▱▱▱▱▱▱▱ ${paint('claude', '0%')} 0/200k`)
  })

  test('the repo name is bold in a darker orange, the branch plain in dim brackets', () => {
    expect(formatStatus(base, NOW)).toContain(`${paint('repo', 'agent-toolkit')} ${paint('dim', '(')}feat/statusline${paint('dim', ')')}`)
    expect(COLORS.repo).toBe('1;38;2;193;95;60')
  })

  test('each agent and its share left are in its brand colour, "left" and the time plain', () => {
    const text = formatStatus(base, NOW)
    expect(text).toContain(`${paint('claude', 'claude 5h')} ${paint('claude', '58%')} left (2h10m)`)
    expect(text).toContain(`${paint('codex', 'codex 5h')} ${paint('codex', '55%')} left (1h05m)`)
    expect(paint('claude', 'x')).toBe(`\x1b[${COLORS.claude}mx\x1b[0m`)
  })

  test('a share left under 10% is bold and underlined as well', () => {
    const text = formatStatus({ ...base, codex: { percentUsed: 96, resetsAt: NOW + 15 * 60_000 } }, NOW)
    expect(text).toContain(`${paint('codex', 'codex 5h')} ${paint('codex', '4%', '1;4')} left (0h15m)`)
    expect(paint('codex', '4%', '1;4')).toBe(`\x1b[1;4;${COLORS.codex}m4%\x1b[0m`)
    expect(formatStatus({ ...base, codex: { percentUsed: 90, resetsAt: null } }, NOW)).toContain(paint('codex', '10%'))
  })

  test('separators, brackets and empty states are dim', () => {
    expect(formatStatus(base, NOW)).toContain(` ${paint('dim', '·')} `)
    expect(formatStatus({ ...base, pr: null }, NOW)).toContain(paint('dim', 'no PR'))
    const empty = formatStatus({ ...base, pr: { number: 1, checks: { passing: 0, failing: 0, running: 0 }, threads: { resolved: 0, total: 0 } } }, NOW)
    expect(empty).toContain(paint('dim', 'no checks'))
    expect(empty).toContain(paint('dim', 'no threads'))
    const missing = formatStatus({ ...base, context: null, claude: null }, NOW)
    expect(missing).toContain(`ctx ${paint('dim', '—')}`)
    expect(missing).toContain(`${paint('claude', 'claude 5h')} ${paint('dim', '—')}`)
  })
})
