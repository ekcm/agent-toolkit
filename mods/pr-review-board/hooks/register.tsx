import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentName, AgentRun, AgentStatus, BoardView, Debate, DebateItem, Group, Review, ReviewOutput, Verification,
} from '../types'
import {
  applyRoundOne, applyRoundTwo, closeOpen, DEBATE_SCHEMA, debateItems, other, readReplies, roundOnePrompt, roundTwoPrompt,
} from './debate'
import {
  buildGroups, combinedMarkdown, conflictCandidates, linePairs, MATCH_SYSTEM, matchPrompt, parseMatchReply,
} from './reconcile'
import type { Conflict, Pair } from './reconcile'
import { CLAUDE_ALLOWED_TOOLS, CLAUDE_DISALLOWED_TOOLS, FINDINGS_SCHEMA, INPUT_DIR, reviewPrompt } from './review-spec'
import { isReviewOutput, lineSplitter, readClaudeEvent, readCodexEvent } from './stream'
import { detectSteps, evidence, summarize, tailOf } from './verify'
import { Board, Detail, notifyText } from './view'

type $ = EngineInterface

const PANE = 'pr-reviews'
const AGENTS: AgentName[] = ['claude', 'codex']
const MATCH_MODEL = 'sonnet'
const STEP_TIMEOUT_MS = 600_000
const TRUSTED_KEY = 'trusted-repos'

const reviews = atom({ plugin: 'pr-review-board', key: 'reviews' } as const, [] as Review[])
const view = atom({ plugin: 'pr-review-board', key: 'view' } as const, { selected: null, tab: 'combined' } as BoardView)
const now = atom({ plugin: 'pr-review-board', key: 'now' } as const, 0)

// Module-local: a reload drops these, and kills the children with them.
const running = new Map<string, { stop: () => void }>()
const stopped = new Set<string>()
const pipelines = new Set<string>()
const repoQueues = new Map<string, Promise<unknown>>()
const verifyLogs = new Map<string, Record<string, string>>()
let ticker: { cancel: () => void } | null = null
let viewerLogin: string | null = null

const ACTIVE: AgentStatus[] = ['queued', 'preparing', 'reviewing', 'responding']
const isActive = (run: AgentRun) => ACTIVE.includes(run.status)
const isBusy = (review: Review) => AGENTS.some(a => isActive(review.agents[a]))
  || ['combining', 'verifying', 'debating'].includes(review.result.status)
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const runId = (key: string, agent: AgentName) => `${key}:${agent}`

const freshRun = (status: AgentStatus, startedAt: number | null): AgentRun => ({
  status, startedAt, endedAt: null, activity: null, activityAt: null, error: null, output: null, usage: null,
})
const freshVerify = (): Verification => ({ status: 'pending', steps: [], note: null })
const freshDebate = (): Debate => ({ status: 'pending', round: 0, turn: null, items: [], note: null })
const freshResult = (): Review['result'] => ({ status: 'waiting', groups: [], isModelMatched: false, error: null })

async function patchReview($: $, key: string, fn: (review: Review) => Review) {
  await update($, reviews, list => list.map(review => (review.key === key ? fn(review) : review)))
}

async function patchAgent($: $, key: string, agent: AgentName, patch: Partial<AgentRun>) {
  await patchReview($, key, review => ({ ...review, agents: { ...review.agents, [agent]: { ...review.agents[agent], ...patch } } }))
}

async function getReview($: $, key: string): Promise<Review | undefined> {
  return (await read($, reviews)).find(review => review.key === key)
}

async function run($: $, argv: string[], cwd?: string, timeoutMs = 120_000): Promise<string> {
  const result = await $.process.run(argv, { cwd, timeoutMs })
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').pop() ?? ''
    throw new Error(`${argv.slice(0, 3).join(' ')} failed: ${detail}`)
  }
  return result.stdout.trim()
}

// Git worktree and fetch commands on one repo run one at a time.
function inRepoQueue<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(root) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  repoQueues.set(root, next)
  return next
}

async function trustedRepos($: $): Promise<string[]> {
  const value = await $.store.get(TRUSTED_KEY)
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// Verification runs the PR's code, so it runs only when the repo is the
// person's own or one they approved, and the PR's branch lives in that repo
// (or in their own fork).
async function decideTrust($: $, root: string, meta: { isCrossRepository?: boolean; headRepositoryOwner?: { login?: string } }) {
  viewerLogin ??= await run($, ['gh', 'api', 'user', '--jq', '.login'], root)
  const repo = JSON.parse(await run($, ['gh', 'repo', 'view', '--json', 'nameWithOwner,owner'], root)) as { nameWithOwner: string; owner: { login: string } }
  const approved = await trustedRepos($)
  const isRepoTrusted = repo.owner.login === viewerLogin || approved.includes(repo.nameWithOwner)
  const isBranchTrusted = !meta.isCrossRepository || meta.headRepositoryOwner?.login === viewerLogin
  return { nameWithOwner: repo.nameWithOwner, isTrusted: isRepoTrusted && isBranchTrusted }
}

// Fetches the PR into refs/pr-review/<n>, checks it out as a detached
// worktree, saves the PR's metadata and diff for both reviewers, and answers
// the prompt they are given.
async function prepare($: $, review: Review): Promise<string> {
  const { repoRoot: root, pr } = review
  const meta = JSON.parse(await run($, ['gh', 'pr', 'view', String(pr), '--json',
    'number,title,body,author,url,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,files,commits,isCrossRepository,headRepositoryOwner'], root))
  const trust = await decideTrust($, root, meta)
  await patchReview($, review.key, r => ({ ...r, ...trust, title: meta.title, additions: meta.additions, deletions: meta.deletions }))
  const diff = await run($, ['gh', 'pr', 'diff', String(pr)], root)

  await inRepoQueue(root, async () => {
    await run($, ['git', '-C', root, 'fetch', '--quiet', 'origin',
      `+refs/pull/${pr}/head:refs/pr-review/${pr}`,
      `+refs/heads/${meta.baseRefName}:refs/remotes/origin/${meta.baseRefName}`], undefined, 300_000)
    if (await $.fs.exists(review.worktree)) {
      await $.process.run(['git', '-C', root, 'worktree', 'remove', '--force', review.worktree])
    }
    await $.process.run(['git', '-C', root, 'worktree', 'prune'])
    await run($, ['git', '-C', root, 'worktree', 'add', '--detach', review.worktree, `refs/pr-review/${pr}`], undefined, 300_000)
  })

  const mergeBase = await run($, ['git', '-C', review.worktree, 'merge-base', 'HEAD', `origin/${meta.baseRefName}`])
  await $.fs.write(`${review.worktree}/${INPUT_DIR}/pr.json`, JSON.stringify(meta, null, 2))
  await $.fs.write(`${review.worktree}/${INPUT_DIR}/pr.diff`, diff)
  return reviewPrompt({ pr, headSha: meta.headRefOid, baseRef: meta.baseRefName, mergeBase })
}

async function prepareAndReview($: $, key: string) {
  const review = await getReview($, key)
  if (!review) return
  let prompt: string
  try {
    prompt = await prepare($, review)
  } catch (err) {
    const endedAt = await $.clock.now()
    await patchReview($, key, r => (r.title === 'loading…' ? { ...r, title: 'setup failed' } : r))
    for (const agent of AGENTS) {
      if (!stopped.has(runId(key, agent))) await patchAgent($, key, agent, { status: 'failed', endedAt, error: `Setup failed: ${message(err)}` })
    }
    return
  }
  await patchReview($, key, r => ({ ...r, prompt }))
  await Promise.all(AGENTS.filter(agent => !stopped.has(runId(key, agent))).map(agent => reviewRound($, key, agent, prompt)))
}

// ---------- running an agent ----------

type AgentCall = { prompt: string; schema: object; phase: string }
type AgentAnswer = { structured: unknown; error: string | null; usage: string | null; isCancelled: boolean }

function agentArgv(agent: AgentName, review: Review, call: AgentCall): string[] {
  if (agent === 'codex') {
    return ['codex', 'exec', '--sandbox', 'read-only', '-C', review.worktree, '--ephemeral',
      '--output-schema', `${review.outDir}/${call.phase}.schema.json`, '-o', `${review.outDir}/codex.${call.phase}.json`, '--json', call.prompt]
  }
  return ['claude', '-p', call.prompt, '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(call.schema),
    '--allowedTools', ...CLAUDE_ALLOWED_TOOLS, '--disallowedTools', ...CLAUDE_DISALLOWED_TOOLS]
}

// Runs one agent to completion, streaming its activity into the panel.
async function callAgent($: $, review: Review, agent: AgentName, call: AgentCall): Promise<AgentAnswer> {
  const id = runId(review.key, agent)
  await $.fs.write(`${review.outDir}/${call.phase}.schema.json`, JSON.stringify(call.schema, null, 2))
  const readEvent = agent === 'codex' ? readCodexEvent : readClaudeEvent
  const toLines = lineSplitter()
  let structured: unknown = null
  let error: string | null = null
  let usage: string | null = null
  let stderrTail = ''
  let exitCode: number | null = null

  const child = $.process.spawn({ argv: agentArgv(agent, review, call), cwd: review.worktree })
  running.set(id, { stop: () => void child.return(undefined as never) })
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        stderrTail = (stderrTail + text).slice(-2000)
        continue
      }
      for (const line of toLines(text)) {
        const found = readEvent(line)
        if (found.usage) usage = found.usage
        if (found.structured !== undefined) structured = found.structured
        if (found.error) error = found.error
        if (found.activity) await patchAgent($, review.key, agent, { activity: found.activity, activityAt: await $.clock.now() })
      }
    }
    exitCode = (await child.result).code
  } catch (err) {
    error = error ?? `Could not run ${agent}: ${message(err)}`
  } finally {
    running.delete(id)
  }

  if (stopped.has(id)) return { structured: null, error: null, usage, isCancelled: true }
  if (agent === 'codex' && structured === null && !error) {
    try {
      structured = JSON.parse(await $.fs.read(`${review.outDir}/codex.${call.phase}.json`))
    } catch {
      error = 'Codex finished without writing its answer'
    }
  }
  if (structured === null && !error) {
    const lastLine = stderrTail.trim().split('\n').pop() ?? ''
    error = exitCode ? `Exited with code ${exitCode}${lastLine ? `: ${lastLine}` : ''}` : 'Finished without an answer'
  }
  return { structured, error, usage, isCancelled: false }
}

// Round 1: the independent review.
async function reviewRound($: $, key: string, agent: AgentName, prompt: string) {
  const review = await getReview($, key)
  if (!review) return
  stopped.delete(runId(key, agent))
  const startedAt = review.agents[agent].startedAt ?? await $.clock.now()
  await patchAgent($, key, agent, { ...freshRun('reviewing', startedAt), activity: 'starting', activityAt: await $.clock.now() })
  startTicker($)

  const answer = await callAgent($, review, agent, { prompt, schema: FINDINGS_SCHEMA, phase: 'review' })
  const endedAt = await $.clock.now()
  if (answer.isCancelled) {
    await patchAgent($, key, agent, { status: 'cancelled', endedAt, activity: null })
    return
  }
  if (!answer.error && isReviewOutput(answer.structured)) {
    const output: ReviewOutput = answer.structured
    await $.fs.write(`${review.outDir}/${agent}.json`, JSON.stringify(output, null, 2))
    await patchAgent($, key, agent, { status: 'reviewed', output, usage: answer.usage, activity: null, error: null })
    await runPipelineWhenReady($, key)
  } else {
    await patchAgent($, key, agent, {
      status: 'failed', endedAt, usage: answer.usage,
      error: answer.error ?? `${agent} answered, but not in the review format`,
    })
  }
}

// ---------- after round 1: combine, verify, debate ----------

async function runPipelineWhenReady($: $, key: string, isForced = false) {
  const review = await getReview($, key)
  if (!review || pipelines.has(key)) return
  if (!review.agents.claude.output || !review.agents.codex.output) return
  if (!isForced && AGENTS.some(a => review.agents[a].status !== 'reviewed')) return

  pipelines.add(key)
  try {
    if (review.nameWithOwner === null) {
      // Saved by an earlier version of the mod: work out trust from the saved PR details.
      const meta = JSON.parse(await $.fs.read(`${review.worktree}/${INPUT_DIR}/pr.json`))
      const trust = await decideTrust($, review.repoRoot, meta)
      await patchReview($, key, r => ({ ...r, ...trust }))
    }
    for (const agent of AGENTS) await patchAgent($, key, agent, { status: 'reviewed', error: null, endedAt: null })
    await patchReview($, key, r => ({ ...r, result: { ...freshResult(), status: 'combining' }, verify: freshVerify(), debate: freshDebate() }))
    startTicker($)
    const groups = await combine($, key)
    await verify($, key)
    await debate($, key, groups)
    await finish($, key)
  } catch (err) {
    await patchReview($, key, r => ({ ...r, result: { ...r.result, status: 'failed', error: message(err) } }))
  } finally {
    pipelines.delete(key)
  }
}

async function combine($: $, key: string): Promise<Group[]> {
  const review = (await getReview($, key))!
  const claude = review.agents.claude.output!
  const codex = review.agents.codex.output!
  const proposed = linePairs(claude.findings, codex.findings)
  const candidates = conflictCandidates(claude, codex)
  let pairs: Pair[] = proposed
  let conflicts: Conflict[] = []
  let isModelMatched = false
  if (claude.findings.length + codex.findings.length > 0) {
    const reply = await $.model.complete({
      model: MATCH_MODEL, system: MATCH_SYSTEM, maxTokens: 3000,
      prompt: matchPrompt(claude.findings, codex.findings, proposed, candidates),
    })
    const matched = reply.isAnswered ? parseMatchReply(reply.text, claude.findings, codex.findings, candidates) : null
    if (matched) {
      pairs = matched.pairs
      conflicts = matched.conflicts
      isModelMatched = true
    }
  }
  const groups = buildGroups(claude, codex, pairs, conflicts)
  await $.fs.write(`${review.outDir}/matching.json`, JSON.stringify({ pairs, conflicts, candidates, isModelMatched }, null, 2))
  await patchReview($, key, r => ({ ...r, result: { ...r.result, groups, isModelMatched } }))
  return groups
}

async function verify($: $, key: string) {
  const review = (await getReview($, key))!
  const setVerify = (fn: (v: Verification) => Verification) => patchReview($, key, r => ({ ...r, verify: fn(r.verify) }))
  if (!review.isTrusted) {
    await setVerify(() => ({ status: 'skipped', steps: [], note: "skipped: not your repo, or the PR branch is in someone else's fork" }))
    return
  }
  const files = (await $.fs.list(review.worktree)).map(entry => entry.name)
  const packageJson = files.includes('package.json') ? await $.fs.read(`${review.worktree}/package.json`) : null
  const steps = detectSteps(files, packageJson)
  if (!steps.length) {
    await setVerify(() => ({ status: 'skipped', steps: [], note: 'skipped: no install, test or build commands found' }))
    return
  }

  await patchReview($, key, r => ({ ...r, result: { ...r.result, status: 'verifying' }, verify: { status: 'running', steps, note: null } }))
  const logs: Record<string, string> = {}
  let isFailed = false
  for (const [index, step] of steps.entries()) {
    if (isFailed) break
    const startedAt = await $.clock.now()
    await setVerify(v => ({ ...v, steps: v.steps.map((s, i) => (i === index ? { ...s, status: 'running', startedAt } : s)) }))
    let exitCode: number
    let output: string
    try {
      const result = await $.process.run(step.command, {
        cwd: review.worktree, env: { CI: 'true', FORCE_COLOR: '0' }, timeoutMs: STEP_TIMEOUT_MS,
      })
      exitCode = result.exitCode
      output = `${result.stdout}\n${result.stderr}`
    } catch (err) {
      exitCode = -1
      output = `Did not finish: ${message(err)}`
    }
    const durationMs = (await $.clock.now()) - startedAt
    logs[step.name] = tailOf(output)
    await $.fs.write(`${review.worktree}/${INPUT_DIR}/verify/${step.name}.log`, output)
    await $.fs.write(`${review.outDir}/verify-${step.name}.log`, output)
    const status = exitCode === 0 ? 'passed' : 'failed'
    if (status === 'failed') isFailed = true
    await setVerify(v => ({
      ...v,
      steps: v.steps.map((s, i) => (i === index ? { ...s, status, durationMs, summary: summarize(step.name, exitCode, output) } : s)),
    }))
  }
  verifyLogs.set(key, logs)
  await setVerify(v => ({ ...v, status: isFailed ? 'failed' : 'passed', note: isFailed && v.steps.some(s => s.status === 'pending') ? 'later steps not run' : null }))
}

async function debate($: $, key: string, groups: Group[]) {
  let items = debateItems(groups)
  const setDebate = (fn: (d: Debate) => Debate) => patchReview($, key, r => ({ ...r, debate: fn(r.debate) }))
  if (!items.length) {
    await setDebate(() => ({ ...freshDebate(), status: 'skipped', note: 'nothing disputed' }))
    return
  }
  const review = (await getReview($, key))!
  const outputs = { claude: review.agents.claude.output!, codex: review.agents.codex.output! }
  const verification = review.verify.status === 'skipped' || review.verify.status === 'pending'
    ? `Not run (${review.verify.note ?? 'skipped'}).`
    : evidence(review.verify.steps, verifyLogs.get(key) ?? {})

  await patchReview($, key, r => ({ ...r, result: { ...r.result, status: 'debating' } }))

  // Round 1: each agent answers the items the other one raised.
  const roundOne = AGENTS.map(agent => ({ agent, mine: items.filter(i => i.author === other(agent)) })).filter(t => t.mine.length)
  await setDebate(() => ({ status: 'running', round: 1, turn: roundOne.length === 2 ? 'both' : roundOne[0]!.agent, items, note: null }))
  for (const agent of AGENTS) {
    if (!roundOne.some(t => t.agent === agent)) await patchAgent($, key, agent, { status: 'waiting', activity: null })
  }
  const firstReplies = await Promise.all(roundOne.map(({ agent, mine }) =>
    debateTurn($, key, agent, roundOnePrompt(agent, review.pr, mine, outputs, verification), mine, ['agree', 'disagree', 'unsure'], 'debate-1')))
  firstReplies.forEach(replies => { if (replies) items = applyRoundOne(items, replies) })
  await setDebate(d => ({ ...d, items }))

  // Round 2: each author answers the disagreements with its own items.
  const roundTwo = AGENTS.map(agent => ({ agent, mine: items.filter(i => i.author === agent && i.resolution === 'pending') })).filter(t => t.mine.length)
  if (roundTwo.length) {
    await setDebate(d => ({ ...d, round: 2, turn: roundTwo.length === 2 ? 'both' : roundTwo[0]!.agent }))
    const secondReplies = await Promise.all(roundTwo.map(({ agent, mine }) =>
      debateTurn($, key, agent, roundTwoPrompt(agent, review.pr, mine, outputs, verification), mine, ['maintain', 'withdraw'], 'debate-2')))
    secondReplies.forEach(replies => { if (replies) items = applyRoundTwo(items, replies) })
  }
  items = closeOpen(items)
  await setDebate(d => ({ ...d, status: 'done', turn: null, items }))
}

async function debateTurn(
  $: $, key: string, agent: AgentName, prompt: string, mine: DebateItem[], allowed: Parameters<typeof readReplies>[2], phase: string,
) {
  const review = (await getReview($, key))!
  stopped.delete(runId(key, agent))
  const author = other(agent) === 'claude' ? 'Claude' : 'Codex'
  const what = phase === 'debate-1' ? `answering ${mine.length} of ${author}'s findings` : `answering ${author}'s objections to ${mine.length} findings`
  await patchAgent($, key, agent, { status: 'responding', activity: what, activityAt: await $.clock.now() })
  const answer = await callAgent($, review, agent, { prompt, schema: DEBATE_SCHEMA, phase })
  const usage = review.agents[agent].usage
  const totalUsage = answer.usage ? `${usage ?? ''}${usage ? ' + ' : ''}${answer.usage}` : usage
  if (answer.isCancelled) {
    await patchAgent($, key, agent, { status: 'cancelled', activity: null, usage: totalUsage })
    return null
  }
  const replies = answer.error ? null : readReplies(answer.structured, mine.map(i => i.id), allowed)
  await $.fs.write(`${review.outDir}/${agent}.${phase}.json`, JSON.stringify(answer.structured ?? { error: answer.error }, null, 2))
  await patchAgent($, key, agent, {
    status: 'waiting', activity: null, usage: totalUsage,
    error: replies ? null : `Debate answer unusable: ${answer.error ?? 'not in the expected format'}`,
  })
  return replies
}

async function finish($: $, key: string) {
  const endedAt = await $.clock.now()
  for (const agent of AGENTS) {
    const status = (await getReview($, key))!.agents[agent].status
    if (status !== 'cancelled') await patchAgent($, key, agent, { status: 'done', endedAt, activity: null })
  }
  await patchReview($, key, r => ({ ...r, result: { ...r.result, status: 'ready' } }))
  const review = (await getReview($, key))!
  const claude = review.agents.claude.output!
  const codex = review.agents.codex.output!
  await $.fs.write(`${review.outDir}/reconciled.md`,
    `# ${review.repoName} #${review.pr}: ${review.title}\n\n${combinedMarkdown(claude, codex, review.result.groups)}\n`)
  await $.fs.write(`${review.outDir}/reconciled.json`,
    JSON.stringify({ groups: review.result.groups, verify: review.verify, debate: review.debate }, null, 2))
  await $.ui.notify(notifyText(review), { title: `Review ready: ${review.repoName} #${review.pr}` })
}

// ---------- controls ----------

function startTicker($: $) {
  if (ticker) return
  ticker = $.clock.every(1000, () => void tick($))
}

async function tick($: $) {
  const at = await $.clock.now()
  await update($, now, () => at)
  const list = await read($, reviews)
  const busy = list.filter(isBusy).length
  const ready = list.filter(review => review.result.status === 'ready').length
  $.ui.status(busy ? `PR reviews: ${busy} running · ${ready} ready` : undefined)
  if (!busy) {
    ticker?.cancel()
    ticker = null
  }
}

async function cancelAgent($: $, key: string, agent: AgentName) {
  const id = runId(key, agent)
  stopped.add(id)
  const child = running.get(id)
  if (child) child.stop()
  else await patchAgent($, key, agent, { status: 'cancelled', endedAt: await $.clock.now(), activity: null })
}

async function retryAgent($: $, key: string, agent: AgentName) {
  const review = await getReview($, key)
  if (!review || pipelines.has(key)) return
  await patchReview($, key, r => ({ ...r, result: freshResult(), verify: freshVerify(), debate: freshDebate() }))
  if (review.agents[agent].output) {
    await runPipelineWhenReady($, key, true)
    return
  }
  if (review.prompt) {
    await patchAgent($, key, agent, freshRun('queued', null))
    void reviewRound($, key, agent, review.prompt)
    return
  }
  // Setup never finished, so redo it for every reviewer that is not running.
  const startedAt = await $.clock.now()
  for (const each of AGENTS) {
    if (!isActive(review.agents[each])) {
      stopped.delete(runId(key, each))
      await patchAgent($, key, each, freshRun('preparing', startedAt))
    }
  }
  startTicker($)
  void prepareAndReview($, key)
}

// Drops a review from the panel; its saved files and worktree stay.
async function removeReview($: $, key: string) {
  const review = await getReview($, key)
  if (!review || isBusy(review) || pipelines.has(key)) return
  await update($, reviews, list => list.filter(r => r.key !== key))
  await update($, view, v => (v.selected === key ? { ...v, selected: null } : v))
}

async function recombine($: $, key: string) {
  if (pipelines.has(key)) return
  await patchReview($, key, r => ({ ...r, result: freshResult(), verify: freshVerify(), debate: freshDebate() }))
  await runPipelineWhenReady($, key, true)
}

function parseArgs(args: string): { dir: string | null; prs: number[] } {
  const tokens = args.split(/\s+/).filter(Boolean)
  const prs: number[] = []
  let dir: string | null = null
  for (const token of tokens) {
    const number = token.match(/^#?(\d+)$/)?.[1] ?? token.match(/\/pull\/(\d+)/)?.[1]
    if (number) prs.push(Number(number))
    else dir = token
  }
  return { dir, prs: [...new Set(prs)] }
}

async function changeTrust($: $, words: string[]): Promise<string> {
  const [verb, repo] = words
  const list = await trustedRepos($)
  if (!repo) return `Approved for verification besides your own repos: ${list.length ? list.join(', ') : 'none'}.`
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return 'Name the repo as owner/name, such as ekcm/Muse.'
  const next = verb === 'trust' ? [...new Set([...list, repo])] : list.filter(r => r !== repo)
  await $.store.set(TRUSTED_KEY, next)
  return verb === 'trust'
    ? `${repo} approved: its PRs' installs, tests and builds will run on this machine.`
    : `${repo} removed: its PRs will be reviewed without running installs, tests or builds.`
}

async function startReviews($: $, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(Boolean)
  if (words[0] === 'trust' || words[0] === 'untrust') return changeTrust($, words)
  const { dir, prs } = parseArgs(args)
  if (!prs.length) return 'Name at least one PR number: /review-prs [repo path] 19 22'
  const home = (await $.env.get('HOME')) ?? ''
  const target = dir ? dir.replace(/^~(?=\/|$)/, home) : (await $.session.repo())?.root ?? await $.session.cwd()
  const root = await run($, ['git', '-C', target, 'rev-parse', '--show-toplevel'])
  const repoName = root.split('/').pop() ?? root
  const startedAt = await $.clock.now()

  const started: number[] = []
  const skipped: number[] = []
  const missing: string[] = []
  for (const pr of prs) {
    const key = `${repoName}#${pr}`
    const existing = await getReview($, key)
    if (existing && isBusy(existing)) {
      skipped.push(pr)
      continue
    }
    const found = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'number'], { cwd: root, timeoutMs: 60_000 })
    if (found.exitCode !== 0) {
      missing.push(`#${pr} (${(found.stderr || found.stdout).trim().split('\n').pop() ?? ''})`)
      continue
    }
    const outDir = `${home}/.agent-toolkit/pr-reviews/${repoName}/pr-${pr}`
    const review: Review = {
      key, repoRoot: root, repoName, nameWithOwner: null, isTrusted: false, pr, title: 'loading…', additions: 0, deletions: 0,
      worktree: `${outDir}/worktree`, outDir, prompt: null,
      agents: { claude: freshRun('preparing', startedAt), codex: freshRun('preparing', startedAt) },
      result: freshResult(), verify: freshVerify(), debate: freshDebate(),
    }
    AGENTS.forEach(agent => stopped.delete(runId(key, agent)))
    await update($, reviews, list => [...list.filter(r => r.key !== key), review])
    started.push(pr)
    void prepareAndReview($, key)
  }
  if (started.length) startTicker($)

  const parts = []
  if (started.length) parts.push(`Reviewing ${started.map(n => `#${n}`).join(', ')} in ${repoName} with Claude and Codex.`)
  if (skipped.length) parts.push(`Already running: ${skipped.map(n => `#${n}`).join(', ')}.`)
  if (missing.length) parts.push(`Not found in ${repoName}: ${missing.join(', ')}.`)
  return parts.join(' ')
}

// Reviews saved by earlier versions of the mod lack the later fields.
function withDefaults(review: Review): Review {
  const saved = review as Partial<Review>
  return {
    ...review,
    nameWithOwner: saved.nameWithOwner ?? null,
    isTrusted: saved.isTrusted ?? false,
    verify: saved.verify ?? freshVerify(),
    debate: saved.debate ?? freshDebate(),
  }
}

// A reload kills the agent processes and the pipeline; say so instead of
// showing them as running. Reviews that finished round 1 can be recombined.
function markInterrupted(review: Review, endedAt: number): Review {
  const note = 'Interrupted by a reload or restart'
  const agents = Object.fromEntries(AGENTS.map(agent => {
    const agentRun = review.agents[agent]
    // Reviews saved by the first version of the mod ended round 1 as 'done'.
    if (agentRun.status === 'done' && review.result.status !== 'ready') return [agent, { ...agentRun, status: 'reviewed' }]
    if (isActive(agentRun) && !agentRun.output) return [agent, { ...agentRun, status: 'failed', endedAt, error: `${note}; retry to run it again` }]
    if (isActive(agentRun) || agentRun.status === 'waiting') return [agent, { ...agentRun, status: 'reviewed', activity: null }]
    return [agent, agentRun]
  })) as Record<AgentName, AgentRun>
  const isPipelineCut = ['combining', 'verifying', 'debating'].includes(review.result.status)
  return {
    ...review,
    agents,
    result: isPipelineCut ? { ...review.result, status: 'failed', error: `${note}; press recombine` } : review.result,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'review-prs',
      description: 'Review PRs with Claude and Codex side by side: /review-prs [repo path] <PR numbers>, or /review-prs trust owner/repo',
    })
    const endedAt = await $.clock.now()
    await update($, reviews, list => list.map(review => markInterrupted(withDefaults(review), endedAt)))
    return next(e)
  })

  on('command.run', { command: 'review-prs' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: 'PR reviews' })
    const hint = opened.isPlaced ? '' : ' The panel opens once the terminal is wide enough.'
    if (!e.args.trim()) return { text: `PR reviews panel opened.${hint}` }
    try {
      return { text: (await startReviews($, e.args)) + hint }
    } catch (err) {
      return { text: `Could not start the review: ${message(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const list = await read($, reviews)
    const current = await read($, view)
    const at = await read($, now)
    const selected = current.selected ? list.find(review => review.key === current.selected) : undefined
    if (selected) {
      return Detail({
        elements, review: selected, tab: current.tab,
        onBack: () => update($, view, v => ({ ...v, selected: null })),
        onTab: tab => update($, view, v => ({ ...v, tab })),
        onClose: () => $.ui.close({ id: PANE }),
      })
    }
    return Board({
      elements, reviews: list, at, isBusy, isActive,
      onOpen: key => update($, view, (): BoardView => ({ selected: key, tab: 'combined' })),
      onCancel: (key, agent) => cancelAgent($, key, agent),
      onRetry: (key, agent) => retryAgent($, key, agent),
      onRecombine: key => recombine($, key),
      onRemove: key => removeReview($, key),
      onClose: () => $.ui.close({ id: PANE }),
    })
  })
}
