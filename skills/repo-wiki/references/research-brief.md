# Research brief template (parallel mode)

The lead fills the `{placeholders}` and sends one copy per area to a research agent. `{key_parts_max}` is 12 divided by the number of areas, rounded down (at least 1), so the merged wiki stays within the 12 key parts the verifier allows. Everything between the two lines below is the brief.

---

You are researching one area of a code repository for an onboarding wiki. Your output is a wiki **fragment**: a JSON file in the final wiki format, checked by a verifier before you finish.

- Repository (read only; never create, edit or delete anything in it): `{repo_root}`
- Your area: **{area_title}**, slug `{slug}`. {area_scope}
- Other areas are covered by other agents: {other_areas}. Stay in your area; mention another area only where your flows hand off to it.
- Write exactly one file: `{workspace}/wiki.d/{slug}.json`. Write nothing else anywhere.
- Python for the scripts: `{py}`; scripts in `{skill_dir}/scripts/`. Write it and every other path in full in each command.
- Read nothing outside the repository and the workspace: not installed libraries, not other projects. What a library does is not part of this wiki.

**Keep your context small.** Every turn re-reads everything you have read so far, so a large context makes each turn slower and costs more. Find before you read: use `query.py` and a search (`grep -n` or your search tool) to locate the lines you need, then read only those lines and a few around them (a line range, never a whole file). Do not print a file longer than about 150 lines in full, and do not read a file again that you have already read.

**What the extractor already knows about your area** (from `query.py {workspace} brief {area_key}`; confirm everything in the source before writing it):

```
{brief_output}
```

Useful while researching:

```sh
{py} -I {skill_dir}/scripts/query.py {workspace} node <id>
{py} -I {skill_dir}/scripts/query.py {workspace} callees <Unit>.<method>
{py} -I {skill_dir}/scripts/query.py {workspace} callers <Unit>.<method>
{py} -I {skill_dir}/scripts/query.py {workspace} search <text>
```

**Write these sections** (format: `{skill_dir}/references/wiki-format.md`; how to choose and write them: `{skill_dir}/references/writing-guide.md`):

- `flows`: 1-3 flows that start or mainly run in your area, 4-12 steps each. Every flow `id` starts with `{slug}-`. Use `from` when one unit calls several steps in turn, and `async` on steps that run later.
- `keyParts`: at most {key_parts_max}, the ones that matter most in your area (the whole wiki is limited to 12).
- `gotchas`: only problems you can see in the code, each with the exact line.
- `stateMachines`: only if your area owns an explicit status or stage; ids start with `{slug}-`.
- `recipes`: at most 1, only for a change a newcomer would plausibly make in your area; id starts with `{slug}-`.
- `summaries`: one or two sentences for each of the 8-15 most important units in your area.
- `glossary`: terms specific to your area only (the lead writes cross-cutting terms).
- `extras`: only for external systems or links the extractor missed (see the brief above); each with a `ref` and `expect`. Infrastructure the extractor found already has an id such as `infra:postgres`; link to it instead of adding a duplicate.

Do **not** write `title`, `overview`, `components`, `groups` or `starters`: the lead writes those.

Rules: every `ref` is `path:line` relative to the repository root as `git ls-files` prints it; every key part and gotcha has an `expect` (short text that appears within 3 lines of the ref); node ids come from the graph (`query.py ... search`). Every fact must come from code you read.

**Before you finish**, run until it reports no errors:

```sh
{py} -I {skill_dir}/scripts/verify.py {workspace} --fragment {workspace}/wiki.d/{slug}.json
```

Then reply in at most 150 words: what you covered, anything you were unsure about (with the `path:line` you checked), and any extractor mistake you noticed (wrong layer, missing link, false edge). Do not paste the fragment into your reply.

---
