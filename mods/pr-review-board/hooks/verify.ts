// Picks the commands that verify a PR (install, test, build) from the repo's
// own files, and summarises what each run printed. The mod runs these, not the
// agents, so both agents argue from the same evidence.

import type { VerifyStep } from '../types'

const NPM_DEFAULT_TEST = 'no test specified'

type PackageJson = { scripts?: Record<string, string>; packageManager?: string }

function installFor(files: string[], manifest: PackageJson): string[] {
  const pinned = manifest.packageManager?.split('@')[0]
  if (pinned === 'pnpm' || files.includes('pnpm-lock.yaml')) return ['pnpm', 'install', '--frozen-lockfile']
  if (pinned === 'yarn' || files.includes('yarn.lock')) return ['yarn', 'install', '--frozen-lockfile']
  if (pinned === 'bun' || files.includes('bun.lock') || files.includes('bun.lockb')) return ['bun', 'install', '--frozen-lockfile']
  if (files.includes('package-lock.json')) return ['npm', 'ci']
  return ['npm', 'install']
}

function runner(install: string[]): string {
  return install[0] === 'npm' ? 'npm' : install[0]!
}

const step = (name: string, command: string[]): VerifyStep => ({
  name, command, status: 'pending', startedAt: null, durationMs: null, summary: null,
})

// `files` is the repo root's file names; `packageJsonText` its package.json, if any.
export function detectSteps(files: string[], packageJsonText: string | null): VerifyStep[] {
  if (packageJsonText === null) return []
  let manifest: PackageJson
  try {
    manifest = JSON.parse(packageJsonText) as PackageJson
  } catch {
    return []
  }
  const scripts = manifest.scripts ?? {}
  const install = installFor(files, manifest)
  const run = runner(install)
  const steps = [step('install', install)]
  if (scripts.test && !scripts.test.includes(NPM_DEFAULT_TEST)) steps.push(step('test', [run, 'run', 'test']))
  if (scripts.build) steps.push(step('build', [run, 'run', 'build']))
  return steps.length > 1 ? steps : []
}

// Strips colour codes and keeps the last lines, which is where test runners
// and builds print their result.
export function tailOf(output: string, lines = 40): string {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  return plain.trimEnd().split('\n').slice(-lines).join('\n')
}

// A one-line result for the panel: the test count when the runner printed one.
export function summarize(name: string, exitCode: number, output: string): string {
  const lines = tailOf(output, 80).split('\n').reverse()
  // Prefer the runner's "Tests" line over its "Test Files" or "Suites" lines.
  const testsLine = lines.map(l => l.match(/^\s*Tests?:?\s+(\d+\s+(?:passed|failed).*)$/i)?.[1]).find(Boolean)
  const counts = testsLine ?? lines.map(l => l.match(/(\d+ (?:passed|failed).*)$/i)?.[1]).find(Boolean)
  const detail = counts ? counts.replace(/\s+/g, ' ').trim().slice(0, 60) : null
  if (exitCode === 0) return detail ?? 'passed'
  return detail ? `failed: ${detail}` : `failed (exit ${exitCode})`
}

export function evidence(steps: VerifyStep[], logs: Record<string, string>): string {
  if (!steps.length) return 'Not run.'
  return steps.map(s => {
    const head = `- ${s.name} (\`${s.command.join(' ')}\`): ${s.status}${s.durationMs === null ? '' : ` in ${Math.round(s.durationMs / 1000)}s`}${s.summary ? ` — ${s.summary}` : ''}`
    const log = logs[s.name]
    return s.status === 'failed' && log ? `${head}\n  Last lines:\n${log.split('\n').map(l => `    ${l}`).join('\n')}` : head
  }).join('\n')
}
