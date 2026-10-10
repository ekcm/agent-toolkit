// Claude Code's status line runs this with the session as JSON on stdin; it
// prints the lines the mod last wrote for that session.
export const READER_SCRIPT = `#!/bin/sh
# Written by the dev-statusline mod. Prints the lines it wrote for this session.
id=$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)
[ -n "$id" ] && cat "$(dirname "$0")/$id.txt" 2>/dev/null
exit 0
`
