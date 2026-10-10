// The mod with the host faked underneath: git, gh, the Codex logs and the
// engine's usage figures. Nothing here touches a real repo or network.

import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { plain } from './format'
import { READER_SCRIPT } from './reader'

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const DIR = '/home/me/.agent-toolkit/dev-statusline'

type Fake = { prState: 'open' | 'none' | 'offline'; isCodexLive: boolean; files: Map<string, string>; ran: string[] }

function fakeHost(on: On, prState: Fake['prState'] = 'open'): Fake {
  const fake: Fake = { prState, isCodexLive: true, files: new Map(), ran: [] }
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

  // The engine's own answers to the events the mod passes on.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'done' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-11T10:00:00Z') }))
  on('clock.every', () => ({ deny: 'no timers in this test' }))
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
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    fake.ran.push(cmd)
    if (e.argv[0] === 'find' || e.argv[0] === 'rm') return ok()
    if (cmd.includes('rev-parse --show-toplevel')) return ok('/home/me/repo')
    if (cmd.includes('symbolic-ref')) return ok('feat/widgets')
    if (cmd.startsWith('gh pr view')) {
      if (fake.prState === 'none') return fail('no pull requests found for branch "feat/widgets"')
      if (fake.prState === 'offline') return fail('error connecting to api.github.com')
      return ok(JSON.stringify({ number: 12, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }))
    }
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
  expect(fake.ran).toContain(`rm -f ${DIR}/session-1.txt`)
})

test('without a live Codex answer, the newest session log is used', async ($, on) => {
  const fake = fakeHost(on)
  fake.isCodexLive = false
  await $.session.start(START)
  expect((await written(fake, text => text.includes('codex 5h 88% left')))[1]).toBe('ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/200k · claude 5h 90% left (1h00m) · codex 5h 88% left (2h00m)')
})
