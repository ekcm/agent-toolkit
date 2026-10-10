import { describe, expect, test } from 'claude-code/testing'

import type { Finding, ReviewOutput } from '../types'
import { buildGroups, combinedMarkdown, conflictCandidates, countGroups, linePairs, parseMatchReply } from './reconcile'
import { readClaudeEvent, readCodexEvent, lineSplitter, unwrapShell } from './stream'

// Trimmed from a real run of both reviewers on ekcm/Muse#19.
const INTEGRATION = 'src/lib/markdown/wiki-link-index-integration.ts'
const INDEX = 'src/lib/markdown/wiki-link-index.ts'
const RESOLVER = 'src/lib/markdown/remark-wiki-link-resolver.ts'

const finding = (id: string, file: string, line: number, endLine: number, severity: Finding['severity'], title: string): Finding => ({
  id, file, line, end_line: endLine, severity, category: 'correctness', title, explanation: title, suggestion: null,
})

const claude: ReviewOutput = {
  summary: 'Claude summary', verdict: 'request_changes',
  findings: [
    finding('F2', INTEGRATION, 152, 163, 'major', 'The astro:content path most likely never runs'),
    finding('F3', INTEGRATION, 115, 124, 'major', 'Fallback builds IDs and parses frontmatter differently'),
    finding('F4', INTEGRATION, 23, 77, 'major', 'Hand-written YAML alias parsing'),
    finding('F5', INDEX, 13, 23, 'major', "One post's alias can take over another post's slug"),
    finding('F8', RESOLVER, 33, 37, 'major', 'hasChildren is duplicated from the tokenizer'),
    finding('F11', RESOLVER, 52, 52, 'minor', 'The href is built inline instead of with getPostHref'),
    finding('F14', INTEGRATION, 1, 251, 'minor', 'The integration module does too many jobs'),
    finding('F15', RESOLVER, 49, 65, 'minor', 'className is overwritten instead of added to'),
  ],
  checked_ok: [],
}

const codex: ReviewOutput = {
  summary: 'Codex summary', verdict: 'request_changes',
  findings: [
    finding('F1', INDEX, 19, 20, 'major', "An alias can shadow a later post's canonical slug"),
    finding('F2', INTEGRATION, 32, 33, 'major', 'Filesystem fallback does not parse valid YAML alias values'),
    finding('F3', RESOLVER, 68, 79, 'major', "Recursive mdast traversal duplicates the tokenizer's walker"),
    finding('F4', RESOLVER, 52, 52, 'major', 'Post route construction is reimplemented in the resolver'),
  ],
  checked_ok: [
    { file: INTEGRATION, line: 152, area: 'Content-load error handling', note: 'Falls back on the known error' },
  ],
}

describe('linePairs', () => {
  test('pairs overlapping lines one to one, preferring the tighter match', async () => {
    expect(linePairs(claude.findings, codex.findings)).toEqual([
      { claude: 'F11', codex: 'F4' },
      { claude: 'F5', codex: 'F1' },
    ])
  })
})

describe('buildGroups', () => {
  // What the model pass found on the real run: line pairs plus the
  // different-line and one-to-many matches.
  const pairs = [
    { claude: 'F5', codex: 'F1' },
    { claude: 'F11', codex: 'F4' },
    { claude: 'F4', codex: 'F2' },
    { claude: 'F3', codex: 'F2' },
    { claude: 'F8', codex: 'F3' },
  ]
  const conflicts = [{ side: 'claude' as const, finding: 'F2', note: 'Content-loading error handling: Falls back on the known error' }]
  const groups = buildGroups(claude, codex, pairs, conflicts)

  test('counts agreements, one-sided findings and conflicts', async () => {
    expect(countGroups(groups)).toEqual({ agree: 4, claude: 2, codex: 0, conflict: 1 })
  })

  test('one Codex finding can agree with two Claude findings', async () => {
    const yaml = groups.find(g => g.codex.includes('F2'))
    expect(yaml?.claude.sort()).toEqual(['F3', 'F4'])
  })

  test('a confirmed conflict turns a one-sided finding into a conflict', async () => {
    const conflict = groups.find(g => g.kind === 'conflict')
    expect(conflict?.claude).toEqual(['F2'])
    expect(conflict?.conflictNote).toBe('Content-loading error handling: Falls back on the known error')
  })

  test('without a confirmed conflict, a nearby check leaves the finding one-sided', async () => {
    const unconfirmed = buildGroups(claude, codex, pairs)
    expect(countGroups(unconfirmed).conflict).toBe(0)
    expect(unconfirmed.find(g => g.claude.includes('F2'))?.kind).toBe('claude')
  })

  test('only findings next to a check become candidates, never file-wide ones', async () => {
    const candidates = conflictCandidates(claude, codex)
    expect(candidates.map(k => `${k.side}:${k.finding}`)).toEqual(['claude:F2'])
  })

  test('the agreed severity is the higher of the two', async () => {
    expect(groups.find(g => g.claude.includes('F11'))?.severity).toBe('major')
  })

  test('conflicts come first in the combined report', async () => {
    const text = combinedMarkdown(claude, codex, groups)
    expect(text.indexOf('✗ Conflicts')).toBeLessThan(text.indexOf('⇄ Both agree'))
    expect(text).toContain('Codex checked this and found it fine:')
  })
})

describe('parseMatchReply', () => {
  test('keeps only pairs whose ids exist, and maps chosen candidates to conflicts', async () => {
    const candidates = conflictCandidates(claude, codex)
    const reply = 'Here you go: {"pairs": [{"claude": "F5", "codex": "F1"}, {"claude": "F99", "codex": "F1"}], "conflicts": ["K1", "K9"]}'
    expect(parseMatchReply(reply, claude.findings, codex.findings, candidates)).toEqual({
      pairs: [{ claude: 'F5', codex: 'F1' }],
      conflicts: [{ side: 'claude', finding: 'F2', note: 'Content-load error handling: Falls back on the known error' }],
    })
  })

  test('answers null for a reply that is not JSON', async () => {
    expect(parseMatchReply('no idea', claude.findings, codex.findings)).toBe(null)
  })
})

describe('stream readers', () => {
  test('lines split across chunks are joined', async () => {
    const split = lineSplitter()
    expect(split('{"a":')).toEqual([])
    expect(split('1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  test('Codex commands lose their shell wrapper', async () => {
    expect(unwrapShell(`/bin/zsh -lc "rg -n 'astro:build:start' src"`)).toBe(`rg -n 'astro:build:start' src`)
    const started = '{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc \\"git status --short\\""}}'
    expect(readCodexEvent(started).activity).toBe('$ git status --short')
  })

  test('Codex usage comes from turn.completed', async () => {
    const done = '{"type":"turn.completed","usage":{"input_tokens":438121,"cached_input_tokens":367104,"output_tokens":8777}}'
    expect(readCodexEvent(done).usage).toBe('438k in (367k cached) · 9k out')
  })

  test('Claude tool calls become activity, and the result carries the output', async () => {
    const step = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/w/src/lib/markdown/wiki-link-index.ts"}}]}}'
    expect(readClaudeEvent(step).activity).toBe('read …/lib/markdown/wiki-link-index.ts')
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 13, total_cost_usd: 0.9891, structured_output: claude })
    const read = readClaudeEvent(result)
    expect((read.structured as ReviewOutput).findings.length).toBe(8)
    expect(read.usage).toBe('$0.99 equiv · 13 turns')
  })

  test('Claude finishing without structured output is an error', async () => {
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false })
    expect(readClaudeEvent(result).error).toBe('Claude finished without structured output')
  })
})
