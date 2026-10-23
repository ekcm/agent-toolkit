// Claude Code's status line runs this with the session as JSON on stdin; it
// prints the lines the mod last wrote for that session.
export const READER_SCRIPT = `#!/bin/sh
# Written by the dev-statusline mod. Prints the lines it wrote for this session.
id=$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)
[ -n "$id" ] && cat "$(dirname "$0")/$id.txt" 2>/dev/null
exit 0
`

// Claude Code's subagent status line runs this with every subagent row as JSON
// on stdin. It draws the rows as a tree, each agent under the one that
// launched it (from the activity file the mod writes): the worktree the agent
// works in (or its task), its state and how long it has been at it, the PR
// the mod last wrote for that worktree, what it is doing now (else Claude
// Code's own summary of it), and its tokens. A running agent with nothing in
// flight for a minute shows as idle; one whose turn ended while agents it
// launched still run shows as waiting on them. What it
// is doing is cut to fit the terminal's width. Rows it can't draw keep Claude
// Code's own; without jq it draws none.
export const SUBAGENT_SCRIPT = `#!/bin/sh
# Written by the dev-statusline mod. Draws one row per subagent.
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)
id=$(printf '%s' "$input" | jq -r '.session_id // empty')
dir=$(dirname "$0")
map="$dir/$id.worktrees.json"
{ [ -n "$id" ] && [ -f "$map" ]; } || map=/dev/null
agents="$dir/$id.agents.json"
{ [ -n "$id" ] && [ -f "$agents" ]; } || agents=/dev/null
printf '%s' "$input" | jq -c --slurpfile wt "$map" --slurpfile ag "$agents" '
  def tokens: if . >= 1000000 then "\\((. / 100000 | floor) / 10)M" elif . >= 1000 then "\\(. / 1000 | round)k" else tostring end;
  def paint($c): "\\u001b[" + $c + "m" + . + "\\u001b[0m";
  def dim: paint("2");
  def plain: gsub("\\u001b\\\\[[0-9;]*m"; "");
  def pad($n): . + ((" " * ($n - (plain | length))) // "");
  def two: tostring | if length < 2 then "0" + . else . end;
  def dur: (. / 1000 | floor | if . < 0 then 0 else . end) as $s
    | if $s < 60 then "\\($s)s"
      elif $s < 3600 then "\\($s / 60 | floor)m\\($s % 60 | two)s"
      else "\\($s / 3600 | floor)h\\(($s % 3600) / 60 | floor | two)m" end;
  def tree($rows; $parent; $pre):
    [$rows[] | select(.parent == $parent)] as $kids
    | ($kids | length) as $n
    | range(0; $n) as $i
    | ($i == $n - 1) as $last
    | ($kids[$i] + {branch: ($pre + (if $last then "└─" else "├─" end))}),
      tree($rows; $kids[$i].id; $pre + (if $last then "   " else "│  " end));
  (now * 1000) as $now
  | ($wt[0] // {}) as $m
  | ($ag[0] // {}) as $a
  | (.columns // 120) as $cols
  | (.tasks // []) as $t
  | ($t | map(.id)) as $ids
  | [$t[] | . as $task
      | ($a[$task.id] // {}) as $s
      | ($task.cwd // "") as $cwd
      | ([$m | to_entries[] | .key as $k | select($cwd == $k or ($cwd | startswith($k + "/")))] | max_by(.key | length)) as $w
      | ($task.startTime // $now) as $start
      | ($now - ($s.since // $now)) as $quiet
      | (if $quiet >= 10000 then " " + ($quiet | dur) else "" end) as $for
      | ([$t[] | select(($a[.id].parent // null) == $task.id and (.status == "running" or .status == "pending" or .status == "waiting"))] | length) as $open
      | (if ($task.label // "") != "" and $task.label != $task.description then $task.label else "" end) as $summary
      | { id: $task.id,
          parent: (($s.parent // null) as $p | if $p != null and ($ids | index($p)) != null then $p else null end),
          label: ((if $w then $w.value.name else ($task.description // $task.label // "agent") end)[:28]),
          pr: ($w.value.pr // ""),
          tokens: (($task.tokenCount // 0) | tokens) }
        + if $task.status == "running" or $task.status == "pending" then
            (if $s.phase == "tool" then {state: "running", activity: (($s.activity // "") + ($for | dim))}
             elif $s.phase == "thinking" then {state: "running", activity: ("thinking" + $for | dim)}
             elif $s.since != null and $quiet >= 60000 then {state: ("idle" | paint("33")), activity: ("nothing for " + ($quiet | dur) | paint("33"))}
             else {state: "running", activity: $summary} end)
            + {time: ($now - $start | dur)}
          elif $task.status == "waiting" or ($open > 0 and $task.status == "completed") then
            {state: "waiting", time: ($now - $start | dur),
             activity: (if $open > 0 then "on \\($open) agent" + (if $open > 1 then "s" else "" end) else $summary end)}
          elif $task.status == "completed" then {state: ("✓ done" | paint("32")), time: (if $s.endedAt then "in " + ($s.endedAt - $start | dur) else "" end)}
          elif $task.status == "failed" then {state: ("✗ failed" | paint("31")), time: (if $s.endedAt then "after " + ($s.endedAt - $start | dur) else "" end)}
          elif $task.status == "killed" then {state: "stopped"}
          else {state: ($task.status // "")} end
    ] as $rows
  | [tree($rows; null; "")] as $tree
  | ($tree | map((.branch | length) + 1 + (.label | length)) | max // 0) as $lw
  | ($tree | map(.state | plain | length) | max // 0) as $sw
  | ($tree | map(.time // "" | length) | max // 0) as $tw
  | $tree[] | . as $r
  | (($r.branch | dim) + " " + ($r.label | pad($lw - ($r.branch | length) - 1)) + "  "
      + ($r.state | pad($sw)) + (if $tw > 0 then " " + ($r.time // "" | pad($tw)) else "" end)
      + (if $r.pr != "" then " " + ("·" | dim) + " " + $r.pr else "" end)) as $head
  | (" " + ("·" | dim) + " " + $r.tokens + " tokens") as $tail
  | ($cols - ($head | plain | length) - ($tail | plain | length) - 5) as $room
  | ($r.activity // "") as $act
  | { id: $r.id, content: ($head
      + (if $act == "" or $room < 8 then ""
         elif ($act | plain | length) > $room then " " + ("·" | dim) + " " + ($act | plain | .[:$room - 1] + "…" | dim)
         else " " + ("·" | dim) + " " + $act end)
      + $tail) }'
`
