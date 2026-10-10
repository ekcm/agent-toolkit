// Turns each reviewer's JSONL stream into what the panel shows: the latest
// activity, the usage once it finishes, and the final output or error.

import type { ReviewOutput } from '../types'

export type StreamUpdate = {
  activity?: string
  usage?: string
  // The final structured answer, unchecked: the caller knows which schema it asked for.
  structured?: unknown
  error?: string
}

// Splits streamed text into whole lines, holding back a trailing partial one.
export function lineSplitter(): (text: string) => string[] {
  let pending = ''
  return text => {
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    return lines.filter(line => line.trim() !== '')
  }
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// Codex wraps each command as `/bin/zsh -lc "<command>"`.
export function unwrapShell(command: string): string {
  const match = command.match(/^\S*(?:zsh|bash|sh) -lc ["'](.*)["']$/s)
  return match?.[1] ?? command
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

export function isReviewOutput(value: unknown): value is ReviewOutput {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.summary === 'string'
    && typeof candidate.verdict === 'string'
    && Array.isArray(candidate.findings)
    && Array.isArray(candidate.checked_ok)
}

export function readCodexEvent(line: string): StreamUpdate {
  const event = parseJson(line)
  if (!event) return {}
  const item = event.item as Record<string, unknown> | undefined

  if (event.type === 'item.started' && item?.type === 'command_execution') {
    return { activity: `$ ${oneLine(unwrapShell(String(item.command ?? '')))}` }
  }
  if (event.type === 'item.completed' && item?.type === 'agent_message') {
    return { activity: oneLine(String(item.text ?? 'writing')) }
  }
  if (event.type === 'turn.completed') {
    const usage = event.usage as Record<string, number> | undefined
    if (!usage) return {}
    const thousands = (n: number | undefined) => `${Math.round((n ?? 0) / 1000)}k`
    return {
      usage: `${thousands(usage.input_tokens)} in (${thousands(usage.cached_input_tokens)} cached) · ${thousands(usage.output_tokens)} out`,
    }
  }
  if (event.type === 'turn.failed' || event.type === 'error') {
    const error = event.error as Record<string, unknown> | undefined
    return { error: oneLine(String(error?.message ?? event.message ?? 'Codex reported an error'), 200) }
  }
  return {}
}

function describeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': return `$ ${oneLine(String(input.command ?? ''))}`
    case 'Read': return `read ${shortPath(String(input.file_path ?? ''))}`
    case 'Grep': return `grep ${oneLine(String(input.pattern ?? ''), 80)}`
    case 'Glob': return `glob ${String(input.pattern ?? '')}`
    case 'Skill': return `skill ${String(input.skill ?? '')}`
    default: return name
  }
}

export function readClaudeEvent(line: string): StreamUpdate {
  const event = parseJson(line)
  if (!event) return {}

  if (event.type === 'assistant') {
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined
    const toolUses = (message?.content ?? []).filter(block => block.type === 'tool_use')
    const last = toolUses[toolUses.length - 1]
    if (last) return { activity: describeToolUse(String(last.name), (last.input ?? {}) as Record<string, unknown>) }
    return { activity: 'thinking' }
  }
  if (event.type === 'result') {
    const cost = typeof event.total_cost_usd === 'number' ? `$${event.total_cost_usd.toFixed(2)} equiv` : null
    const turns = typeof event.num_turns === 'number' ? `${event.num_turns} turns` : null
    const usage = [cost, turns].filter(Boolean).join(' · ') || undefined
    if (event.is_error || event.subtype !== 'success') {
      return { usage, error: oneLine(String(event.result ?? event.subtype ?? 'Claude reported an error'), 200) }
    }
    if (event.structured_output === undefined || event.structured_output === null) {
      return { usage, error: 'Claude finished without structured output' }
    }
    return { usage, structured: event.structured_output }
  }
  return {}
}
