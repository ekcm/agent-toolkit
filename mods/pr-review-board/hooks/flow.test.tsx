// The whole flow with the host faked underneath the mod: gh, git, both agents,
// the PR's install/test/build, the matching model call and the file system.
// Nothing here costs anything or touches a real repo.

import type { On, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const HOME = '/home/me'
const WORKTREE = `${HOME}/.agent-toolkit/pr-reviews/repo/pr-7/worktree`
const PANE_PROPS = { title: 'PR reviews', isFocused: true, bodyColumns: 140, placement: 'dock' } as unknown as RenderPropsOf['Pane']

const f = (id: string, file: string, line: number, severity: string, title: string) => ({
  id, file, line, end_line: line + 2, severity, category: 'correctness', title, explanation: `${title}, explained.`, suggestion: null,
})
const CLAUDE_REVIEW = {
  summary: 'Claude summary.', verdict: 'request_changes', checked_ok: [],
  findings: [f('F1', 'src/a.ts', 10, 'major', 'Shared bug'), f('F2', 'src/b.ts', 5, 'major', 'Real Claude-only bug'), f('F3', 'src/c.ts', 1, 'major', 'Mistaken Claude finding')],
}
const CODEX_REVIEW = {
  summary: 'Codex summary.', verdict: 'request_changes', checked_ok: [],
  findings: [f('F1', 'src/a.ts', 10, 'major', 'Same shared bug'), f('F2', 'src/d.ts', 3, 'critical', 'Codex-only claim')],
}

type Host = { prompts: Record<string, string>; ran: string[]; files: Map<string, string> }

function fakeHost(on: On, options: { viewer?: string; buildFails?: boolean; missingPr?: number } = {}): Host {
  const host: Host = { prompts: {}, ran: [], files: new Map() }
  const result = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const ok = (stdout = '') => ({ value: result(stdout) })

  let clock = 1_000_000
  on('clock.now', () => ({ value: (clock += 1000) }))
  // No ticker in a test: refusing the first period ends the interval.
  on('clock.every', () => ({ deny: 'no timers in this test' }))
  on('env.get', ($, e, next) => (e.name === 'HOME' ? { value: HOME } : next(e)))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('store.get', () => ({ value: undefined }))
  on('fs.write', ($, e) => {
    host.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    if (e.path === `${WORKTREE}/package.json`) return { value: JSON.stringify({ scripts: { test: 'vitest run', build: 'astro build' } }) }
    const text = host.files.get(e.path)
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', ($, e) => ({ value: e.path === WORKTREE
    ? ['package.json', 'package-lock.json'].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }))
    : [] }))
  on('model.complete', () => ({ value: {
    isAnswered: true, text: '{"pairs": [{"claude": "F1", "codex": "F1"}], "conflicts": []}',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } }) as never)

  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    host.ran.push(cmd)
    if (cmd.includes('rev-parse --show-toplevel')) return ok('/repo')
    if (cmd.startsWith(`gh pr view ${options.missingPr} `)) {
      return { value: { ...result(), exitCode: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99.' } }
    }
    if (cmd.startsWith('gh pr view')) return ok(JSON.stringify({ title: 'Add widgets', additions: 120, deletions: 4, headRefOid: 'abcdef1234', baseRefName: 'main', isCrossRepository: false }))
    if (cmd.startsWith('gh api user')) return ok(options.viewer ?? 'me')
    if (cmd.startsWith('gh repo view')) return ok(JSON.stringify({ nameWithOwner: 'me/repo', owner: { login: 'me' } }))
    if (cmd.startsWith('gh pr diff')) return ok('diff --git a/src/a.ts b/src/a.ts')
    if (cmd.includes('merge-base')) return ok('1234567abc')
    if (cmd === 'npm ci') return ok('added 10 packages')
    if (cmd === 'npm run test') return ok(' Test Files  2 passed (2)\n      Tests  3 passed (3)')
    if (cmd === 'npm run build') {
      return options.buildFails ? { value: { ...result(), exitCode: 1, stderr: 'error: cannot find module ./widgets' } } : ok('built')
    }
    return ok()
  })

  on('process.spawn', async function* ($, e) {
    const [tool] = e.argv
    const prompt = tool === 'claude' ? e.argv[2]! : e.argv[e.argv.length - 1]!
    const phase = !prompt.startsWith('Earlier you reviewed') ? 'review' : prompt.includes('maintain:') ? 'debate-2' : 'debate-1'
    host.prompts[`${tool}:${phase}`] = prompt

    let answer: unknown
    if (phase === 'review') answer = tool === 'claude' ? CLAUDE_REVIEW : CODEX_REVIEW
    else if (tool === 'codex' && phase === 'debate-1') answer = { responses: [
      { item: 'D1', stance: 'agree', evidence: 'src/b.ts:5 shows it.' },
      { item: 'D2', stance: 'disagree', evidence: 'src/c.ts:1 handles that case.' },
    ] }
    else if (tool === 'claude' && phase === 'debate-1') answer = { responses: [{ item: 'D3', stance: 'disagree', evidence: 'src/d.ts:3 is guarded.' }] }
    else if (tool === 'claude' && phase === 'debate-2') answer = { responses: [{ item: 'D2', stance: 'withdraw', evidence: 'Codex is right.' }] }
    else answer = { responses: [{ item: 'D3', stance: 'maintain', evidence: 'The guard is skipped on retry.' }] }

    if (tool === 'claude') {
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] } })}\n` }
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.5, structured_output: answer })}\n` }
    } else {
      const outFile = e.argv[e.argv.indexOf('-o') + 1]!
      host.files.set(outFile, JSON.stringify(answer))
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: '/bin/zsh -lc "rg widgets"' } })}\n` }
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 3000, output_tokens: 1000 } })}\n` }
    }
    return { value: { code: 0, signal: null } }
  })
  return host
}

async function untilReady(ui: { drawn: () => Promise<unknown> }): Promise<string> {
  let text = ''
  for (let i = 0; i < 500; i += 1) {
    text = JSON.stringify(await ui.drawn())
    if (text.includes('✓ ready') || text.includes('✗ ')) return text
  }
  return text
}

test('a PR goes through review, combine, verify and a two-round debate', async ($, on) => {
  const host = fakeHost(on, { buildFails: true })
  const started = await $.command.run({ command: 'review-prs', args: '/repo 7' } as never)
  expect(started.text).toContain('Reviewing #7 in repo with Claude and Codex.')

  const ui = await $.ui.mount({ plugin: 'pr-review-board', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'pr-reviews' })
  const board = await untilReady(ui)
  expect(board).toContain('✓ ready')
  expect(board).toContain('⇄ 1 agree')
  expect(board).toContain('✓ 1 confirmed')
  expect(board).toContain('⚔ 1 disputed')
  expect(board).toContain('↩ 1 withdrawn')
  expect(board).toContain('✓ install')
  expect(board).toContain('✓ test')
  expect(board).toContain('3 passed (3)')
  expect(board).toContain('✗ build')

  // The PR's code ran, in its worktree, after the reviews.
  expect(host.ran).toContain('npm ci')
  expect(host.ran).toContain('npm run build')
  // Both agents saw the failed build as evidence in the debate.
  expect(host.prompts['codex:debate-1']).toContain('build (`npm run build`): failed')
  expect(host.prompts['codex:debate-1']).toContain('error: cannot find module ./widgets')
  // Round 2 went only to Claude about D2 and Codex about D3.
  expect(host.prompts['claude:debate-2']).toContain('Codex disagreed: src/c.ts:1 handles that case.')
  expect(host.prompts['codex:debate-2']).toContain('Claude disagreed: src/d.ts:3 is guarded.')

  await ui.press({ key: 'open-repo#7' })
  const combined = JSON.stringify(await ui.drawn())
  expect(combined).toContain('⚔ Still disputed after the debate (1)')
  expect(combined).toContain('Codex-only claim')
  expect(combined).toContain('confirmed by Codex in the debate')
  expect(combined).toContain('↩ Withdrawn in the debate (1)')
  expect(combined).toContain('Claude, debate 2')
  expect(host.files.get(`${HOME}/.agent-toolkit/pr-reviews/repo/pr-7/reconciled.md`)).toContain('# repo #7: Add widgets')

  const desktop = await $.ui.mount({ plugin: 'pr-review-board', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'pr-reviews' })
  expect(JSON.stringify(await desktop.drawn())).toContain('Codex-only claim')
})

test('a repo that is not yours is reviewed without running its code', async ($, on) => {
  const host = fakeHost(on, { viewer: 'someone-else' })
  await $.command.run({ command: 'review-prs', args: '/repo 7' } as never)
  const ui = await $.ui.mount({ plugin: 'pr-review-board', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'pr-reviews' })
  const board = await untilReady(ui)
  expect(board).toContain('✓ ready')
  expect(board).toContain('skipped: not your repo')
  expect(host.ran.some(cmd => cmd.startsWith('npm'))).toBe(false)
  expect(host.prompts['codex:debate-1']).toContain('Not run (skipped: not your repo')
})

test('a PR number the repo does not have is reported, not added', async ($, on) => {
  fakeHost(on, { missingPr: 99 })
  const started = await $.command.run({ command: 'review-prs', args: '/repo 99' } as never)
  expect(started.text).toContain('Not found in repo: #99 (GraphQL: Could not resolve to a PullRequest with the number of 99.)')
  const ui = await $.ui.mount({ plugin: 'pr-review-board', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'pr-reviews' })
  expect(JSON.stringify(await ui.drawn())).toContain('No reviews yet')
})

test('a finished review can be removed, and the panel closed', async ($, on) => {
  let closed = false
  fakeHost(on)
  on('ui.close', () => {
    closed = true
    return { value: undefined }
  })
  await $.command.run({ command: 'review-prs', args: '/repo 7' } as never)
  const ui = await $.ui.mount({ plugin: 'pr-review-board', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'pr-reviews' })
  await untilReady(ui)
  await ui.press({ key: 'remove-repo#7' })
  expect(JSON.stringify(await ui.drawn())).toContain('No reviews yet')
  await ui.press({ key: 'close' })
  expect(closed).toBe(true)
})
