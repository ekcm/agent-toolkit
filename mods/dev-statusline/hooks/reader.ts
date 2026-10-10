// Claude Code's status line runs this with the session as JSON on stdin; it
// prints the lines the mod last wrote for that session.
export const READER_SCRIPT = `#!/bin/sh
# Written by the dev-statusline mod. Prints the lines it wrote for this session.
id=$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)
[ -n "$id" ] && cat "$(dirname "$0")/$id.txt" 2>/dev/null
exit 0
`

// Claude Code's subagent status line runs this with every subagent row as JSON
// on stdin. It draws each row as a tree: a dim ├─ (└─ for the last), the
// worktree the subagent works in (or its name), its status, the PR the mod
// last wrote for that worktree, and its tokens. Rows it can't draw keep
// Claude Code's own; without jq it draws none.
export const SUBAGENT_SCRIPT = `#!/bin/sh
# Written by the dev-statusline mod. Draws one row per subagent.
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)
id=$(printf '%s' "$input" | jq -r '.session_id // empty')
map="$(dirname "$0")/$id.worktrees.json"
{ [ -n "$id" ] && [ -f "$map" ]; } || map=/dev/null
printf '%s' "$input" | jq -c --slurpfile wt "$map" '
  def tokens: if . >= 1000000 then "\\((. / 100000 | floor) / 10)M" elif . >= 1000 then "\\(. / 1000 | round)k" else tostring end;
  def dim: "\\u001b[2m" + . + "\\u001b[0m";
  def pad($n): . + ((" " * ($n - length)) // "");
  ($wt[0] // {}) as $m
  | (.tasks // []) as $t
  | [$t | to_entries[] | .key as $i | .value as $task
      | ($task.cwd // "") as $cwd
      | ([$m | to_entries[] | .key as $k | select($cwd == $k or ($cwd | startswith($k + "/")))] | max_by(.key | length)) as $w
      | { i: $i, id: $task.id,
          label: ((if $w then $w.value.name else ($task.name // $task.description // "agent") end)[:24]),
          pr: ($w.value.pr // ""),
          status: ({"completed": "done", "killed": "stopped"}[$task.status] // $task.status // ""),
          tokens: (($task.tokenCount // 0) | tokens) }] as $rows
  | ($rows | map(.label | length) | max // 0) as $lw
  | ($rows | map(.status | length) | max // 0) as $sw
  | $rows[]
  | { id, content: (
      ((if .i == ($rows | length) - 1 then "└─" else "├─" end) | dim) + " "
      + (.label | pad($lw)) + "  "
      + (if .status == "failed" then "\\u001b[31m" + (.status | pad($sw)) + "\\u001b[0m" else (.status | pad($sw)) end)
      + (if .pr != "" then " " + ("·" | dim) + " " + .pr else "" end)
      + " " + ("·" | dim) + " " + .tokens + " tokens") }'
`
