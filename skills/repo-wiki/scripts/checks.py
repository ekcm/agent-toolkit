"""Record a checker's verdict on every claim in a fragment, so the merge can prove each claim was checked.

Usage: python checks.py <workspace> <slug> --list      the claims to check, one key per line
       python checks.py <workspace> <slug>             validate checks/<slug>.json and stamp it
       python checks.py <workspace> <slug> --status    exit 1 unless every claim has a current verdict

<slug> is an area (its fragment is wiki.d/<slug>.json) or "base" (wiki.base.json).

Claims are the things a checker re-reads the code for: every flow step, state-machine transition and
extras node and edge. The checker writes checks/<slug>.json after it has finished editing:

  {"items": {"<key from --list>": {"verdict": "confirmed" | "corrected", "evidence": "path:line",
                                   "note": "optional"}},
   "deleted": [{"was": "<key or title>", "why": "..."}]}

Validating stamps each claim's current content into the file. A claim edited after the stamp, or added
since, counts as unchecked again, so merge.py refuses to merge until it is checked.
"""
import hashlib
import json
import os
import re
import sys

VERDICTS = {"confirmed", "corrected"}
REF = re.compile(r"^([^:]+):(\d+)(?:-(\d+))?$")


def load(path):
    with open(path) as fh:
        return json.load(fh)


def claims(part):
    """key -> the content a verdict vouches for."""
    out = {}
    for f in part.get("flows", []) or []:
        for i, s in enumerate(f.get("steps", []) or [], 1):
            out[f"flow {f.get('id')} step {i}"] = s
    for sm in part.get("stateMachines", []) or []:
        for t in sm.get("transitions", []) or []:
            out[f"state {sm.get('id')} {t.get('from')} -> {t.get('to')} ({t.get('ref')})"] = t
    ex = part.get("extras") or {}
    for n in ex.get("nodes", []) or []:
        out[f"extra node {n.get('id')}"] = n
    for e in ex.get("edges", []) or []:
        out[f"extra edge {e.get('source')} -> {e.get('target')} ({e.get('kind')})"] = e
    return out


def digest(item):
    return hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[:16]


def paths(ws, slug):
    part = os.path.join(ws, "wiki.base.json" if slug == "base" else os.path.join("wiki.d", f"{slug}.json"))
    return part, os.path.join(ws, "checks", f"{slug}.json")


def unchecked(ws, slug):
    """Claims without a current, stamped verdict."""
    part_path, check_path = paths(ws, slug)
    now = claims(load(part_path))
    if not os.path.exists(check_path):
        return list(now), "no check record"
    stamp = load(check_path).get("stamp") or {}
    return [k for k, item in now.items() if stamp.get(k) != digest(item)], None


def validate(ws, slug):
    part_path, check_path = paths(ws, slug)
    if not os.path.exists(check_path):
        sys.exit(f"No {check_path}. Write it first; `--list` prints the keys.")
    record = load(check_path)
    items = record.get("items")
    if not isinstance(items, dict):
        sys.exit(f"{check_path}: 'items' must map each key from --list to a verdict")
    root = load(os.path.join(ws, "graph.json"))["root"]
    now = claims(load(part_path))
    errors = []
    for key in now:
        v = items.get(key)
        if not isinstance(v, dict):
            errors.append(f"{key}: no verdict")
            continue
        if v.get("verdict") not in VERDICTS:
            errors.append(f"{key}: verdict must be one of {sorted(VERDICTS)} (delete a claim that does not hold, and list it under 'deleted')")
        m = REF.match(str(v.get("evidence", "")))
        if not m:
            errors.append(f"{key}: evidence must be the path:line you read to decide")
            continue
        f = os.path.join(root, m.group(1))
        if not os.path.isfile(f):
            errors.append(f"{key}: evidence file {m.group(1)} does not exist")
            continue
        with open(f, errors="replace") as fh:
            n = sum(1 for _ in fh)
        if int(m.group(3) or m.group(2)) > n:
            errors.append(f"{key}: evidence line past the end of {m.group(1)} ({n} lines)")
    stale = sorted(set(items) - set(now))
    if errors:
        print("\n".join(errors))
        sys.exit(f"\n{len(errors)} problem(s); {check_path} not stamped.")
    record["stamp"] = {k: digest(item) for k, item in now.items()}
    with open(check_path, "w") as fh:
        json.dump(record, fh, indent=1)
    deleted = len(record.get("deleted") or [])
    counts = {v: sum(1 for k in now if items[k]["verdict"] == v) for v in sorted(VERDICTS)}
    print(f"stamped {check_path}: {len(now)} claims ({', '.join(f'{c} {v}' for v, c in counts.items())}), {deleted} deleted"
          + (f"; ignored {len(stale)} verdict(s) for keys no longer in the file" if stale else ""))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    if len(args) != 2 or len(flags) > 1 or (flags and flags[0] not in ("--list", "--status")):
        sys.exit(__doc__)
    ws, slug = args
    part_path, _ = paths(ws, slug)
    if not os.path.exists(part_path):
        sys.exit(f"No {part_path}")
    if flags == ["--list"]:
        print("\n".join(claims(load(part_path))))
    elif flags == ["--status"]:
        missing, why = unchecked(ws, slug)
        if missing:
            print(f"{slug}: {len(missing)} claim(s) unchecked" + (f" ({why})" if why else ""))
            for k in missing[:20]:
                print(f"  {k}")
            sys.exit(1)
        print(f"{slug}: every claim checked")
    else:
        validate(ws, slug)


if __name__ == "__main__":
    main()
