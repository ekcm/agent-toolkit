import { describe, expect, test } from 'claude-code/testing'

import type { DebateReply, Group, ReviewOutput } from '../types'
import { applyRoundOne, applyRoundTwo, closeOpen, debateCounts, debateItems, readReplies, roundOnePrompt, roundTwoPrompt } from './debate'
import { detectSteps, evidence, summarize, tailOf } from './verify'

const group = (kind: Group['kind'], severity: Group['severity'], claude: string[], codex: string[], conflictNote: string | null = null): Group =>
  ({ kind, severity, claude, codex, conflictNote })

const output = (ids: string[]): ReviewOutput => ({
  summary: '', verdict: 'request_changes', checked_ok: [],
  findings: ids.map(id => ({
    id, file: 'src/a.ts', line: 10, end_line: 12, severity: 'major', category: 'correctness',
    title: `title ${id}`, explanation: `explanation ${id}`, suggestion: null,
  })),
})

describe('debateItems', () => {
  const groups = [
    group('agree', 'major', ['F1'], ['F1']),
    group('conflict', 'minor', ['F2'], [], 'Error handling: falls back correctly'),
    group('claude', 'major', ['F3'], []),
    group('claude', 'minor', ['F4'], []),
    group('codex', 'critical', [], ['F5']),
  ]
  const items = debateItems(groups)

  test('debates conflicts and one-sided major or critical findings only', async () => {
    expect(items.map(i => `${i.id}:${i.author}:${i.findingIds.join('+')}`)).toEqual(['D1:claude:F2', 'D2:claude:F3', 'D3:codex:F5'])
  })

  test('a conflict carries the other agent\'s judgement into the prompt', async () => {
    const prompt = roundOnePrompt('codex', 19, items.filter(i => i.author === 'claude'), { claude: output(['F2', 'F3']), codex: output(['F5']) }, 'Not run.')
    expect(prompt).toContain('You checked this area earlier and judged it fine: "Error handling: falls back correctly"')
    expect(prompt).toContain('Claude raised the findings below')
  })
})

describe('resolving the debate', () => {
  const items = debateItems([
    group('claude', 'major', ['F1'], []),
    group('claude', 'major', ['F2'], []),
    group('codex', 'major', [], ['F3']),
    group('codex', 'major', [], ['F4']),
  ])
  const reply = (stance: DebateReply['stance']): DebateReply => ({ stance, evidence: `because ${stance}` })

  test('round 1: agree confirms, unsure leaves it disputed, disagree goes to round 2', async () => {
    const after = applyRoundOne(items, new Map([['D1', reply('agree')], ['D2', reply('disagree')], ['D3', reply('unsure')]]))
    expect(after.map(i => i.resolution)).toEqual(['confirmed', 'pending', 'disputed', 'pending'])
  })

  test('round 2: withdraw drops it, maintain keeps it disputed, silence keeps it disputed', async () => {
    const one = applyRoundOne(items, new Map([['D1', reply('agree')], ['D2', reply('disagree')], ['D3', reply('disagree')]]))
    const two = applyRoundTwo(one, new Map([['D2', reply('withdraw')], ['D3', reply('maintain')]]))
    const done = closeOpen(two)
    expect(done.map(i => i.resolution)).toEqual(['confirmed', 'withdrawn', 'disputed', 'disputed'])
    expect(debateCounts(done)).toEqual({ confirmed: 1, withdrawn: 1, disputed: 2 })
  })

  test('round 2 prompt quotes the other agent\'s objection', async () => {
    const one = applyRoundOne(items, new Map([['D1', reply('disagree')]]))
    const prompt = roundTwoPrompt('claude', 19, one.filter(i => i.id === 'D1'), { claude: output(['F1', 'F2']), codex: output(['F3', 'F4']) }, 'Not run.')
    expect(prompt).toContain('Codex disagreed: because disagree')
  })

  test('replies with unknown items or stances not allowed this round are dropped', async () => {
    const replies = readReplies({ responses: [
      { item: 'D1', stance: 'agree', evidence: 'x' },
      { item: 'D9', stance: 'agree', evidence: 'x' },
      { item: 'D2', stance: 'withdraw', evidence: 'x' },
    ] }, ['D1', 'D2'], ['agree', 'disagree', 'unsure'])
    expect([...replies!.keys()]).toEqual(['D1'])
    expect(readReplies({ nope: true }, ['D1'], ['agree'])).toBe(null)
  })
})

describe('verification steps', () => {
  test('npm with a lockfile: ci, test and build', async () => {
    const steps = detectSteps(['package.json', 'package-lock.json'], JSON.stringify({ scripts: { test: 'vitest run', build: 'astro build' } }))
    expect(steps.map(s => s.command.join(' '))).toEqual(['npm ci', 'npm run test', 'npm run build'])
  })

  test('pnpm is picked from its lockfile', async () => {
    const steps = detectSteps(['package.json', 'pnpm-lock.yaml'], JSON.stringify({ scripts: { test: 'vitest' } }))
    expect(steps.map(s => s.command.join(' '))).toEqual(['pnpm install --frozen-lockfile', 'pnpm run test'])
  })

  test('npm\'s placeholder test script and a repo with nothing to run are skipped', async () => {
    expect(detectSteps(['package.json'], JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))).toEqual([])
    expect(detectSteps(['Cargo.toml'], null)).toEqual([])
  })

  test('summaries pick up test counts and strip colour codes', async () => {
    expect(summarize('test', 0, ' Test Files  6 passed (6)\n      Tests  48 passed (48)\n')).toBe('48 passed (48)')
    expect(summarize('build', 1, 'error TS2304\n')).toBe('failed (exit 1)')
    expect(tailOf('\u001b[32mok\u001b[0m\nlast', 1)).toBe('last')
  })

  test('evidence includes the last lines of a failed step only', async () => {
    const steps = detectSteps(['package.json', 'package-lock.json'], JSON.stringify({ scripts: { test: 't', build: 'b' } }))
    const ran = steps.map((s, i) => ({ ...s, status: i === 2 ? 'failed' as const : 'passed' as const, durationMs: 1000, summary: null }))
    const text = evidence(ran, { build: 'boom', test: 'fine' })
    expect(text).toContain('build (`npm run build`): failed in 1s\n  Last lines:\n    boom')
    expect(text).not.toContain('fine')
  })
})
