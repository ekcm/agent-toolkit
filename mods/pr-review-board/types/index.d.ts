export type AgentName = 'claude' | 'codex'

// reviewing: round 1, independent. reviewed: round 1 finished.
// responding / waiting: the debate, answering the other agent or waiting on it.
export type AgentStatus = 'queued' | 'preparing' | 'reviewing' | 'reviewed' | 'responding' | 'waiting' | 'done' | 'failed' | 'cancelled'

export type Severity = 'critical' | 'major' | 'minor'

export type Finding = {
  id: string
  file: string
  line: number | null
  end_line: number | null
  severity: Severity
  category: string
  title: string
  explanation: string
  suggestion: string | null
}

export type CheckedOk = {
  file: string
  line: number | null
  area: string
  note: string
}

export type ReviewOutput = {
  summary: string
  verdict: 'approve' | 'request_changes' | 'comment'
  findings: Finding[]
  checked_ok: CheckedOk[]
}

export type AgentRun = {
  status: AgentStatus
  startedAt: number | null
  endedAt: number | null
  activity: string | null
  activityAt: number | null
  error: string | null
  output: ReviewOutput | null
  usage: string | null
}

export type GroupKind = 'agree' | 'claude' | 'codex' | 'conflict'

export type Group = {
  kind: GroupKind
  severity: Severity
  claude: string[]
  codex: string[]
  conflictNote: string | null
}

export type VerifyStepStatus = 'pending' | 'running' | 'passed' | 'failed'

export type VerifyStep = {
  name: string
  command: string[]
  status: VerifyStepStatus
  startedAt: number | null
  durationMs: number | null
  summary: string | null
}

export type VerifyStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

export type Verification = {
  status: VerifyStatus
  steps: VerifyStep[]
  note: string | null
}

export type Stance = 'agree' | 'disagree' | 'unsure' | 'maintain' | 'withdraw'

export type DebateReply = { stance: Stance; evidence: string }

export type Resolution = 'pending' | 'confirmed' | 'withdrawn' | 'disputed'

// One disputed group: a conflict, or a major/critical finding only one agent raised.
export type DebateItem = {
  id: string
  author: AgentName
  findingIds: string[]
  isConflict: boolean
  conflictNote: string | null
  response: DebateReply | null
  rebuttal: DebateReply | null
  resolution: Resolution
}

export type DebateStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export type Debate = {
  status: DebateStatus
  round: number
  turn: AgentName | 'both' | null
  items: DebateItem[]
  note: string | null
}

export type ResultStatus = 'waiting' | 'combining' | 'verifying' | 'debating' | 'ready' | 'failed'

export type ReviewResult = {
  status: ResultStatus
  groups: Group[]
  isModelMatched: boolean
  error: string | null
}

export type Review = {
  key: string
  repoRoot: string
  repoName: string
  nameWithOwner: string | null
  isTrusted: boolean
  pr: number
  title: string
  additions: number
  deletions: number
  worktree: string
  outDir: string
  prompt: string | null
  agents: Record<AgentName, AgentRun>
  result: ReviewResult
  verify: Verification
  debate: Debate
}

export type BoardTab = 'combined' | 'claude' | 'codex'

export type BoardView = {
  selected: string | null
  tab: BoardTab
}

declare module 'claude-code' {
  interface PluginState {
    'pr-review-board': {
      reviews: Review[]
      view: BoardView
      now: number
    }
  }
}
