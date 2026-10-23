"""Check a repo-wiki workspace's wiki.json against the code before it is built.

Usage: python verify.py <workspace>                      check <workspace>/wiki.json
       python verify.py <workspace> --fragment <file>     check one research fragment (wiki.d/<area>.json)
       python verify.py <workspace> --base                check the lead's wiki.base.json on its own
Exit code 0 when there are no errors. Warnings point at gaps worth filling but do not block a build.

A fragment is checked the same way (refs, expect texts, node ids, shapes) but not for whole-wiki
requirements (title, overview, key-part count, coverage). Its links may point at extras defined in
wiki.base.json or any other fragment. The base is checked like a fragment, except that it must have the
title and overview, which only it may hold.

Errors:   a ref whose file or line does not exist; an `expect` text not found near its line;
          a node id that is not in the graph; a malformed section; refs taken at another commit.
Warnings: important nodes without a summary; entry points no flow covers; thin sections.
"""
import json
import os
import re
import subprocess
import sys

SEVERITIES = {"bug", "risk", "design", "cleanup"}
REF_IN_TEXT = re.compile(r"`([\w./@-]+\.[\w]+):(\d+)(?:-(\d+))?`")
NODE_LINK = re.compile(r"\[\[([^\]]+)\]\]")


def git(root, *args):
    return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, errors="replace").stdout


def walk_text(obj, path=""):
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if k not in ("ref", "expect", "id", "node", "trigger", "source", "target", "from", "to", "severity", "kind", "layer", "async"):
                yield from walk_text(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk_text(v, f"{path}[{i}]")


KINDS = {"database", "cache", "queue", "storage", "search", "auth", "service"}
LIST_SECTIONS = {"groups": "id", "components": "id", "keyParts": "title", "flows": "id", "recipes": "title", "stateMachines": "id",
                 "gotchas": "title", "glossary": "term"}


def check_shape(w):
    """Type checks first, so a malformed wiki.json produces errors rather than a traceback."""
    errs = []
    if not isinstance(w, dict):
        return ["wiki.json must be a JSON object"]
    for key in ("title", "overview"):
        if key in w and not isinstance(w[key], str):
            errs.append(f"{key} must be a string")
    for key in LIST_SECTIONS:
        v = w.get(key, [])
        if not isinstance(v, list):
            errs.append(f"{key} must be a list")
            continue
        for i, item in enumerate(v):
            if not isinstance(item, dict):
                errs.append(f"{key}[{i}] must be an object")
                continue
            for f, val in item.items():
                if f in ("steps", "states", "transitions", "tests"):
                    if not isinstance(val, list):
                        errs.append(f"{key}[{i}].{f} must be a list")
                    elif f in ("steps", "transitions") and not all(isinstance(x, dict) for x in val):
                        errs.append(f"{key}[{i}].{f} must be a list of objects")
                    elif f in ("states", "tests") and not all(isinstance(x, str) for x in val):
                        errs.append(f"{key}[{i}].{f} must be a list of strings")
                elif val is not None and not isinstance(val, str):
                    errs.append(f"{key}[{i}].{f} must be a string")
    if not isinstance(w.get("summaries", {}), dict) or not all(isinstance(v, str) for v in (w.get("summaries") or {}).values()):
        errs.append("summaries must be an object mapping node ids to strings")
    for key in ("starters", "uncoveredEntries"):
        if not isinstance(w.get(key, []), list) or not all(isinstance(x, str) for x in w.get(key, [])):
            errs.append(f"{key} must be a list of strings")
    ex = w.get("extras", {})
    if ex is not None and not isinstance(ex, dict):
        errs.append("extras must be an object with 'nodes' and 'edges' lists")
    elif ex:
        for key in ("nodes", "edges"):
            v = ex.get(key, [])
            if not isinstance(v, list) or not all(isinstance(x, dict) for x in v):
                errs.append(f"extras.{key} must be a list of objects")
    return errs


LEAD_ONLY = ("title", "overview", "components", "starters")  # written by the lead in wiki.base.json, never in a fragment
KEY_PARTS_MAX = 12  # more than this and the page's key parts stop being the few that matter


def _load_json(path):
    with open(path) as fh:
        return json.load(fh)


def _sibling_extra_ids(ws, own_path):
    """Extras node ids defined in wiki.base.json and in other fragments, so fragments may link to them."""
    ids = set()
    paths = [os.path.join(ws, "wiki.base.json")]
    frag_dir = os.path.join(ws, "wiki.d")
    if os.path.isdir(frag_dir):
        paths += [os.path.join(frag_dir, f) for f in sorted(os.listdir(frag_dir)) if f.endswith(".json")]
    for p in paths:
        if os.path.abspath(p) == os.path.abspath(own_path) or not os.path.exists(p):
            continue
        try:
            ids |= {n.get("id") for n in ((_load_json(p).get("extras") or {}).get("nodes") or []) if isinstance(n, dict)}
        except (ValueError, AttributeError):
            pass
    return ids


def verify(ws, wiki_path=None, fragment=False, base=False):
    errors, warnings = [], []
    partial = fragment or base  # one part of the wiki, so whole-wiki requirements do not apply
    with open(os.path.join(ws, "graph.json")) as fh:
        g = json.load(fh)
    wpath = wiki_path or os.path.join(ws, "wiki.json")
    name = os.path.basename(wpath)
    if not os.path.exists(wpath):
        return [f"{wpath} does not exist yet."], []
    try:
        w = _load_json(wpath)
    except ValueError as e:
        return [f"{name} is not valid JSON: {e}"], []

    shape_errors = check_shape(w)
    if shape_errors:
        return shape_errors, []
    if fragment:
        for key in LEAD_ONLY:
            if key in w:
                errors.append(f"{key} belongs in wiki.base.json (written by the lead), not in a fragment")

    root = g["root"]
    tracked = set(git(root, "ls-files").splitlines())
    head = git(root, "rev-parse", "HEAD").strip()
    if head and head != g["commitFull"]:
        errors.append(f"The repository is at {head[:9]} but graph.json was extracted at {g['commit']}. Re-run extract.py, then re-check the wiki.")
    elif g.get("treeState"):
        sys.dont_write_bytecode = True
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from extract import tree_fingerprint
        if tree_fingerprint(root) != g["treeState"]:
            errors.append("Tracked files in the repository changed after extract.py ran (uncommitted edits, a stash or a checkout). "
                          "Re-run extract.py so the graph and the embedded source match the code, then re-check the wiki.")

    if g.get("dirty"):
        warnings.append("graph.json was extracted from a working tree with uncommitted changes; the page shows that, but refs may not match the commit")
    extras = w.get("extras", {}) or {}
    graph_ids = {n["id"] for n in g["nodes"]}
    extra_ids = [n.get("id") for n in extras.get("nodes", [])]
    for x in sorted({x for x in extra_ids if extra_ids.count(x) > 1}):
        errors.append(f"extras.nodes: id {x!r} is used more than once")
    for x in sorted(set(extra_ids) & graph_ids):
        errors.append(f"extras.nodes: id {x!r} already exists in the graph; extras are only for things the graph lacks")
    node_ids = graph_ids | set(extra_ids) | (_sibling_extra_ids(ws, wpath) if partial else set())
    comp_ids = {c["id"] for c in g["components"]}
    cache = {}

    def file_lines(p):
        if p not in cache:
            full = os.path.join(root, p)
            if not os.path.isfile(full):
                cache[p] = None
            else:
                with open(full, encoding="utf-8", errors="replace") as fh:
                    cache[p] = fh.read().split("\n")
        return cache[p]

    def check_ref(ref, where, expect=None):
        if not isinstance(ref, str) or not ref:
            errors.append(f"{where}: missing ref")
            return
        m = re.match(r"^(.+?)(?::(\d+)(?:-(\d+))?)?$", ref)
        p, a, b = m.group(1), m.group(2), m.group(3)
        if p.startswith("/") or ".." in p.split("/"):
            errors.append(f"{where}: refs must be paths relative to the repository root, got {p}")
            return
        if p not in tracked:
            close = [t for t in tracked if t.endswith("/" + p.split("/")[-1])][:3]
            errors.append(f"{where}: {p} is not a tracked file in the repository" + (f" (did you mean {', '.join(close)}?)" if close else ""))
            return
        lines = file_lines(p)
        if lines is None:
            errors.append(f"{where}: file not found: {p}")
            return
        if a:
            a = int(a)
            b = int(b) if b else a
            if not (1 <= a <= len(lines)) or b < a or b > len(lines):
                errors.append(f"{where}: {p} has {len(lines)} lines, ref points at {a}{'-' + str(b) if b != a else ''}")
                return
            if expect:
                window = "\n".join(lines[max(0, a - 4):min(len(lines), b + 3)])
                norm = lambda s: re.sub(r"\s+", " ", s)
                if norm(expect) not in norm(window):
                    near = lines[a - 1].strip()[:90]
                    errors.append(f"{where}: expected text {expect!r} not within 3 lines of {p}:{a} (line {a} is: {near!r})")
        elif expect:
            if expect not in "\n".join(lines):
                errors.append(f"{where}: expected text {expect!r} not found in {p}")

    def check_node(nid, where):
        if nid not in node_ids:
            close = [x for x in node_ids if x and nid and nid.lower() in x.lower()][:3]
            errors.append(f"{where}: unknown node {nid!r}" + (f" (did you mean {', '.join(close)}?)" if close else ""))

    # ---- top level
    if not fragment:
        if not (w.get("title") or "").strip():
            errors.append("title is missing")
        elif len(w["title"].split()) > 4:
            warnings.append("title is longer than four words; keep it a short name such as the repo's own name")
        if len((w.get("overview") or "").strip()) < 200:
            errors.append("overview is missing or shorter than 200 characters")

    group_ids = {x["id"] for x in g.get("groups", [])}
    for i, gr in enumerate(w.get("groups", [])):
        if gr.get("id") not in group_ids:
            close = [x for x in group_ids if gr.get("id") and gr["id"].split("::")[-1] in x][:3]
            errors.append(f"groups[{i}]: unknown group {gr.get('id')!r}" + (f" (did you mean {', '.join(close)}?)" if close else ""))
        if not gr.get("body") and not gr.get("label"):
            errors.append(f"groups[{i}]: give a body (what the group is for) or a label")
    for i, c in enumerate(w.get("components", [])):
        if c.get("id") not in comp_ids:
            errors.append(f"components[{i}]: unknown component {c.get('id')!r}; known: {', '.join(sorted(comp_ids))}")

    kps = w.get("keyParts", [])
    if not partial and not kps:
        errors.append("keyParts is empty; write 5-12 (see references/writing-guide.md)")
    elif not partial and len(kps) < 5:
        warnings.append(f"keyParts has {len(kps)} entries; aim for 5-12")
    elif not partial and len(kps) > KEY_PARTS_MAX:
        errors.append(f"keyParts has {len(kps)} entries; keep the {KEY_PARTS_MAX} that matter most and drop the rest")
    for i, k in enumerate(kps):
        for f in ("title", "node", "ref", "why", "expect"):
            if not k.get(f):
                errors.append(f"keyParts[{i}]: missing {f}")
        if k.get("node"):
            check_node(k["node"], f"keyParts[{i}]")
        check_ref(k.get("ref"), f"keyParts[{i}]", k.get("expect"))
        for j, t in enumerate(k.get("tests", []) or []):
            check_ref(t, f"keyParts[{i}].tests[{j}]")

    flows = w.get("flows", [])
    entries = [n for n in g["nodes"] if n["type"] == "entry"]
    if entries and not flows and not partial:
        errors.append("flows is empty although the graph has entry points; trace at least the main one")
    seen_ids = set()
    covered = set()
    for i, f in enumerate(flows):
        where = f"flows[{i}]"
        if not re.match(r"^[a-z0-9][a-z0-9-]*$", f.get("id", "")):
            errors.append(f"{where}: id must be lowercase letters, digits and hyphens")
        if f.get("id") in seen_ids:
            errors.append(f"{where}: duplicate id {f['id']}")
        seen_ids.add(f.get("id"))
        if f.get("trigger"):
            check_node(f["trigger"], f"{where}.trigger")
            covered.add(f["trigger"])
        steps = f.get("steps", [])
        if len(steps) < 2:
            errors.append(f"{where}: a flow needs at least 2 steps")
        for j, s in enumerate(steps):
            check_node(s.get("node"), f"{where}.steps[{j}]")
            if s.get("from"):
                check_node(s["from"], f"{where}.steps[{j}].from")
            covered.add(s.get("node"))
            if s.get("ref"):
                check_ref(s["ref"], f"{where}.steps[{j}]", s.get("expect"))
            else:
                errors.append(f"{where}.steps[{j}]: every step needs a ref")
            if not s.get("note"):
                errors.append(f"{where}.steps[{j}]: missing note")

    for i, r in enumerate(w.get("recipes", [])):
        if not r.get("title") or not r.get("steps"):
            errors.append(f"recipes[{i}]: needs a title and steps")
        for j, s in enumerate(r.get("steps", [])):
            if not s.get("do"):
                errors.append(f"recipes[{i}].steps[{j}]: missing do")
            if s.get("ref"):
                check_ref(s["ref"], f"recipes[{i}].steps[{j}]", s.get("expect"))
            if s.get("node"):
                check_node(s["node"], f"recipes[{i}].steps[{j}]")

    for i, sm in enumerate(w.get("stateMachines", [])):
        states = set(sm.get("states", []))
        if not states:
            errors.append(f"stateMachines[{i}]: no states")
        for j, t in enumerate(sm.get("transitions", [])):
            for end in ("from", "to"):
                if t.get(end) not in states | {"start", "any"}:
                    errors.append(f"stateMachines[{i}].transitions[{j}]: {end} {t.get(end)!r} is not a listed state (or start/any)")
            check_ref(t.get("ref"), f"stateMachines[{i}].transitions[{j}]", t.get("expect"))

    for i, gt in enumerate(w.get("gotchas", [])):
        for f in ("title", "body", "ref", "expect"):
            if not gt.get(f):
                errors.append(f"gotchas[{i}]: missing {f}")
        if gt.get("severity") not in SEVERITIES:
            errors.append(f"gotchas[{i}]: severity must be one of {sorted(SEVERITIES)}")
        check_ref(gt.get("ref"), f"gotchas[{i}]", gt.get("expect"))

    for nid in (w.get("summaries") or {}):
        check_node(nid, f"summaries[{nid!r}]")
    known_layers = {l["id"] for l in g["layers"]}
    for i, n in enumerate(extras.get("nodes", [])):
        if not n.get("id") or not n.get("label") or not n.get("layer"):
            errors.append(f"extras.nodes[{i}]: needs id, label and layer")
        elif n["layer"] not in known_layers:
            errors.append(f"extras.nodes[{i}]: layer {n['layer']!r} is not one of {sorted(known_layers)}")
        if n.get("kind") is not None and n["kind"] not in KINDS:
            errors.append(f"extras.nodes[{i}]: kind {n['kind']!r} is not one of {sorted(KINDS)}")
        check_ref(n.get("ref"), f"extras.nodes[{i}]", n.get("expect"))
    for i, e in enumerate(extras.get("edges", [])):
        check_node(e.get("source"), f"extras.edges[{i}].source")
        check_node(e.get("target"), f"extras.edges[{i}].target")
        check_ref(e.get("ref"), f"extras.edges[{i}]", e.get("expect"))

    # inline refs and node links inside any prose
    for where, text in walk_text(w):
        for m in REF_IN_TEXT.finditer(text):
            check_ref(f"{m.group(1)}:{m.group(2)}" + (f"-{m.group(3)}" if m.group(3) else ""), f"{where} (inline)")
        for m in NODE_LINK.finditer(text):
            check_node(m.group(1), f"{where} (link)")

    summaries = w.get("summaries") or {}
    long = [k for k, v in summaries.items() if len(v) > 320]
    if long:
        warnings.append("summaries longer than 320 characters: " + ", ".join(long[:8]))
    if partial:
        return errors, warnings

    # ---- coverage warnings
    top = sorted([n for n in g["nodes"] if n["type"] in ("unit", "entry")], key=lambda n: -n["scores"]["core"])[:15]
    missing = [n["id"] for n in top if n["id"] not in summaries and n["type"] == "unit"]
    if missing:
        warnings.append("important units without a summary: " + ", ".join(missing))
    skipped = set(w.get("uncoveredEntries", []) or [])
    for x in skipped:
        check_node(x, "uncoveredEntries")
    uncovered = [e["id"] for e in entries if e["id"] not in covered and e["target"] not in covered and e["id"] not in skipped]
    if uncovered:
        warnings.append(f"{len(uncovered)} entry points are in no flow: " + ", ".join(uncovered[:12]) + (" ..." if len(uncovered) > 12 else ""))
    if not w.get("glossary"):
        warnings.append("glossary is empty")
    if not w.get("gotchas"):
        warnings.append("gotchas is empty; say so in the overview if the code really has none worth flagging")
    return errors, warnings


def main():
    args = sys.argv[1:]
    if len(args) == 1:
        target, errors_warnings = "wiki.json", verify(args[0])
    elif len(args) == 3 and args[1] == "--fragment":
        target, errors_warnings = os.path.basename(args[2]), verify(args[0], wiki_path=args[2], fragment=True)
    elif len(args) == 2 and args[1] == "--base":
        target, errors_warnings = "wiki.base.json", verify(args[0], wiki_path=os.path.join(args[0], "wiki.base.json"), base=True)
    else:
        sys.exit(__doc__)
    errors, warnings = errors_warnings
    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}")
    if errors:
        print(f"\n{len(errors)} error(s). Fix {target} and run verify again.")
        sys.exit(1)
    print(f"\n{target} verified ({len(warnings)} warning(s)).")


if __name__ == "__main__":
    main()
