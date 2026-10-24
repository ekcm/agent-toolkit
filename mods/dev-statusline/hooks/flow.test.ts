// The mod with the host faked underneath: git, gh, the Codex logs and the
// engine's usage figures. Nothing here touches a real repo or network.

import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { plain } from './format'
import { READER_SCRIPT, SUBAGENT_SCRIPT } from './reader'

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const DIR = '/home/me/.agent-toolkit/dev-statusline'

// `checkout` is where the session runs: the main checkout, a linked worktree
// (/home/me/DEV-67, on feat/widgets), or a detached review checkout.
type Fake = {
  prState: 'open' | 'none' | 'offline'
  checkout: 'main' | 'worktree' | 'detached'
  isCodexLive: boolean
  files: Map<string, string>
  ran: string[]
  // The agents file as it stood while a subagent's tool call ran.
  duringTool?: string
}

const PR_12 = { number: 12, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }
const OPEN_PRS = { data: { repository: { pullRequests: { nodes: [
  { number: 12, headRefName: 'feat/widgets', headRefOid: '222', reviewThreads: { totalCount: 2, nodes: [{ isResolved: true }, { isResolved: false }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] } },
  { number: 13, headRefName: 'feat/search', headRefOid: '333', reviewThreads: { totalCount: 0, nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] } } } }] } },
] } } } }

function fakeHost(on: On, prState: Fake['prState'] = 'open'): Fake {
  const fake: Fake = { prState, checkout: 'main', isCodexLive: true, files: new Map(), ran: [] }
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

  // The engine's own answers to the events the mod passes on.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'done' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-11T10:00:00Z') }))
  on('clock.every', () => ({ deny: 'no timers in this test' }))
  // A one-off timer fires at once, so agent activity is written straight away.
  on('clock.after', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [
    { id: 'lead', description: 'Generating wiki for my-app', type: 'general-purpose', status: 'running' },
    { id: 'core', description: 'Research core', type: 'general-purpose', status: 'running', parentId: 'lead' },
  ] }))
  // A subagent's tool call: it runs until the activity file shows it.
  on('tool.call', async () => {
    const path = `${DIR}/session-1.agents.json`
    for (let i = 0; i < 5000 && !fake.files.get(path)?.includes('"tool"'); i += 1) await Promise.resolve()
    fake.duringTool = fake.files.get(path)
    return { result: 'ok' }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: {
    startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-11T11:00:00Z' }],
  } }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('fs.write', ($, e) => {
    fake.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = fake.files.get(e.path)
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    fake.ran.push(cmd)
    if (e.argv[0] === 'find' || e.argv[0] === 'rm') return ok()
    if (cmd.includes('rev-parse --path-format=absolute')) {
      if (fake.checkout === 'main') return ok('/home/me/repo\n/home/me/repo/.git\n/home/me/repo/.git')
      if (fake.checkout === 'worktree') return ok('/home/me/DEV-67\n/home/me/repo/.git/worktrees/DEV-67\n/home/me/repo/.git')
      return ok('/home/me/.agent-toolkit/pr-reviews/repo/pr-12/worktree\n/home/me/repo/.git/worktrees/worktree\n/home/me/repo/.git')
    }
    if (cmd.includes('symbolic-ref')) return fake.checkout === 'detached' ? fail('fatal: ref HEAD is not a symbolic ref') : ok('feat/widgets')
    if (cmd.includes('rev-parse --short HEAD')) return ok('abc1234')
    if (cmd.includes('rev-parse HEAD')) return ok('abc1234def5678')
    if (cmd.includes('worktree list --porcelain')) {
      const main = 'worktree /home/me/repo\nHEAD 111\nbranch refs/heads/main\n'
      if (fake.checkout === 'main') return ok(main)
      return ok(`${main}\nworktree /home/me/DEV-67\nHEAD 222\nbranch refs/heads/feat/widgets\n\nworktree /home/me/DEV-70\nHEAD 333\nbranch refs/heads/feat/search\n\nworktree /home/me/.agent-toolkit/pr-reviews/repo/pr-12/worktree\nHEAD 222\ndetached\n\nworktree /home/me/.agent-toolkit/pr-reviews/repo/pr-9/worktree\nHEAD 999\ndetached\n`)
    }
    if (cmd.startsWith('gh pr list')) {
      expect(e.argv).toContain('abc1234def5678')
      return ok(JSON.stringify(fake.prState === 'open' ? [PR_12] : []))
    }
    if (cmd.startsWith('gh pr view')) {
      if (fake.prState === 'none') return fail('no pull requests found for branch "feat/widgets"')
      if (fake.prState === 'offline') return fail('error connecting to api.github.com')
      return ok(JSON.stringify(PR_12))
    }
    if (cmd.startsWith('gh api graphql') && !cmd.includes('pr=')) return ok(JSON.stringify(OPEN_PRS))
    if (cmd.startsWith('gh api graphql')) {
      return ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 2, nodes: [{ isResolved: true }, { isResolved: false }] } } } } }))
    }
    // The live query to a Codex app server, then the session-log fallback.
    if (e.argv[0] === 'sh' && e.argv[2]?.includes('app-server')) {
      if (!fake.isCodexLive) return fail('codex: command not found')
      return ok(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: Date.parse('2026-10-11T12:00:00Z') / 1000 } } } }))
    }
    if (e.argv[0] === 'sh') {
      expect(e.argv).toContain('/home/me/.codex')
      return ok(JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 12, resets_at: Date.parse('2026-10-11T12:00:00Z') / 1000 } } } }))
    }
    return fail(`unexpected: ${cmd}`)
  })
  return fake
}

// The lines written for the session, as plain text, once `until` holds for them.
async function written(fake: Fake, until: (text: string) => boolean): Promise<string[]> {
  const lines = () => plain(fake.files.get(`${DIR}/session-1.txt`) ?? '')
  for (let i = 0; i < 5000 && !until(lines()); i += 1) await Promise.resolve()
  return lines().split('\n').filter(Boolean)
}

test('the line shows the branch PR, its checks and threads, and both agents', async ($, on) => {
  const fake = fakeHost(on)
  await $.session.start(START)
  expect(await written(fake, text => text.includes('codex 5h 70% left'))).toEqual([
    'repo (feat/widgets) · ✓ checks · 1/2 resolved',
    'ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/200k · claude 5h 90% left (1h00m) · codex 5h 70% left (2h00m)',
  ])
  expect(fake.files.get(`${DIR}/statusline.sh`)).toBe(READER_SCRIPT)
  expect(fake.files.get(`${DIR}/subagents.sh`)).toBe(SUBAGENT_SCRIPT)
  // A repository with one checkout has no other worktrees to describe.
  expect(fake.files.get(`${DIR}/session-1.worktrees.json`)).toBe('{}')
  expect(fake.ran.some(cmd => cmd.startsWith('gh api graphql') && !cmd.includes('pr='))).toBe(false)
})

test('a branch without a PR says so, and gh failing drops the PR part', async ($, on) => {
  const fake = fakeHost(on, 'none')
  await $.session.start(START)
  expect((await written(fake, text => text.includes('no PR')))[0]).toBe('repo (feat/widgets) · no PR')

  fake.prState = 'offline'
  await $.turn.complete({ reason: 'answer' } as never)
  expect((await written(fake, text => !text.includes('no PR')))[0]).toBe('repo (feat/widgets)')
})

test('measurements after a turn update the context and Claude figures', async ($, on) => {
  const fake = fakeHost(on)
  await $.session.start(START)
  await written(fake, text => text.includes('codex 5h 70% left'))
  await $.session.measure({ context: { window: 200_000, tokens: 100_000, percent: 50 }, rateLimits: [{ kind: 'five_hour', percentUsed: 61 }], changed: ['context'] } as never)
  expect((await written(fake, () => true))[1]).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 50% 100k/200k · claude 5h 39% left · codex 5h 70% left (2h00m)')
})

test('the session ending removes its lines', async ($, on) => {
  const fake = fakeHost(on)
  await $.session.start(START)
  await written(fake, text => text.includes('codex 5h 70% left'))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1' } as never)
  expect(fake.ran).toContain(`rm -f ${DIR}/session-1.txt ${DIR}/session-1.worktrees.json ${DIR}/session-1.agents.json`)
})

test('without a live Codex answer, the newest session log is used', async ($, on) => {
  const fake = fakeHost(on)
  fake.isCodexLive = false
  await $.session.start(START)
  expect((await written(fake, text => text.includes('codex 5h 88% left')))[1]).toBe('ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/200k · claude 5h 90% left (1h00m) · codex 5h 88% left (2h00m)')
})

test('in a worktree the project leads, the worktree follows dim, and every worktree gets a row, a detached one found by its commit', async ($, on) => {
  const fake = fakeHost(on)
  fake.checkout = 'worktree'
  await $.session.start(START)
  expect((await written(fake, text => text.includes('1/2 resolved')))[0]).toBe('repo/DEV-67 (feat/widgets) · ✓ checks · 1/2 resolved')
  for (let i = 0; i < 5000 && !fake.files.get(`${DIR}/session-1.worktrees.json`)?.includes('DEV-70'); i += 1) await Promise.resolve()
  const rows = JSON.parse(fake.files.get(`${DIR}/session-1.worktrees.json`)!) as Record<string, { name: string; pr: string }>
  expect(Object.fromEntries(Object.entries(rows).map(([path, row]) => [path, { name: row.name, pr: plain(row.pr) }]))).toEqual({
    '/home/me/repo': { name: 'repo', pr: 'no PR' },
    '/home/me/DEV-67': { name: 'DEV-67', pr: '✓ checks · 1/2 resolved' },
    '/home/me/DEV-70': { name: 'DEV-70', pr: '✗ 1 failing · no threads' },
    '/home/me/.agent-toolkit/pr-reviews/repo/pr-12/worktree': { name: 'pr-12', pr: '✓ checks · 1/2 resolved' },
    '/home/me/.agent-toolkit/pr-reviews/repo/pr-9/worktree': { name: 'pr-9', pr: '' },
  })
})

test('a detached checkout shows its commit and finds its PR by that commit', async ($, on) => {
  const fake = fakeHost(on)
  fake.checkout = 'detached'
  await $.session.start(START)
  expect((await written(fake, text => text.includes('1/2 resolved')))[0]).toBe('repo/pr-12 (detached abc1234) · ✓ checks · 1/2 resolved')
})

test('a fresh Codex reading from another session is reused instead of asking Codex', async ($, on) => {
  const fake = fakeHost(on)
  const now = Date.parse('2026-10-11T10:00:00Z')
  fake.files.set(`${DIR}/codex.json`, JSON.stringify({ at: now - 10_000, codex: { percentUsed: 50, resetsAt: now + 3_600_000 } }))
  await $.session.start(START)
  expect((await written(fake, text => text.includes('codex 5h 50% left')))[1]).toContain('codex 5h 50% left (1h00m)')
  expect(fake.ran.some(cmd => cmd.includes('app-server'))).toBe(false)
})

test('a stale shared Codex reading is replaced by a live one, which is shared in turn', async ($, on) => {
  const fake = fakeHost(on)
  const now = Date.parse('2026-10-11T10:00:00Z')
  fake.files.set(`${DIR}/codex.json`, JSON.stringify({ at: now - 120_000, codex: { percentUsed: 50, resetsAt: null } }))
  await $.session.start(START)
  await written(fake, text => text.includes('codex 5h 70% left'))
  expect(JSON.parse(fake.files.get(`${DIR}/codex.json`)!)).toEqual({ at: now, codex: { percentUsed: 30, resetsAt: Date.parse('2026-10-11T12:00:00Z') } })
})

test('a subagent\'s tool call is written for its row, with its parent, and cleared when it ends', async ($, on) => {
  const fake = fakeHost(on)
  await $.session.start(START)
  await written(fake, text => text.includes('codex 5h 70% left'))
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'core' } as never)
  const activity = (text?: string) => JSON.parse(text ?? '{}') as Record<string, { parent?: string; phase: string | null; activity?: string }>
  for (let i = 0; i < 5000 && activity(fake.files.get(`${DIR}/session-1.agents.json`)).core?.phase !== null; i += 1) await Promise.resolve()
  expect(activity(fake.duringTool).core).toMatchObject({ parent: 'lead', phase: 'tool', activity: 'Bash: npm test' })
  expect(activity(fake.files.get(`${DIR}/session-1.agents.json`)).core).toMatchObject({ parent: 'lead', phase: null })
  expect(activity(fake.files.get(`${DIR}/session-1.agents.json`)).lead).toMatchObject({ phase: null })
})

test('the main session\'s own tool calls are not tracked', async ($, on) => {
  const fake = fakeHost(on)
  await $.session.start(START)
  await written(fake, text => text.includes('codex 5h 70% left'))
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(fake.files.has(`${DIR}/session-1.agents.json`)).toBe(false)
})
