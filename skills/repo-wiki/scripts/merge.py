"""Merge the lead's wiki.base.json and the research fragments in wiki.d/ into wiki.json.

Usage: python merge.py <workspace> [--allow-unchecked]

Every source must first have a stamped check record (checks.py): a claim without a current verdict stops the
merge. --allow-unchecked merges anyway and lists what was not checked; use it only where no checker could
run, and say so in the report to the user.

Order: wiki.base.json first, then wiki.d/*.json by file name. When two sources describe the same thing,
the first one wins and the merge report says what was dropped. Identical duplicates are dropped silently.
Two different flows, recipes or state machines with the same id are a conflict: nothing is written and
the ids must be renamed (fragment ids should start with their area slug).
"""
import json
import os
import subprocess
import sys

LIST_BY_ID = ("flows", "recipes", "stateMachines")  # same id with different content = conflict


def load(path):
    with open(path) as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        sys.exit(f"{path} must be a JSON object")
    return data


def unchecked(ws, slugs):
    """Run checks.py --status for each source; return its report for each one that is not fully checked."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "checks.py")
    out = []
    for slug in slugs:
        r = subprocess.run([sys.executable, "-I", script, ws, slug, "--status"], capture_output=True, text=True)
        if r.returncode != 0:
            out.append((r.stdout or r.stderr).strip())
    return out


def main():
    args = [a for a in sys.argv[1:] if a != "--allow-unchecked"]
    if len(args) != 1 or len(sys.argv) > 3:
        sys.exit(__doc__)
    ws = args[0]
    base_path = os.path.join(ws, "wiki.base.json")
    frag_dir = os.path.join(ws, "wiki.d")
    sources = []
    if os.path.exists(base_path):
        sources.append(("wiki.base.json", load(base_path)))
    if os.path.isdir(frag_dir):
        for name in sorted(f for f in os.listdir(frag_dir) if f.endswith(".json")):
            sources.append((f"wiki.d/{name}", load(os.path.join(frag_dir, name))))
    if not sources:
        sys.exit(f"Nothing to merge: no {base_path} and no fragments in {frag_dir}.")
    gaps = unchecked(ws, ["base" if src == "wiki.base.json" else src[len("wiki.d/"):-len(".json")] for src, _ in sources])
    if gaps:
        print("\n".join(gaps))
        if "--allow-unchecked" not in sys.argv:
            sys.exit("\nNot written: have these checked (checks.py), or pass --allow-unchecked where no checker can run.")
        print("merging anyway (--allow-unchecked): report the unchecked claims to the user\n")

    out = {}
    notes, conflicts = [], []
    keyed = {}  # section -> {key: (source, item)}

    def add(section, key, item, src, describe):
        seen = keyed.setdefault(section, {})
        if key in seen:
            first_src, first = seen[key]
            if first != item:
                if section in LIST_BY_ID:
                    conflicts.append(f"{section}: id {key!r} is used by {first_src} and {src} with different content; rename one")
                else:
                    notes.append(f"{section}: kept {describe} from {first_src}, dropped the version in {src}")
            return
        seen[key] = (src, item)
        out.setdefault(section, []).append(item)

    for src, data in sources:
        for k in ("title", "overview", "components", "starters"):
            if k in data:
                if src != "wiki.base.json":
                    notes.append(f"{k} in {src} ignored (it belongs in wiki.base.json)")
                else:
                    out[k] = data[k]
        for section in LIST_BY_ID:
            for item in data.get(section, []) or []:
                add(section, item.get("id"), item, src, f"id {item.get('id')!r}")
        for item in data.get("groups", []) or []:
            add("groups", item.get("id"), item, src, f"group {item.get('id')!r}")
        for item in data.get("keyParts", []) or []:
            add("keyParts", item.get("node"), item, src, f"the key part for {item.get('node')!r}")
        for item in data.get("glossary", []) or []:
            add("glossary", (item.get("term") or "").strip().lower(), item, src, f"the term {item.get('term')!r}")
        for nid, text in (data.get("summaries") or {}).items():
            summaries = out.setdefault("summaries", {})
            if nid in summaries:
                if summaries[nid] != text:
                    notes.append(f"summaries: kept {nid!r} from an earlier source, dropped the one in {src}")
            else:
                summaries[nid] = text
        extras = data.get("extras") or {}
        for n in extras.get("nodes", []) or []:
            add("extras.nodes", n.get("id"), n, src, f"extra node {n.get('id')!r}")
        for e in extras.get("edges", []) or []:
            add("extras.edges", (e.get("source"), e.get("target"), e.get("kind")), e, src,
                f"extra edge {e.get('source')} -> {e.get('target')}")
        for x in data.get("uncoveredEntries", []) or []:
            lst = out.setdefault("uncoveredEntries", [])
            if x not in lst:
                lst.append(x)

    if "extras.nodes" in out or "extras.edges" in out:
        out["extras"] = {"nodes": out.pop("extras.nodes", []), "edges": out.pop("extras.edges", [])}

    counts = ", ".join(f"{k} {len(v)}" for k, v in out.items() if isinstance(v, (list, dict)) and k != "extras")
    print(f"merged {len(sources)} source(s): " + ", ".join(s for s, _ in sources))
    print(f"result: {counts}")
    for n in notes:
        print(f"note: {n}")
    if conflicts:
        for c in conflicts:
            print(f"conflict: {c}")
        sys.exit(f"\nNot written: {len(conflicts)} conflict(s).")
    with open(os.path.join(ws, "wiki.json"), "w") as fh:
        json.dump(out, fh, indent=1)
    print(f"wrote {os.path.join(ws, 'wiki.json')}; run verify.py next")


if __name__ == "__main__":
    main()
