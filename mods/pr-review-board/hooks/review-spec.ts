// What both reviewers are given: the same prompt, the same output schema, and
// read-only access to the PR's worktree.

const nullable = (type: string) => ({ type: [type, 'null'] })

export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'verdict', 'findings', 'checked_ok'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences on what the PR does and its overall quality.' },
    verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'file', 'line', 'end_line', 'severity', 'category', 'title', 'explanation', 'suggestion'],
        properties: {
          id: { type: 'string', description: 'F1, F2, ...' },
          file: { type: 'string', description: 'Repo-relative path.' },
          line: { ...nullable('integer'), description: 'First line in the PR head version of the file; null if not tied to a line.' },
          end_line: nullable('integer'),
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          category: {
            type: 'string',
            enum: ['correctness', 'code_smell', 'naming', 'duplication', 'architecture', 'api_design', 'error_handling', 'testing', 'performance', 'security', 'documentation', 'out_of_scope'],
          },
          title: { type: 'string' },
          explanation: { type: 'string', description: 'What is wrong and why, with evidence.' },
          suggestion: nullable('string'),
        },
      },
    },
    checked_ok: {
      type: 'array',
      description: 'Specific places examined closely and judged correct.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'area', 'note'],
        properties: {
          file: { type: 'string' },
          line: nullable('integer'),
          area: { type: 'string', description: 'Function, block or concern that was checked.' },
          note: { type: 'string', description: 'Why it is correct.' },
        },
      },
    },
  },
} as const

export const INPUT_DIR = '.review-input'

export type PromptFacts = {
  pr: number
  headSha: string
  baseRef: string
  mergeBase: string
}

export function reviewPrompt(facts: PromptFacts): string {
  return `Review pull request #${facts.pr} in this repository. It is checked out at the PR head (commit ${facts.headSha.slice(0, 7)}); the base branch is origin/${facts.baseRef}, merge-base ${facts.mergeBase.slice(0, 7)}.

Use the review-pull-request skill and apply its full review: every phase and all 11 review dimensions, including the duplication search across the repo.

The PR metadata and diff are already saved in ${INPUT_DIR}/pr.json and ${INPUT_DIR}/pr.diff. Use those instead of gh or any network access. Use git and file reads for everything else. The ${INPUT_DIR}/ folder is review input, not part of the PR.

This is a read-only review. Do not create, modify or delete any files, and do not install dependencies or run tests or builds.

Ignore the skill's terminal report format. Return your final answer only as JSON matching the provided schema:
- findings: every issue you would put in the report (critical, major, minor, duplication, out-of-scope), with line numbers from the PR head version of the file.
- checked_ok: specific places you examined closely and judged correct, so your review can be compared with another reviewer's.`
}

// Claude runs as `claude -p`, where any tool not listed here is refused.
export const CLAUDE_ALLOWED_TOOLS = [
  'Skill', 'Read', 'Grep', 'Glob',
  'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git rev-parse:*)',
  'Bash(git branch:*)', 'Bash(git ls-files:*)', 'Bash(git merge-base:*)', 'Bash(git blame:*)', 'Bash(git grep:*)',
  'Bash(cat:*)', 'Bash(ls:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
  'Bash(tree:*)', 'Bash(sed -n:*)',
]

export const CLAUDE_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch']
