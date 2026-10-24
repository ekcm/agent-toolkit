"""Answer research questions from a repo-wiki workspace's graph.json.

Usage: python query.py <workspace> <command> [args]

  top [N] [rank]          N most important nodes (rank: core|drives|onPath|depended|churn)
  entries                 every entry point and the unit it reaches
  node <id-or-name>       one node: location, layer, scores, symbols, tests, history, edges
  callers <name>          call sites that reach a unit, or Unit.method / a method name
  callees <name>          calls made from a unit, or from one of its methods
  path <from> <to>        shortest dependency path between two nodes
  search <text>           nodes whose id, label or path contains the text
  layer <layer>           nodes in a layer, most important first
  orphans                 units nothing references (dead-code candidates)
  groups                  feature groups with size, cohesion, instability and their main dependencies
  infra                   detected infrastructure (databases, caches, brokers...) and the units using each
  brief <area>...         structure of an area, for a research brief: its most important units, entry points,
                          infrastructure and tables, links to other groups, and key call sites, each list capped.
                          Each <area> is a group id (or its part after "::"), a folder or a file; several are combined
"""
import json
import os
import sys
from collections import deque


def load(ws):
    with open(os.path.join(ws, "graph.json")) as fh:
        return json.load(fh)


def find(g, key):
    by_id = {n["id"]: n for n in g["nodes"]}
    if key in by_id:
        return by_id[key]
    low = key.lower()
    exact = [n for n in g["nodes"] if n.get("label", "").lower() == low or n["id"].lower().endswith("/" + low)]
    if exact:
        return exact[0]
    part = [n for n in g["nodes"] if low in n["id"].lower()]
    return part[0] if part else None


def loc(n):
    return f"{n.get('path')}:{n.get('line')}" if n.get("path") else ""


def split_method(g, key):
    """'Unit.method' -> (unit node, method). Node ids may contain dots (file paths), so take the longest id prefix."""
    ids = sorted((n["id"] for n in g["nodes"]), key=len, reverse=True)
    for nid in ids:
        if key == nid:
            return find(g, nid), ""
        if key.startswith(nid + "."):
            return find(g, nid), key[len(nid) + 1:]
    unit, _, method = key.rpartition(".")
    return (find(g, unit), method) if unit else (find(g, key), "")


ARITY = {"top": 0, "entries": 0, "node": 1, "callers": 1, "callees": 1, "path": 2, "search": 1, "layer": 1, "orphans": 0, "groups": 0, "infra": 0, "brief": 1}
RANKS = {"core", "drives", "onPath", "depended", "churn"}
BRIEF_UNITS, BRIEF_ROWS = 20, 15  # a brief is read in full by every research agent before it starts, so it stays short


def main():
    if len(sys.argv) < 3 or sys.argv[2] not in ARITY or len(sys.argv) - 3 < ARITY[sys.argv[2]]:
        sys.exit(__doc__)
    ws, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    if not os.path.exists(os.path.join(ws, "graph.json")):
        sys.exit(f"No graph.json in {ws}. Run extract.py first.")
    if cmd == "top" and ((args and not args[0].isdigit()) or (len(args) > 1 and args[1] not in RANKS)):
        sys.exit(f"usage: top [N] [{'|'.join(sorted(RANKS))}]")
    g = load(ws)
    nodes = {n["id"]: n for n in g["nodes"]}
    edges = g["edges"]

    if cmd == "top":
        k = int(args[0]) if args else 30
        rank = args[1] if len(args) > 1 else "core"
        for n in sorted(g["nodes"], key=lambda n: -n["scores"].get(rank, 0))[:k]:
            print(f"{n['scores'].get(rank, 0):.3f}  {n['layer']:9} {n['id']}  {loc(n)}")
    elif cmd == "entries":
        for n in g["nodes"]:
            if n["type"] == "entry":
                print(f"{n['id']:45} -> {n['target']}{'.' + n['handler'] if n.get('handler') else ''}  {loc(n)}  {n.get('detail') or ''}")
    elif cmd == "node":
        n = find(g, " ".join(args))
        if not n:
            sys.exit("no such node")
        print(json.dumps({k: v for k, v in n.items() if k not in ("calls",)}, indent=1)[:6000])
        print("\ndepends on:")
        for e in edges:
            if e["source"] == n["id"]:
                print(f"  {e['kind']:10} {e['target']}  (line {e.get('line')})")
        print("used by:")
        for e in edges:
            if e["target"] == n["id"]:
                print(f"  {e['kind']:10} {e['source']}  ({nodes[e['source']].get('path')}:{e.get('line')})")
    elif cmd in ("callers", "callees"):
        key = " ".join(args)
        target, method = split_method(g, key)
        rows = []
        for n in g["nodes"]:
            for caller_fn, dst, name, ln in n.get("calls", []):
                if cmd == "callers":
                    if target and dst == target["id"] and (not method or name == method):
                        rows.append(f"{n['path']}:{ln}  {n['id']}.{caller_fn} -> {name}()")
                    elif not target and name == key:
                        rows.append(f"{n['path']}:{ln}  {n['id']}.{caller_fn} -> {dst}.{name}()")
                elif target and n["id"] == target["id"] and (not method or caller_fn == method or caller_fn.endswith("." + method)):
                    rows.append(f"{n['path']}:{ln}  {caller_fn} -> {dst}.{name}()")
        print("\n".join(rows) if rows else "no resolved calls (calls into libraries and dynamic dispatch are not tracked)")
    elif cmd == "path":
        a, b = find(g, args[0]), find(g, args[1])
        if not a or not b:
            sys.exit("unknown node")
        adj = {}
        for e in edges:
            adj.setdefault(e["source"], []).append((e["target"], e))
        prev, q = {a["id"]: None}, deque([a["id"]])
        while q:
            c = q.popleft()
            if c == b["id"]:
                break
            for t, e in adj.get(c, []):
                if t not in prev:
                    prev[t] = (c, e)
                    q.append(t)
        if b["id"] not in prev:
            print("no path")
            return
        chain, c = [], b["id"]
        while prev[c]:
            p, e = prev[c]
            chain.append(f"{p} -[{e['kind']} @ {nodes[p].get('path')}:{e.get('line')}]-> {c}")
            c = p
        print("\n".join(reversed(chain)))
    elif cmd == "search":
        q = " ".join(args).lower()
        for n in g["nodes"]:
            if q in n["id"].lower() or q in n.get("label", "").lower() or q in (n.get("path") or "").lower():
                print(f"{n['layer']:9} {n['id']}  {loc(n)}")
    elif cmd == "layer":
        for n in sorted([n for n in g["nodes"] if n["layer"] == args[0]], key=lambda n: -n["scores"]["core"]):
            print(f"{n['scores']['core']:.3f}  {n['id']}  {loc(n)}")
    elif cmd == "groups":
        for gr in g.get("groups", []):
            deps = ", ".join(f"{k.split('::')[-1]}({v})" for k, v in list(gr["dependsOn"].items())[:5])
            infra = ", ".join(k.replace("infra:", "") for k in gr.get("infra", {}))
            print(f"{gr['id']:40} units={gr['units']:<4} cohesion={gr['cohesion']:<5} instability={gr['instability']:<5} layer={gr['layer']:<9} -> {deps}" + (f"  [{infra}]" if infra else ""))
    elif cmd == "infra":
        for n in g["nodes"]:
            if n.get("type") == "infra":
                users = [f"{e['kind']}:{e['source'] if e['target'] == n['id'] else e['target']}" for e in edges if n["id"] in (e["source"], e["target"])]
                print(f"{n['id']} [{n['kind']}] evidence {n['path']}:{n['line']}  {n.get('evidence', '')[:80]}")
                for u in users[:25]:
                    print(f"    {u}")
    elif cmd == "brief":
        keys = [a.strip().rstrip("/") for a in args if a.strip()]
        gids = [gr["id"] for gr in g.get("groups", [])]
        members, titles = [], []
        for key in keys:
            match = [x for x in gids if x == key or x.split("::")[-1] == key]
            if match:
                found = [n for n in g["nodes"] if n["type"] == "unit" and n.get("group") in match]
                titles.append(", ".join(match))
            else:
                found = [n for n in g["nodes"] if n["type"] == "unit" and ((n.get("path") or "") == key or (n.get("path") or "").startswith(key + "/"))]
                titles.append(key)
            if not found:
                sys.exit(f"No units in {key!r}. Use a group id from `query.py <ws> groups`, a folder path or a file path.")
            members += [n for n in found if n not in members]
        ids = {n["id"] for n in members}
        group_of = {n["id"]: n.get("group") for n in g["nodes"]}
        layers = {}
        for n in members:
            layers[n["layer"]] = layers.get(n["layer"], 0) + 1
        ranked = sorted(members, key=lambda n: -n["scores"]["core"])
        print(f"AREA {' + '.join(titles)}: {len(members)} units (" + ", ".join(f"{k} {v}" for k, v in sorted(layers.items(), key=lambda x: -x[1])) + ")")
        print(f"\nUNITS, most important first (id | layer | path:line | in/out | tests)")
        for n in ranked[:BRIEF_UNITS]:
            print(f"  {n['id']} | {n['layer']} | {loc(n)} | {n['inDegree']}/{n['outDegree']} | {len(n.get('tests', []))}")
        if len(members) > BRIEF_UNITS:
            print(f"  ... {len(members) - BRIEF_UNITS} more: " + ", ".join(sorted({os.path.dirname(n['path']) for n in ranked[BRIEF_UNITS:]}))[:400] + " (query.py search <text> lists them)")
        ents = [n for n in g["nodes"] if n["type"] == "entry" and n.get("target") in ids]
        if ents:
            print("\nENTRY POINTS into this area")
            for n in ents[:BRIEF_ROWS]:
                print(f"  {n['id']} -> {n['target']}{'.' + n['handler'] if n.get('handler') else ''}  {loc(n)}")
            if len(ents) > BRIEF_ROWS:
                print(f"  ... {len(ents) - BRIEF_ROWS} more (query.py entries)")
        outside = [e for e in edges if (e["source"] in ids) != (e["target"] in ids)]
        stores = [e for e in outside if (nodes.get(e["target"], {}).get("type") in ("infra", "table")) or (nodes.get(e["source"], {}).get("type") in ("infra", "table"))]
        if stores:
            print("\nINFRASTRUCTURE AND TABLES touched")
            for e in stores[:BRIEF_ROWS]:
                inside = e["source"] if e["source"] in ids else e["target"]
                print(f"  {e['source']} -[{e['kind']}]-> {e['target']}  ({nodes[inside].get('path')}:{e.get('line')})")
            if len(stores) > BRIEF_ROWS:
                print(f"  ... {len(stores) - BRIEF_ROWS} more (query.py node <id>)")
        out_g, in_g = {}, {}
        for e in outside:
            if e["source"] in ids and group_of.get(e["target"]):
                out_g[group_of[e["target"]]] = out_g.get(group_of[e["target"]], 0) + 1
            elif e["target"] in ids and group_of.get(e["source"]):
                in_g[group_of[e["source"]]] = in_g.get(group_of[e["source"]], 0) + 1
        if out_g:
            print("\nDEPENDS ON other groups: " + ", ".join(f"{k} ({v})" for k, v in sorted(out_g.items(), key=lambda x: -x[1])[:8]))
        if in_g:
            print("USED BY other groups: " + ", ".join(f"{k} ({v})" for k, v in sorted(in_g.items(), key=lambda x: -x[1])[:8]))
        calls = []
        for n in ranked[:8]:
            for caller_fn, dst, name, ln in n.get("calls", []):
                if dst != n["id"]:
                    calls.append(f"  {n['path']}:{ln}  {n['id']}.{caller_fn} -> {nodes.get(dst, {}).get('label', dst)}.{name}()")
        if calls:
            print("\nKEY CALL SITES from the most important units (resolved calls only; confirm in the source; query.py callees <unit> for the rest)")
            print("\n".join(calls[:BRIEF_ROWS]))
    elif cmd == "orphans":
        for n in g["nodes"]:
            if n["type"] == "unit" and n["inDegree"] == 0:
                print(f"{n['layer']:9} {n['id']}  {loc(n)}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
