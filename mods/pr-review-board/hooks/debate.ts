// The debate after round 1, on disputed items only: conflicts, and major or
// critical findings only one agent raised.
//
// Round 1: each agent answers the other's items (agree, disagree, unsure).
// Round 2: an author answers each disagreement on its own items (maintain or
// withdraw). Agreement confirms an item; withdrawal drops it; anything else
// stays disputed with both sides' evidence.

import type { AgentName, DebateItem, DebateReply, Finding, Group, ReviewOutput, Stance } from '../types'

export const AGENT_NAMES: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex' }
export const other = (agent: AgentName): AgentName => (agent === 'claude' ? 'codex' : 'claude')

export const DEBATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['responses'],
  properties: {
    responses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'stance', 'evidence'],
        properties: {
          item: { type: 'string', description: 'The item id, such as D1.' },
          stance: { type: 'string', enum: ['agree', 'disagree', 'unsure', 'maintain', 'withdraw'] },
          evidence: { type: 'string', description: 'file:line, quoted code, or verification output that supports the stance.' },
        },
      },
    },
  },
} as const

export function debateItems(groups: Group[]): DebateItem[] {
  const items: DebateItem[] = []
  for (const group of groups) {
    if (group.kind === 'agree') continue
    if (group.kind !== 'conflict' && group.severity === 'minor') continue
    const author: AgentName = group.claude.length ? 'claude' : 'codex'
    items.push({
      id: `D${items.length + 1}`,
      author,
      findingIds: author === 'claude' ? group.claude : group.codex,
      isConflict: group.kind === 'conflict',
      conflictNote: group.conflictNote,
      response: null,
      rebuttal: null,
      resolution: 'pending',
    })
  }
  return items
}

function findingsOf(item: DebateItem, outputs: Record<AgentName, ReviewOutput>): Finding[] {
  return item.findingIds.map(id => outputs[item.author].findings.find(f => f.id === id)).filter((f): f is Finding => Boolean(f))
}

function where(f: Finding): string {
  if (f.line === null) return f.file
  return `${f.file}:${f.line}${f.end_line && f.end_line !== f.line ? `-${f.end_line}` : ''}`
}

function describe(item: DebateItem, outputs: Record<AgentName, ReviewOutput>): string {
  return findingsOf(item, outputs).map(f =>
    `   ${AGENT_NAMES[item.author]} ${f.id} (${f.severity}, ${where(f)}): ${f.title}\n   ${f.explanation}${f.suggestion ? `\n   Suggested fix: ${f.suggestion}` : ''}`,
  ).join('\n')
}

const RULES = `Do not agree because another reviewer said so, and do not disagree without evidence. Evidence is a file:line with the code quoted, or a line from the verification output.

This is read-only. Do not create, modify or delete files, and do not run installs, tests or builds: the verification results above already ran them. Reading files and running git, grep and similar read-only commands is fine.

Return only JSON matching the provided schema, one response per item.`

export function roundOnePrompt(
  agent: AgentName, pr: number, items: DebateItem[], outputs: Record<AgentName, ReviewOutput>, verification: string,
): string {
  const author = AGENT_NAMES[other(agent)]
  const blocks = items.map(item => {
    const conflict = item.isConflict && item.conflictNote ? `\n   You checked this area earlier and judged it fine: "${item.conflictNote}"` : ''
    return `${item.id}:\n${describe(item, outputs)}${conflict}`
  })
  return `Earlier you reviewed pull request #${pr} in this repository, independently of another reviewer (${author}). ${author} raised the findings below, which you either did not raise or judged fine. Check each one against the code and the verification results, then respond.

Verification results (run by the review tool in this worktree; full logs in .review-input/verify/):
${verification}

Items:
${blocks.join('\n\n')}

For each item, answer with one stance:
- agree: the problem is real.
- disagree: it is not a problem, and your evidence shows why.
- unsure: the code and verification results do not settle it.

${RULES}`
}

export function roundTwoPrompt(
  agent: AgentName, pr: number, items: DebateItem[], outputs: Record<AgentName, ReviewOutput>, verification: string,
): string {
  const responder = AGENT_NAMES[other(agent)]
  const blocks = items.map(item =>
    `${item.id}:\n${describe(item, outputs)}\n   ${responder} disagreed: ${item.response?.evidence ?? ''}`,
  )
  return `Earlier you reviewed pull request #${pr} in this repository. Another reviewer (${responder}) checked the findings of yours below and disagreed. Read its evidence, re-check the code and the verification results, and decide.

Verification results (run by the review tool in this worktree; full logs in .review-input/verify/):
${verification}

Items:
${blocks.join('\n\n')}

For each item, answer with one stance:
- maintain: it is still a real problem, and your evidence shows why theirs does not hold.
- withdraw: their evidence shows it is not a problem.

${RULES}`
}

export function readReplies(value: unknown, ids: string[], allowed: Stance[]): Map<string, DebateReply> | null {
  const responses = (value as { responses?: unknown } | null)?.responses
  if (!Array.isArray(responses)) return null
  const replies = new Map<string, DebateReply>()
  for (const r of responses) {
    if (typeof r?.item !== 'string' || !ids.includes(r.item)) continue
    if (!allowed.includes(r.stance)) continue
    replies.set(r.item, { stance: r.stance, evidence: String(r.evidence ?? '') })
  }
  return replies
}

export function applyRoundOne(items: DebateItem[], replies: Map<string, DebateReply>): DebateItem[] {
  return items.map(item => {
    const response = replies.get(item.id) ?? null
    if (!response) return item
    const resolution = response.stance === 'agree' ? 'confirmed' : response.stance === 'unsure' ? 'disputed' : 'pending'
    return { ...item, response, resolution }
  })
}

export function applyRoundTwo(items: DebateItem[], replies: Map<string, DebateReply>): DebateItem[] {
  return items.map(item => {
    if (item.resolution !== 'pending') return item
    const rebuttal = replies.get(item.id) ?? null
    return { ...item, rebuttal, resolution: rebuttal?.stance === 'withdraw' ? 'withdrawn' : 'disputed' }
  })
}

// Items still open when a round could not run end up disputed.
export function closeOpen(items: DebateItem[]): DebateItem[] {
  return items.map(item => (item.resolution === 'pending' ? { ...item, resolution: 'disputed' } : item))
}

export function debateCounts(items: DebateItem[]): { confirmed: number; withdrawn: number; disputed: number } {
  return {
    confirmed: items.filter(i => i.resolution === 'confirmed').length,
    withdrawn: items.filter(i => i.resolution === 'withdrawn').length,
    disputed: items.filter(i => i.resolution === 'disputed').length,
  }
}
