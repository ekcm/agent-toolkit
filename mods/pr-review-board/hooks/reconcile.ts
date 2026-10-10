// Combines two reviews into groups: both agree, one reviewer only, or a
// conflict (one flags what the other checked and judged fine).
//
// Pass 1 proposes pairs by line overlap. Pass 2 (a model call, made by the
// caller with matchPrompt) confirms or rejects them and adds pairs that sit on
// different lines, including one finding matching several. Without pass 2 the
// line pairs stand as they are.

import type { CheckedOk, Finding, Group, ReviewOutput, Severity } from '../types'

export type Pair = { claude: string; codex: string }

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 }
// A range wider than this is a file-level remark, not a place; leave it to pass 2.
const MAX_SPAN = 40
const CONFLICT_SLACK = 3

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '')
}

function range(finding: { line: number | null; end_line?: number | null }): [number, number] | null {
  if (finding.line === null) return null
  const end = finding.end_line ?? finding.line
  return [Math.min(finding.line, end), Math.max(finding.line, end)]
}

// How much of the smaller range the two share (0 to 1), or 0 when either is
// missing, too wide, or in another file.
export function lineOverlap(a: Finding, b: Finding): number {
  if (normalizePath(a.file) !== normalizePath(b.file)) return 0
  const ra = range(a)
  const rb = range(b)
  if (!ra || !rb) return 0
  if (ra[1] - ra[0] > MAX_SPAN || rb[1] - rb[0] > MAX_SPAN) return 0
  const shared = Math.min(ra[1], rb[1]) - Math.max(ra[0], rb[0]) + 1
  if (shared <= 0) return 0
  const smaller = Math.min(ra[1] - ra[0], rb[1] - rb[0]) + 1
  return shared / smaller
}

// One-to-one pairs by line, best overlap first; ties go to the tighter pair.
export function linePairs(claude: Finding[], codex: Finding[]): Pair[] {
  const candidates: Array<{ pair: Pair; score: number; span: number }> = []
  for (const a of claude) {
    for (const b of codex) {
      const score = lineOverlap(a, b)
      if (score < 0.5) continue
      const span = (range(a)![1] - range(a)![0]) + (range(b)![1] - range(b)![0])
      candidates.push({ pair: { claude: a.id, codex: b.id }, score, span })
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.span - y.span)
  const usedClaude = new Set<string>()
  const usedCodex = new Set<string>()
  const pairs: Pair[] = []
  for (const { pair } of candidates) {
    if (usedClaude.has(pair.claude) || usedCodex.has(pair.codex)) continue
    usedClaude.add(pair.claude)
    usedCodex.add(pair.codex)
    pairs.push(pair)
  }
  return pairs
}

function brief(finding: Finding): string {
  return `${finding.id} [${finding.severity}] ${where(finding)} — ${finding.title}\n    ${finding.explanation.slice(0, 400).replace(/\s+/g, ' ')}`
}

// A finding next to a place the other reviewer examined and judged correct.
// Only the model decides whether that check covered the same concern.
export type ConflictCandidate = { id: string; side: 'claude' | 'codex'; finding: string; check: CheckedOk }
export type Conflict = { side: 'claude' | 'codex'; finding: string; note: string }
export type Match = { pairs: Pair[]; conflicts: Conflict[] }

function isNear(finding: Finding, check: CheckedOk): boolean {
  const r = range(finding)
  if (!r || r[1] - r[0] > MAX_SPAN || check.line === null) return false
  return normalizePath(check.file) === normalizePath(finding.file)
    && check.line >= r[0] - CONFLICT_SLACK
    && check.line <= r[1] + CONFLICT_SLACK
}

export function conflictCandidates(claude: ReviewOutput, codex: ReviewOutput): ConflictCandidate[] {
  const candidates: ConflictCandidate[] = []
  const add = (side: 'claude' | 'codex', findings: Finding[], checks: CheckedOk[]) => {
    for (const finding of findings) {
      for (const check of checks) {
        if (isNear(finding, check)) candidates.push({ id: `K${candidates.length + 1}`, side, finding: finding.id, check })
      }
    }
  }
  add('claude', claude.findings, codex.checked_ok)
  add('codex', codex.findings, claude.checked_ok)
  return candidates
}

export const MATCH_SYSTEM = 'You match code review findings from two reviewers. Answer with JSON only.'

export function matchPrompt(claude: Finding[], codex: Finding[], proposed: Pair[], candidates: ConflictCandidate[]): string {
  const letter = (side: 'claude' | 'codex') => (side === 'claude' ? 'C' : 'X')
  const other = (side: 'claude' | 'codex') => (side === 'claude' ? 'X' : 'C')
  return `Two reviewers reviewed the same pull request. Decide which of their findings describe the same underlying problem, and where they truly disagree.

Reviewer C (Claude) findings:
${claude.map(brief).join('\n')}

Reviewer X (Codex) findings:
${codex.map(brief).join('\n')}

Pairs proposed because they cite overlapping lines (they may still be different problems):
${proposed.length ? proposed.map(p => `${p.claude} ~ ${p.codex}`).join('\n') : '(none)'}

Possible disagreements: a finding next to a place the other reviewer examined and judged correct:
${candidates.length ? candidates.map(k => `${k.id}: ${letter(k.side)} ${k.finding} vs ${other(k.side)} checked "${k.check.area}": ${k.check.note}`).join('\n') : '(none)'}

Rules:
- Pair two findings only when fixing one would fix the other: the same root problem, even if cited on different lines or worded differently.
- One finding may pair with several from the other reviewer when it covers all of them.
- Reject a proposed pair that is about different problems.
- List a possible disagreement only when the check examined the same specific concern the finding raises and concluded it is fine. A check of a different aspect of the same code is not a disagreement.

Answer with only this JSON: {"pairs": [{"claude": "<C id>", "codex": "<X id>"}], "conflicts": ["<K id>"]}`
}

export function parseMatchReply(text: string, claude: Finding[], codex: Finding[], candidates: ConflictCandidate[] = []): Match | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const reply = parsed as { pairs?: unknown; conflicts?: unknown }
  if (!Array.isArray(reply.pairs)) return null
  const claudeIds = new Set(claude.map(f => f.id))
  const codexIds = new Set(codex.map(f => f.id))
  const pairs = reply.pairs
    .filter((p): p is Pair => typeof p?.claude === 'string' && typeof p?.codex === 'string')
    .filter(p => claudeIds.has(p.claude) && codexIds.has(p.codex))
  const chosen = new Set(Array.isArray(reply.conflicts) ? reply.conflicts.filter(k => typeof k === 'string') : [])
  const conflicts = candidates
    .filter(k => chosen.has(k.id))
    .map(k => ({ side: k.side, finding: k.finding, note: `${k.check.area}: ${k.check.note}` }))
  return { pairs, conflicts }
}

function maxSeverity(findings: Finding[]): Severity {
  return findings.reduce<Severity>((top, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[top] ? f.severity : top), 'minor')
}

// Connected components over the pairs, so A~X and B~X land in one group. A
// one-sided group is a conflict when a confirmed conflict names one of its findings.
export function buildGroups(claude: ReviewOutput, codex: ReviewOutput, pairs: Pair[], conflicts: Conflict[] = []): Group[] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const up = parent.get(id) ?? id
    if (up === id) return id
    const root = find(up)
    parent.set(id, root)
    return root
  }
  const nodes = [...claude.findings.map(f => `c:${f.id}`), ...codex.findings.map(f => `x:${f.id}`)]
  nodes.forEach(n => parent.set(n, n))
  for (const p of pairs) parent.set(find(`c:${p.claude}`), find(`x:${p.codex}`))

  const components = new Map<string, string[]>()
  for (const n of nodes) components.set(find(n), [...(components.get(find(n)) ?? []), n])

  const byId = (list: Finding[], id: string) => list.find(f => f.id === id)!
  const groups: Group[] = []
  for (const members of components.values()) {
    const claudeIds = members.filter(m => m.startsWith('c:')).map(m => m.slice(2))
    const codexIds = members.filter(m => m.startsWith('x:')).map(m => m.slice(2))
    const findings = [...claudeIds.map(id => byId(claude.findings, id)), ...codexIds.map(id => byId(codex.findings, id))]
    let kind: Group['kind'] = claudeIds.length && codexIds.length ? 'agree' : claudeIds.length ? 'claude' : 'codex'
    let conflictNote: string | null = null
    if (kind !== 'agree') {
      const ids = kind === 'claude' ? claudeIds : codexIds
      const conflict = conflicts.find(c => c.side === kind && ids.includes(c.finding))
      if (conflict) {
        kind = 'conflict'
        conflictNote = conflict.note
      }
    }
    groups.push({ kind, severity: maxSeverity(findings), claude: claudeIds, codex: codexIds, conflictNote })
  }

  const kindOrder = { conflict: 0, agree: 1, claude: 2, codex: 3 }
  return groups.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
}

export function countGroups(groups: Group[]): Record<Group['kind'], number> {
  const counts = { agree: 0, claude: 0, codex: 0, conflict: 0 }
  for (const g of groups) counts[g.kind] += 1
  return counts
}

function where(f: Finding): string {
  if (f.line === null) return `\`${f.file}\``
  return `\`${f.file}:${f.line}${f.end_line && f.end_line !== f.line ? `-${f.end_line}` : ''}\``
}

function findingBlock(f: Finding, who: string): string {
  const fix = f.suggestion ? `\n  *Fix:* ${f.suggestion}` : ''
  return `- **${who}** (${f.severity}, ${where(f)}): ${f.explanation}${fix}`
}

const HEADINGS: Record<Group['kind'], string> = {
  conflict: '✗ Conflicts',
  agree: '⇄ Both agree',
  claude: '◐ Claude only',
  codex: '◑ Codex only',
}

export function combinedMarkdown(claude: ReviewOutput, codex: ReviewOutput, groups: Group[]): string {
  const lookup = (list: Finding[], ids: string[]) => ids.map(id => list.find(f => f.id === id)!).filter(Boolean)
  const important = groups.filter(g => g.severity !== 'minor')
  const minor = groups.filter(g => g.severity === 'minor')
  const out: string[] = [
    `**Claude:** ${claude.verdict.replace('_', ' ')} · ${claude.findings.length} findings  `,
    `**Codex:** ${codex.verdict.replace('_', ' ')} · ${codex.findings.length} findings`,
  ]

  for (const kind of ['conflict', 'agree', 'claude', 'codex'] as const) {
    const section = important.filter(g => g.kind === kind)
    if (!section.length) continue
    out.push('', `### ${HEADINGS[kind]} (${section.length})`)
    for (const g of section) {
      const cs = lookup(claude.findings, g.claude)
      const xs = lookup(codex.findings, g.codex)
      const title = (cs[0] ?? xs[0])?.title ?? ''
      out.push('', `**${title}**`)
      cs.forEach(f => out.push(findingBlock(f, `Claude ${f.id}`)))
      xs.forEach(f => out.push(findingBlock(f, `Codex ${f.id}`)))
      if (g.conflictNote) out.push(`- **${cs.length ? 'Codex' : 'Claude'} checked this and found it fine:** ${g.conflictNote}`)
    }
  }

  if (minor.length) {
    out.push('', `### Minor (${minor.length})`)
    for (const g of minor) {
      const cs = lookup(claude.findings, g.claude)
      const xs = lookup(codex.findings, g.codex)
      const f = cs[0] ?? xs[0]
      if (!f) continue
      const who = [cs.length ? `Claude ${g.claude.join(', ')}` : '', xs.length ? `Codex ${g.codex.join(', ')}` : ''].filter(Boolean).join(' + ')
      out.push(`- ${f.title} — ${where(f)} *(${who}${g.kind === 'conflict' ? '; the other found it fine' : ''})*`)
    }
  }
  return out.join('\n')
}

export function reviewMarkdown(output: ReviewOutput): string {
  const out: string[] = [`**Verdict:** ${output.verdict.replace('_', ' ')}`, '', output.summary]
  for (const severity of ['critical', 'major', 'minor'] as const) {
    const list = output.findings.filter(f => f.severity === severity)
    if (!list.length) continue
    out.push('', `### ${severity.charAt(0).toUpperCase()}${severity.slice(1)} (${list.length})`)
    for (const f of list) {
      out.push('', `**${f.id}. ${f.title}** — ${where(f)} · ${f.category}`, '', f.explanation)
      if (f.suggestion) out.push('', `*Fix:* ${f.suggestion}`)
    }
  }
  if (output.checked_ok.length) {
    out.push('', `### Checked and found fine (${output.checked_ok.length})`)
    output.checked_ok.forEach(c => out.push(`- \`${c.file}${c.line === null ? '' : `:${c.line}`}\` ${c.area}: ${c.note}`))
  }
  return out.join('\n')
}
