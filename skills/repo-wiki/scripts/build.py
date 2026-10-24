"""Build the repo-wiki page from a workspace (graph.json + wiki.json + sources.json).

Usage:
  python build.py <workspace>                 verify, then write <workspace>/repo-wiki.html
  python build.py <workspace> --draft         write a draft page from the graph alone, before any research
  python build.py <workspace> --set-url URL   record where the page was published (manifest.json)

The build refuses to run while verify.py reports errors. A draft makes no claims, so it is not verified:
it has the map, code map, entry points, source viewer and Ask tab, and a note that research is under way.
It refuses to overwrite a page built from a wiki, so a refresh never replaces a finished page with a draft.
"""
import json
import os
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True  # keep the skill folder free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify import verify  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "..", "assets", "template.html")
MAX_BYTES = 15 * 1024 * 1024


def load(ws, name):
    with open(os.path.join(ws, name)) as fh:
        return json.load(fh)


def write_manifest(ws, **fields):
    path = os.path.join(ws, "manifest.json")
    data = {}
    if os.path.exists(path):
        with open(path) as fh:
            data = json.load(fh)
    data.update({k: v for k, v in fields.items() if v is not None})
    with open(path, "w") as fh:
        json.dump(data, fh, indent=1)
    return data


def draft_wiki(g):
    """A wiki with no researched content: the page falls back to what the graph shows."""
    units = [n for n in g["nodes"] if n["type"] == "unit"]
    entries = [n for n in g["nodes"] if n["type"] == "entry"]
    langs = ", ".join(g.get("languages") or {}) or "no supported language"
    comps = ", ".join(c["label"] for c in g.get("components", [])) or "one component"
    return {"title": g["repo"], "draft": True,
            "overview": f"{g['repo']} has {len(units)} units of code in {langs}, across {comps}, with {len(entries)} entry points. "
                        "This first page is drawn from the code graph alone: the map, the most important units, the entry points and the source. "
                        "Flows, key parts and the glossary are being researched and checked now, and replace this page at the same link when they are done. "
                        "Until then, the Ask tab answers questions about the code."}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    ws = os.path.realpath(sys.argv[1])
    if len(sys.argv) == 4 and sys.argv[2] == "--set-url":
        m = write_manifest(ws, artifactUrl=sys.argv[3])
        print(f"recorded {m['artifactUrl']} in {os.path.join(ws, 'manifest.json')}")
        return

    draft = sys.argv[2:] == ["--draft"]
    if draft:
        m = load(ws, "manifest.json") if os.path.exists(os.path.join(ws, "manifest.json")) else {}
        if m.get("builtAt") and not m.get("draft"):
            sys.exit("Not built: this workspace already has a finished page; a draft would replace it. Refresh it instead.")
        g, src = load(ws, "graph.json"), load(ws, "sources.json")
        w = draft_wiki(g)
    elif len(sys.argv) > 2:
        sys.exit(__doc__)
    else:
        errors, warnings = verify(ws)
        for w in warnings:
            print(f"warning: {w}")
        if errors:
            for e in errors:
                print(f"error: {e}")
            sys.exit(f"\nNot built: {len(errors)} verification error(s).")
        g, w, src = load(ws, "graph.json"), load(ws, "wiki.json"), load(ws, "sources.json")
    by_id = {n["id"]: n for n in g["nodes"]}
    extras = w.get("extras", {}) or {}
    for n in extras.get("nodes", []):
        path, _, line = (n.get("ref") or "").partition(":")
        node = {"id": n["id"], "label": n["label"], "type": "extra", "layer": n["layer"], "component": n.get("component", "external"), "kind": n.get("kind"),
                "path": path or None, "line": int(line.split("-")[0]) if line else None, "inDegree": 0, "outDegree": 0,
                "scores": {"core": 0.5, "drives": 0, "onPath": 0.5, "depended": 0.5, "churn": 0}}
        g["nodes"].append(node)
        by_id[n["id"]] = node
        if n.get("summary"):
            w.setdefault("summaries", {})[n["id"]] = n["summary"]
    for n in extras.get("nodes", []):
        # an added node is as important as the code that reaches it
        near = [by_id[e["source"]]["scores"] for e in extras.get("edges", []) if e["target"] == n["id"] and e["source"] in by_id]
        near += [by_id[e["target"]]["scores"] for e in extras.get("edges", []) if e["source"] == n["id"] and e["target"] in by_id and "scores" in by_id[e["target"]]]
        if near:
            by_id[n["id"]]["scores"] = {k: round(max(s.get(k, 0) for s in near), 4) for k in ("core", "drives", "onPath", "depended", "churn")}
    for e in extras.get("edges", []):
        path, _, line = (e.get("ref") or "").partition(":")
        g["edges"].append({"source": e["source"], "target": e["target"], "kind": e.get("kind", "calls"),
                           "line": int(line.split("-")[0]) if line else None, "count": 1, "extra": True})
        by_id[e["source"]]["outDegree"] = by_id[e["source"]].get("outDegree", 0) + 1
        by_id[e["target"]]["inDegree"] = by_id[e["target"]].get("inDegree", 0) + 1

    title = w["title"].strip()
    page_title = title if title.lower().endswith("wiki") else f"{title} Wiki"
    data = {"graph": g, "wiki": w, "sources": src}
    blob = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    with open(TEMPLATE) as fh:
        tpl = fh.read()
    if tpl.count('"__DATA__"') != 1 or tpl.count("__TITLE__") != 1:
        sys.exit("template.html is missing its __DATA__ or __TITLE__ placeholder")
    esc = page_title.replace("&", "&amp;").replace("<", "&lt;")
    html = tpl.replace("__TITLE__", esc).replace('"__DATA__"', blob)
    size = len(html.encode("utf-8"))
    if size > MAX_BYTES:
        sys.exit(f"Page is {size // 1024 // 1024} MB, over the 15 MB limit. Re-run extract.py with a smaller --max-embed-kb or a --scope.")
    out = os.path.join(ws, "repo-wiki.html")
    with open(out, "w") as fh:
        fh.write(html)
    m = write_manifest(ws, repo=g["repo"], root=g["root"], scope=g.get("scope"), commit=g["commit"], title=page_title,
                       html=out, builtAt=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), draft=draft)
    print(f"built {'a draft ' if draft else ''}{out} ({size // 1024} KB) for {g['repo']} @ {g['commit']}")
    if m.get("artifactUrl"):
        print(f"previously published at {m['artifactUrl']}: update that page instead of creating a new one")


if __name__ == "__main__":
    main()
