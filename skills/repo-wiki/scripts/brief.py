"""Plan the research areas and write every brief for parallel mode, so no brief is filled by hand.

Usage: python brief.py plan <workspace>              estimate each area's effort from <workspace>/areas.json
       python brief.py research <workspace>          write briefs/<slug>.md for every area
       python brief.py checker <workspace> <slug>    write briefs/check-<slug>.md (<slug> = an area, or "base")

areas.json lists the areas, in the order the briefs name them:

  {"areas": [{"slug": "supervisor", "title": "Supervisor and planning",
              "keys": ["backend/app/core/agents/supervisor", "backend/app/core/agents/planning"],
              "notes": "Optional sentence added to the area's scope."}]}

Each key is a group id (or its part after "::"), a folder or a file, as `query.py brief` takes them.
A unit belongs to the first area whose key matches it.

Effort is an estimate of how long an area takes to research: one point per 100 lines of code plus one per
5 call sites, summed over the area's units. Research time grows with it, and the slowest area sets the pace
of the whole run, so areas should come out about even. The suggested number of areas scales with the
repository: 2-3 below SMALL_REPO units, 4-12 above, at about EFFORT_TARGET each. An area is flagged when it is well over its even share
(and over EFFORT_TARGET on a large repository), or well under it.

Each brief is the text between the first two lines that are exactly `---` in the template under
references/. A brief with a placeholder left in it, or one that comes out short, is an error, not a file.
"""
import json
import os
import re
import subprocess
import sys

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EFFORT_TARGET = 70  # about 2 minutes of research for one agent; areas that took 2 minutes scored 50-60
KEY_PARTS_MAX = 12  # whole-wiki limit, shared out between the areas
SMALL_REPO = 80  # units; below this, 2-3 areas
MIN_BRIEF = 1500  # characters; less means the template was cut in the wrong place
PLACEHOLDER = re.compile(r"\{[a-z_]+\}")


def load(path, what):
    if not os.path.exists(path):
        sys.exit(f"No {what} at {path}.")
    with open(path) as fh:
        return json.load(fh)


def template(name):
    """The brief is the text between the first two lines that are exactly '---'."""
    with open(os.path.join(SKILL_DIR, "references", name)) as fh:
        lines = fh.read().split("\n")
    seps = [i for i, line in enumerate(lines) if line.strip() == "---"]
    if len(seps) < 2:
        sys.exit(f"references/{name} needs the brief between two lines of '---'; found {len(seps)}")
    return "\n".join(lines[seps[0] + 1:seps[1]]).strip() + "\n"


def fill(text, values, where):
    """Fill {name} placeholders; the brief_output goes in last, since source text may contain braces."""
    def sub(m):
        key = m.group(0)[1:-1]
        return values[key] if key in values and key != "brief_output" else m.group(0)
    out = PLACEHOLDER.sub(sub, text)
    left = sorted(set(PLACEHOLDER.findall(out)) - {"{brief_output}"})
    if left:
        sys.exit(f"{where}: no value for {', '.join(left)}")
    out = out.replace("{brief_output}", values.get("brief_output", "{brief_output}"))
    if "{brief_output}" in out:
        sys.exit(f"{where}: no value for {{brief_output}}")
    if len(out) < MIN_BRIEF:
        sys.exit(f"{where}: the brief came out at {len(out)} characters, which means the template was cut wrongly")
    return out


def write(ws, name, text):
    os.makedirs(os.path.join(ws, "briefs"), exist_ok=True)
    path = os.path.join(ws, "briefs", name)
    with open(path, "w") as fh:
        fh.write(text)
    print(f"wrote {path} ({len(text)} characters)")


def areas_of(ws):
    data = load(os.path.join(ws, "areas.json"), "areas.json")
    areas = data.get("areas") if isinstance(data, dict) else None
    if not areas or not all(isinstance(a, dict) and a.get("slug") and a.get("title") and a.get("keys") for a in areas):
        sys.exit("areas.json needs {\"areas\": [{\"slug\", \"title\", \"keys\": [...]}, ...]}")
    slugs = [a["slug"] for a in areas]
    bad = [s for s in slugs if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", s)]
    if bad or len(set(slugs)) != len(slugs):
        sys.exit(f"area slugs must be unique, lowercase and hyphenated: {', '.join(bad) or 'duplicates'}")
    return areas


def matches(n, key, groups):
    key = key.strip().rstrip("/")
    if any(gid == key or gid.split("::")[-1] == key for gid in groups):
        return n.get("group") in [gid for gid in groups if gid == key or gid.split("::")[-1] == key]
    path = n.get("path") or ""
    return path == key or path.startswith(key + "/")


def effort(units):
    lines = sum((n.get("end") or n["line"]) - n["line"] + 1 for n in units)
    calls = sum(len(n.get("calls", [])) for n in units)
    return round(lines / 100 + calls / 5)


def plan(ws):
    areas = areas_of(ws)
    g = load(os.path.join(ws, "graph.json"), "graph.json; run extract.py first")
    groups = [gr["id"] for gr in g.get("groups", [])]
    units = [n for n in g["nodes"] if n["type"] == "unit"]
    owner = {}
    for a in areas:
        for key in a["keys"]:
            hit = [n for n in units if matches(n, key, groups)]
            if not hit:
                sys.exit(f"area {a['slug']}: key {key!r} matches no unit")
            for n in hit:
                owner.setdefault(n["id"], a["slug"])
    total = effort(units)
    lo, hi = (2, 3) if len(units) < SMALL_REPO else (4, 12)
    suggest = min(hi, max(lo, round(total / EFFORT_TARGET)))
    share = total / suggest
    target = share if len(units) < SMALL_REPO else min(EFFORT_TARGET, share)
    print(f"whole repository: {len(units)} units, effort {total}; use {suggest} areas ({lo} to {hi} for a repository this size), "
          f"about {round(share)} effort each\n")
    if len(areas) < lo or len(areas) > hi:
        print(f"areas.json has {len(areas)} areas; use {lo} to {hi}\n")
    over = []
    for a in areas:
        mine = [n for n in units if owner.get(n["id"]) == a["slug"]]
        e = effort(mine)
        flag = "  OVER TARGET: split it" if e > target * 1.3 else ("  small: combine it" if e < share / 3 else "")
        print(f"{a['slug']:20} effort {e:4}  units {len(mine):4}{flag}")
        if flag.startswith("  OVER"):
            over.append((a, mine))
    for a, mine in over:
        by_dir = {}
        for n in mine:
            by_dir.setdefault(os.path.dirname(n["path"]), []).append(n)
        print(f"\n{a['slug']} by folder (effort, units):")
        for d, ns in sorted(by_dir.items(), key=lambda x: -effort(x[1]))[:10]:
            print(f"  {effort(ns):4} {len(ns):4}  {d}")
    left = [n for n in units if n["id"] not in owner]
    if left:
        by_group = {}
        for n in left:
            by_group.setdefault(n.get("group") or "?", []).append(n)
        print(f"\nnot in any area: {len(left)} units, effort {effort(left)}")
        for gid, ns in sorted(by_group.items(), key=lambda x: -effort(x[1]))[:10]:
            print(f"  {effort(ns):4} {len(ns):4}  {gid}")


def common(ws):
    g = load(os.path.join(ws, "graph.json"), "graph.json; run extract.py first")
    return {"repo_root": g["root"], "workspace": ws, "skill_dir": SKILL_DIR, "py": sys.executable}


def research(ws):
    areas = areas_of(ws)
    base = common(ws)
    for a in areas:
        q = subprocess.run([sys.executable, "-I", os.path.join(SKILL_DIR, "scripts", "query.py"), ws, "brief", *a["keys"]],
                           capture_output=True, text=True)
        if q.returncode != 0 or not q.stdout.strip():
            sys.exit(f"area {a['slug']}: query.py brief failed: {(q.stderr or q.stdout).strip()}")
        others = [f"{o['title']} (`{o['slug']}`)" for o in areas if o is not a]
        values = dict(base,
                      slug=a["slug"], area_title=a["title"], area_key=" ".join(a["keys"]),
                      area_scope=f"It covers {', '.join('`' + k + '`' for k in a['keys'])}." + (f" {a['notes']}" if a.get("notes") else ""),
                      other_areas=", ".join(others) or "none",
                      key_parts_max=str(max(1, KEY_PARTS_MAX // len(areas))),
                      brief_output=q.stdout.rstrip())
        write(ws, f"{a['slug']}.md", fill(template("research-brief.md"), values, f"research brief {a['slug']}"))


def checker(ws, slug):
    base = common(ws)
    py, sd = base["py"], base["skill_dir"]
    if slug == "base":
        values = dict(base, slug="base", file="wiki.base.json",
                      what="the overview, the feature-group descriptions, the infrastructure and external links (`extras`) and the end-to-end flows",
                      verify_command=f"{py} -I {sd}/scripts/verify.py {ws} --base")
    else:
        area = next((a for a in areas_of(ws) if a["slug"] == slug), None)
        if not area:
            sys.exit(f"No area {slug!r} in areas.json")
        if not os.path.exists(os.path.join(ws, "wiki.d", f"{slug}.json")):
            sys.exit(f"No fragment wiki.d/{slug}.json yet")
        values = dict(base, slug=slug, file=f"wiki.d/{slug}.json", what=f"one research area, **{area['title']}**",
                      verify_command=f"{py} -I {sd}/scripts/verify.py {ws} --fragment {ws}/wiki.d/{slug}.json")
    write(ws, f"check-{slug}.md", fill(template("checker-brief.md"), values, f"checker brief {slug}"))


def main():
    cmd, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if cmd in ("plan", "research") and len(args) == 1:
        (plan if cmd == "plan" else research)(args[0])
    elif cmd == "checker" and len(args) == 2:
        checker(*args)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
