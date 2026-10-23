"""Merge the lead's wiki.base.json and the research fragments in wiki.d/ into wiki.json.

Usage: python merge.py <workspace>

Order: wiki.base.json first, then wiki.d/*.json by file name. When two sources describe the same thing,
the first one wins and the merge report says what was dropped. Identical duplicates are dropped silently.
Two different flows, recipes or state machines with the same id are a conflict: nothing is written and
the ids must be renamed (fragment ids should start with their area slug).
"""
import json
import os
import sys

LIST_BY_ID = ("flows", "recipes", "stateMachines")  # same id with different content = conflict


def load(path):
    with open(path) as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        sys.exit(f"{path} must be a JSON object")
    return data


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    ws = sys.argv[1]
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
        for item in data.get("gotchas", []) or []:
            add("gotchas", item.get("ref"), item, src, f"the gotcha at {item.get('ref')!r}")
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
