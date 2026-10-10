// Drawing: the board of PRs, and one PR's results with severity colours and
// a tag saying which agent each finding came from.

import type { EngineInterface, RenderChildren } from 'claude-code'

import type {
  AgentName, AgentRun, AgentStatus, BoardTab, DebateItem, Finding, Group, Review, ReviewOutput, Severity, VerifyStep,
} from '../types'
import { AGENT_NAMES, debateCounts, other } from './debate'

type Elements = ReturnType<EngineInterface['ui']['resolve']>
type Tone = 'success' | 'error' | 'warning' | 'claude' | 'suggestion' | 'subtle'
type Piece = { text: string; color?: Tone; bold?: boolean; dim?: boolean }

const AGENTS: AgentName[] = ['claude', 'codex']
const STALL_MS = 120_000

const SEVERITY_COLOR: Record<Severity, Tone> = { critical: 'error', major: 'warning', minor: 'subtle' }
const SOURCE_COLOR: Record<string, Tone> = { Claude: 'claude', Codex: 'suggestion', Both: 'success' }
const GLYPH: Record<AgentStatus, string> = {
  queued: '○', preparing: '◌', reviewing: '●', reviewed: '✓', responding: '⇄', waiting: '…', done: '✓', failed: '✗', cancelled: '–',
}
const STATUS_COLOR: Record<AgentStatus, Tone> = {
  queued: 'subtle', preparing: 'subtle', reviewing: 'claude', reviewed: 'success', responding: 'suggestion',
  waiting: 'subtle', done: 'success', failed: 'error', cancelled: 'subtle',
}
const STEP_GLYPH = { pending: '○', running: '●', passed: '✓', failed: '✗' } as const
const STEP_COLOR: Record<VerifyStep['status'], Tone> = { pending: 'subtle', running: 'suggestion', passed: 'success', failed: 'error' }

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function where(f: Finding): string {
  if (f.line === null) return f.file
  return `${f.file}:${f.line}${f.end_line && f.end_line !== f.line ? `-${f.end_line}` : ''}`
}

function severityPieces(output: ReviewOutput): Piece[] {
  const pieces: Piece[] = [{ text: `${output.findings.length} findings` }]
  for (const severity of ['critical', 'major', 'minor'] as const) {
    const n = output.findings.filter(f => f.severity === severity).length
    if (n) pieces.push({ text: ` · ${n} ${severity}`, color: SEVERITY_COLOR[severity] })
  }
  return pieces
}

const verdictText = (output: ReviewOutput) => output.verdict.replace('_', ' ')

function agentPieces(review: Review, agent: AgentName, at: number): Piece[] {
  const run = review.agents[agent]
  const output = run.output
  switch (run.status) {
    case 'queued': return [{ text: 'waiting to start', dim: true }]
    case 'preparing': return [{ text: 'setting up the worktree and fetching the PR', dim: true }]
    case 'reviewing':
    case 'responding': {
      const quiet = run.activityAt === null ? 0 : at - run.activityAt
      if (quiet > STALL_MS) return [{ text: `⚠ no activity for ${clock(quiet)} · ${run.activity ?? ''}`, color: 'warning' }]
      return [{ text: run.activity ?? '', dim: true }]
    }
    case 'reviewed':
      return output ? [{ text: `round 1 done · ${verdictText(output)} · `, dim: true }, ...severityPieces(output)] : []
    case 'waiting': {
      const note: Piece[] = run.error ? [{ text: `${run.error} · `, color: 'warning' }] : []
      return [...note, { text: `waiting for ${AGENT_NAMES[other(agent)]}`, dim: true }]
    }
    case 'done': {
      if (!output) return []
      const warn: Piece[] = run.error ? [{ text: ` · ${run.error}`, color: 'warning' }] : []
      return [{ text: `${verdictText(output)} · `, dim: true }, ...severityPieces(output), { text: run.usage ? ` · ${run.usage}` : '', dim: true }, ...warn]
    }
    case 'failed': return [{ text: run.error ?? 'failed', color: 'error' }]
    case 'cancelled': return [{ text: 'cancelled', dim: true }]
  }
}

function elapsed(run: AgentRun, at: number): string {
  if (run.startedAt === null) return '—'
  return clock((run.endedAt ?? Math.max(at, run.startedAt)) - run.startedAt)
}

function verifyPieces(review: Review, at: number): Piece[] {
  const { verify } = review
  if (verify.status === 'skipped') return [{ text: verify.note ?? 'skipped', dim: true }]
  const pieces: Piece[] = []
  verify.steps.forEach((step, index) => {
    const time = step.status === 'running' && step.startedAt !== null ? ` ${clock(at - step.startedAt)}`
      : step.durationMs !== null ? ` ${clock(step.durationMs)}` : ''
    const summary = step.summary && step.status !== 'running' ? ` (${step.summary})` : ''
    pieces.push({ text: `${index ? ' · ' : ''}${STEP_GLYPH[step.status]} ${step.name}${time}${summary}`, color: STEP_COLOR[step.status] })
  })
  if (verify.note) pieces.push({ text: ` · ${verify.note}`, dim: true })
  return pieces
}

// Groups that were not debated and have one author.
function oneSidedCounts(review: Review): { claude: number; codex: number; conflict: number } {
  const debated = new Set(review.debate.items.map(i => `${i.author}:${i.findingIds[0]}`))
  const counts = { claude: 0, codex: 0, conflict: 0 }
  for (const g of review.result.groups) {
    if (g.kind === 'agree') continue
    const author = g.claude.length ? 'claude' : 'codex'
    if (debated.has(`${author}:${(author === 'claude' ? g.claude : g.codex)[0]}`)) continue
    if (g.kind === 'conflict') counts.conflict += 1
    else counts[author] += 1
  }
  return counts
}

function resultPieces(review: Review): Piece[] {
  const { result, debate } = review
  switch (result.status) {
    case 'combining': return [{ text: '● combining the two reviews', color: 'suggestion' }]
    case 'verifying': {
      const step = review.verify.steps.find(s => s.status === 'running')
      return [{ text: `🔧 verifying${step ? ` · ${step.name} (${step.command.join(' ')})` : ''}`, color: 'suggestion' }]
    }
    case 'debating': {
      const arrow = debate.turn === 'both' || debate.turn === null ? 'Claude ⇄ Codex' : `${AGENT_NAMES[other(debate.turn)]} → ${AGENT_NAMES[debate.turn]}`
      return [{ text: `⇄ debating · round ${debate.round}/2 · ${arrow} · ${debate.items.length} disputed items`, color: 'suggestion' }]
    }
    case 'failed': return [{ text: `✗ ${result.error ?? 'could not finish'}`, color: 'error' }]
    case 'waiting': {
      const stuck = AGENTS.filter(a => ['failed', 'cancelled'].includes(review.agents[a].status) && !review.agents[a].output)
      if (stuck.length) return [{ text: `needs both reviews · retry ${stuck.map(a => AGENT_NAMES[a]).join(' and ')}`, dim: true }]
      const done = AGENTS.filter(a => review.agents[a].output)
      return [{ text: done.length ? 'waiting for the other reviewer' : 'waiting for both reviewers', dim: true }]
    }
    case 'ready': {
      const agree = result.groups.filter(g => g.kind === 'agree').length
      const loose = oneSidedCounts(review)
      const pieces: Piece[] = [{ text: '✓ ready  ', color: 'success', bold: true }, { text: `⇄ ${agree} agree` }]
      if (debate.status === 'done') {
        const d = debateCounts(debate.items)
        pieces.push(
          { text: ` · ✓ ${d.confirmed} confirmed`, color: 'success' },
          { text: ` · ⚔ ${d.disputed} disputed`, color: d.disputed ? 'error' : 'subtle' },
          { text: ` · ↩ ${d.withdrawn} withdrawn`, color: 'subtle' },
        )
      }
      if (loose.conflict) pieces.push({ text: ` · ✗ ${loose.conflict} conflicts`, color: 'error' })
      pieces.push({ text: ` · ◐ ${loose.claude} Claude only`, color: 'claude' }, { text: ` · ◑ ${loose.codex} Codex only`, color: 'suggestion' })
      return pieces
    }
  }
}

export function notifyText(review: Review): string {
  return resultPieces(review).map(p => p.text).join('').replace(/^✓ ready\s+/, '')
}

// ---------- the board ----------

// Result stages that are still running, so the review cannot be removed yet.
const PIPELINE_RUNNING = ['combining', 'verifying', 'debating']

type BoardProps = {
  elements: Elements
  reviews: Review[]
  at: number
  isBusy: (review: Review) => boolean
  isActive: (run: AgentRun) => boolean
  onOpen: (key: string) => unknown
  onCancel: (key: string, agent: AgentName) => unknown
  onRetry: (key: string, agent: AgentName) => unknown
  onRecombine: (key: string) => unknown
  onRemove: (key: string) => unknown
  onClose: () => unknown
}

function Pieces({ elements, pieces }: { elements: Elements; pieces: Piece[] }) {
  const { Text } = elements
  return (
    <Text wrap="truncate-end">
      {pieces.map(p => <Text color={p.color} bold={p.bold} dimColor={p.dim}>{p.text}</Text>)}
    </Text>
  )
}

function Row({ elements, label, children }: { elements: Elements; label: string; children: RenderChildren }) {
  const { Box, Text } = elements
  return (
    <Box flexDirection="row" width="100%" gap={1} paddingLeft={2}>
      <Box width={6} flexShrink={0}><Text>{label}</Text></Box>
      {children}
    </Box>
  )
}

export function Board(props: BoardProps) {
  const { elements, reviews, at } = props
  const { Box, Text, Button } = elements
  if (!reviews.length) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No reviews yet. Run /review-prs 19 22 inside a repo, or /review-prs ~/path/to/repo 19.</Text>
        <Button key="close" hotkey="x" role="dismiss" onPress={props.onClose}>close</Button>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {reviews.map((review, index) => {
        const isIdle = !props.isBusy(review) && !PIPELINE_RUNNING.includes(review.result.status)
        const canRecombine = !props.isBusy(review) && Boolean(review.agents.claude.output && review.agents.codex.output)
        return (
          <Box key={review.key} flexDirection="column" marginBottom={1}>
            <Button key={`open-${review.key}`} plain hotkey={index < 9 ? String(index + 1) : undefined} onPress={() => props.onOpen(review.key)}>
              {`#${review.pr} `}<Text bold>{review.title}</Text>
              <Text dimColor>{`  ${review.nameWithOwner ?? review.repoName}  +${review.additions} −${review.deletions}`}</Text>
            </Button>
            {AGENTS.map(agent => {
              const run = review.agents[agent]
              return (
                <Box key={`${review.key}-${agent}`} flexDirection="column">
                  <Row elements={elements} label={AGENT_NAMES[agent]}>
                    <Box width={13} flexShrink={0}>
                      <Text color={STATUS_COLOR[run.status]}>{`${GLYPH[run.status]} ${run.status}`}</Text>
                    </Box>
                    <Box width={7} flexShrink={0} justifyContent="flex-end"><Text>{elapsed(run, at)}</Text></Box>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}><Pieces elements={elements} pieces={agentPieces(review, agent, at)} /></Box>
                    {props.isActive(run)
                      ? <Button key={`cancel-${review.key}-${agent}`} dimColor onPress={() => props.onCancel(review.key, agent)}>cancel</Button>
                      : (run.status === 'failed' || run.status === 'cancelled') && !run.output
                        ? <Button key={`retry-${review.key}-${agent}`} onPress={() => props.onRetry(review.key, agent)}>retry</Button>
                        : null}
                  </Row>
                </Box>
              )
            })}
            {review.verify.status !== 'pending' && (
              <Row elements={elements} label="Verify">
                <Box flexGrow={1} flexShrink={1} minWidth={0}><Pieces elements={elements} pieces={verifyPieces(review, at)} /></Box>
              </Row>
            )}
            <Row elements={elements} label="Result">
              <Box flexGrow={1} flexShrink={1} minWidth={0}><Pieces elements={elements} pieces={resultPieces(review)} /></Box>
              {canRecombine && (
                <Button key={`recombine-${review.key}`} dimColor onPress={() => props.onRecombine(review.key)}>recombine</Button>
              )}
              {isIdle && (
                <Button key={`remove-${review.key}`} dimColor onPress={() => props.onRemove(review.key)}>remove</Button>
              )}
            </Row>
          </Box>
        )
      })}
      <Text dimColor>Open a PR's results: click its title, or ctrl+x tab to focus this panel and press its number. Saved in ~/.agent-toolkit/pr-reviews.</Text>
      <Button key="close" hotkey="x" role="dismiss" onPress={props.onClose}>close</Button>
    </Box>
  )
}

// ---------- one PR's results ----------

type Section = 'disputed' | 'conflict' | 'agree' | 'one-sided' | 'withdrawn'

type Entry = {
  section: Section
  severity: Severity
  source: 'Both' | 'Claude' | 'Codex'
  note: string | null
  title: string
  place: string
  lines: Array<{ who: string; whoColor: Tone; text: string }>
}

const SECTION_TITLE: Record<Section, { text: string; color: Tone }> = {
  disputed: { text: '⚔ Still disputed after the debate', color: 'error' },
  conflict: { text: '✗ Conflicts', color: 'error' },
  agree: { text: '⇄ Both agree', color: 'success' },
  'one-sided': { text: 'One reviewer only', color: 'warning' },
  withdrawn: { text: '↩ Withdrawn in the debate', color: 'subtle' },
}
const SECTION_ORDER: Section[] = ['disputed', 'conflict', 'agree', 'one-sided', 'withdrawn']
const RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 }

function itemFor(group: Group, items: DebateItem[]): DebateItem | undefined {
  return items.find(item => (item.author === 'claude' ? group.claude : group.codex).includes(item.findingIds[0] ?? ''))
}

function entries(review: Review): Entry[] {
  const outputs = { claude: review.agents.claude.output!, codex: review.agents.codex.output! }
  const list: Entry[] = []
  for (const group of review.result.groups) {
    const found = [
      ...group.claude.map(id => ({ agent: 'claude' as const, f: outputs.claude.findings.find(x => x.id === id) })),
      ...group.codex.map(id => ({ agent: 'codex' as const, f: outputs.codex.findings.find(x => x.id === id) })),
    ].filter((x): x is { agent: AgentName; f: Finding } => Boolean(x.f))
    const first = found[0]
    if (!first) continue
    const item = itemFor(group, review.debate.items)
    const author: AgentName = group.claude.length ? 'claude' : 'codex'
    let section: Section = group.kind === 'agree' ? 'agree' : group.kind === 'conflict' ? 'conflict' : 'one-sided'
    let note: string | null = null
    if (item?.resolution === 'confirmed') {
      section = 'agree'
      note = `confirmed by ${AGENT_NAMES[other(author)]} in the debate`
    } else if (item?.resolution === 'disputed') section = 'disputed'
    else if (item?.resolution === 'withdrawn') section = 'withdrawn'

    const lines: Entry['lines'] = found.map(({ agent, f }) => ({
      who: `${AGENT_NAMES[agent]} ${f.id}`, whoColor: SOURCE_COLOR[AGENT_NAMES[agent]]!,
      text: `${f.explanation}${f.suggestion ? `  Fix: ${f.suggestion}` : ''}`,
    }))
    if (group.conflictNote) {
      lines.push({ who: `${AGENT_NAMES[other(author)]} judged fine`, whoColor: SOURCE_COLOR[AGENT_NAMES[other(author)]]!, text: group.conflictNote })
    }
    if (item?.response) {
      const responder = AGENT_NAMES[other(item.author)]
      lines.push({ who: `${responder}, debate 1`, whoColor: SOURCE_COLOR[responder]!, text: `${item.response.stance}: ${item.response.evidence}` })
    }
    if (item?.rebuttal) {
      const writer = AGENT_NAMES[item.author]
      lines.push({ who: `${writer}, debate 2`, whoColor: SOURCE_COLOR[writer]!, text: `${item.rebuttal.stance}: ${item.rebuttal.evidence}` })
    }
    list.push({
      section, severity: group.severity, note,
      source: group.kind === 'agree' || item?.resolution === 'confirmed' ? 'Both' : AGENT_NAMES[author] as 'Claude' | 'Codex',
      title: first.f.title, place: where(first.f), lines,
    })
  }
  return list.sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || RANK[b.severity] - RANK[a.severity])
}

function EntryView({ elements, entry }: { elements: Elements; entry: Entry }) {
  const { Box, Text } = elements
  const isDim = entry.section === 'withdrawn'
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text wrap="wrap">
        <Text color={SEVERITY_COLOR[entry.severity]} bold>{entry.severity.toUpperCase().padEnd(9)}</Text>
        <Text color={SOURCE_COLOR[entry.source]} bold>{entry.source.padEnd(7)}</Text>
        <Text bold={!isDim} dimColor={isDim} strikethrough={isDim}>{entry.title}</Text>
        <Text dimColor>{`  ${entry.place}`}</Text>
        {entry.note && <Text color="success">{`  (${entry.note})`}</Text>}
      </Text>
      {entry.lines.map(line => (
        <Box paddingLeft={2}>
          <Text wrap="wrap" dimColor={isDim}><Text color={line.whoColor}>{`${line.who}: `}</Text>{line.text}</Text>
        </Box>
      ))}
    </Box>
  )
}

function CombinedView({ elements, review }: { elements: Elements; review: Review }) {
  const { Box, Text } = elements
  if (review.result.status !== 'ready' || !review.agents.claude.output || !review.agents.codex.output) {
    return <Pieces elements={elements} pieces={[{ text: 'Not ready yet: ', dim: true }, ...resultPieces(review)]} />
  }
  const all = entries(review)
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="claude" bold>Claude </Text><Text>{`${verdictText(review.agents.claude.output)} · ${review.agents.claude.output.findings.length} findings    `}</Text>
        <Text color="suggestion" bold>Codex </Text><Text>{`${verdictText(review.agents.codex.output)} · ${review.agents.codex.output.findings.length} findings`}</Text>
      </Text>
      {review.verify.status !== 'pending' && <Pieces elements={elements} pieces={[{ text: 'Verify  ', bold: true }, ...verifyPieces(review, 0)]} />}
      {review.debate.status === 'skipped' && <Text dimColor>{`Debate: ${review.debate.note ?? 'skipped'}`}</Text>}
      {!review.result.isModelMatched && <Text color="warning">Matched by line only, with no conflict check: the matching step did not answer. Press recombine on the board to try again.</Text>}
      {SECTION_ORDER.map(section => {
        const inSection = all.filter(e => e.section === section)
        if (!inSection.length) return null
        return (
          <Box key={section} flexDirection="column" marginTop={1}>
            <Text color={SECTION_TITLE[section].color} bold>{`${SECTION_TITLE[section].text} (${inSection.length})`}</Text>
            {inSection.map(entry => <EntryView elements={elements} entry={entry} />)}
          </Box>
        )
      })}
    </Box>
  )
}

function AgentView({ elements, review, agent }: { elements: Elements; review: Review; agent: AgentName }) {
  const { Box, Text } = elements
  const run = review.agents[agent]
  const output = run.output
  if (!output) return <Text dimColor>{`${AGENT_NAMES[agent]}: ${run.status}${run.error ? `: ${run.error}` : ''}`}</Text>
  const findings = [...output.findings].sort((a, b) => RANK[b.severity] - RANK[a.severity])
  return (
    <Box flexDirection="column">
      <Pieces elements={elements} pieces={[{ text: `${verdictText(output)} · `, bold: true }, ...severityPieces(output)]} />
      <Text wrap="wrap">{output.summary}</Text>
      {findings.map(f => (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="wrap">
            <Text color={SEVERITY_COLOR[f.severity]} bold>{f.severity.toUpperCase().padEnd(9)}</Text>
            <Text bold>{`${f.id}. ${f.title}`}</Text><Text dimColor>{`  ${where(f)} · ${f.category}`}</Text>
          </Text>
          <Box paddingLeft={2}><Text wrap="wrap">{f.explanation}</Text></Box>
          {f.suggestion && <Box paddingLeft={2}><Text wrap="wrap" dimColor>{`Fix: ${f.suggestion}`}</Text></Box>}
        </Box>
      ))}
      {output.checked_ok.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="success" bold>{`Checked and found fine (${output.checked_ok.length})`}</Text>
          {output.checked_ok.map(c => (
            <Box paddingLeft={2}><Text wrap="wrap" dimColor>{`${c.file}${c.line === null ? '' : `:${c.line}`}  ${c.area}: ${c.note}`}</Text></Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

type DetailProps = {
  elements: Elements
  review: Review
  tab: BoardTab
  onBack: () => unknown
  onTab: (tab: BoardTab) => unknown
  onClose: () => unknown
}

const TABS: BoardTab[] = ['combined', 'claude', 'codex']
const TAB_LABEL: Record<BoardTab, string> = { combined: 'Combined', claude: 'Claude', codex: 'Codex' }

export function Detail({ elements, review, tab, onBack, onTab, onClose }: DetailProps) {
  const { Box, Text, Button } = elements
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key="back" hotkey="b" onPress={onBack}>back</Button>
        {TABS.map((each, index) => (
          <Button key={`tab-${each}`} hotkey={String(index + 1)} variant={tab === each ? 'primary' : 'secondary'} onPress={() => onTab(each)}>
            {TAB_LABEL[each]}
          </Button>
        ))}
        <Button key="close" hotkey="x" role="dismiss" onPress={onClose}>close</Button>
      </Box>
      <Text bold>{`${review.nameWithOwner ?? review.repoName} #${review.pr}: ${review.title}`}</Text>
      <Text dimColor>1 Combined · 2 Claude · 3 Codex · b back · x close (ctrl+x tab focuses the panel first)</Text>
      <Box marginTop={1} flexDirection="column">
        {tab === 'combined'
          ? <CombinedView elements={elements} review={review} />
          : <AgentView elements={elements} review={review} agent={tab} />}
      </Box>
    </Box>
  )
}
