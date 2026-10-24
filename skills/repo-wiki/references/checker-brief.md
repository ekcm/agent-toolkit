# Checker brief template (parallel mode)

`brief.py checker <workspace> <slug>` fills this template and writes `briefs/check-<slug>.md`; never fill it by hand. The lead gives that file, unchanged, to a checker agent: one per research fragment as each fragment arrives, and one (`<slug>` = `base`) for the lead's own `wiki.base.json` as soon as it is written. When the lead later adds the cross-area flows to the base, it writes the same brief again and starts a second base checker, which checks only the claims added since. Do not add your own view of the file: the checker's value is that it starts from the code, not from anyone's conclusions. Run checkers on a fast model where you can choose one. The brief is the text between the next two lines that are exactly `---`.

---

You are checking one part of an onboarding wiki against the code it describes. Another agent wrote it; your job is to find what does not hold. Assume nothing in it is right until you have read the code.

- Repository (read only; never create, edit or delete anything in it): `{repo_root}`
- The part: `{workspace}/{file}`, covering {what}. Edit only this file and your check record, `{workspace}/checks/{slug}.json`. Write nothing else anywhere, and run nothing but the commands below and read-only searches (`grep`, `sed -n`) inside the repository. Write no code and run none: judge every claim by reading.
- Format: `{skill_dir}/references/wiki-format.md`. Python for the scripts: `{py}`; scripts in `{skill_dir}/scripts/`. Write every path in full in each command.
- Read nothing outside the repository: not installed libraries, not other projects. If a claim depends on what a library does, judge it from how the repository calls the library, or delete it.
- Keep your context small: search for the lines a claim cites, read those lines and a few around them, never a whole file.

**If `{workspace}/checks/{slug}.json` already exists**, this part has been checked before and has had claims added or changed since. Run `{py} -I {skill_dir}/scripts/checks.py {workspace} {slug} --status`, check only the claims it lists, and in step 4 add their verdicts to the existing record, keeping every entry already in it.

Check these, in this order, and nothing else:

1. **Flow steps.** For each step, confirm the call happens at the `ref`, in that order, from the unit named in `from`, and that steps marked `async` really run later (a queue, a task, an event).
2. **State machines.** Confirm every state and transition exists in the code, and that none is missing.
3. **Extras, and for the base the prose.** Each `extras` node and edge: does the `ref` show that system or link? For the base, also each sentence of the overview and each group description that states a fact about the code (what calls what, what is stored where, which service is used for what).

Key parts, recipes and summaries are not yours to check; the verifier has already checked their references.

For anything that does not hold: correct it if the code shows what is true, otherwise delete it. Do not add new sections, and do not add or report bugs or problems you notice: the wiki does not cover them. Keep ids unchanged so nothing else breaks.

Then run, until it reports no errors:

```sh
{verify_command}
```

4. **Record a verdict for every claim.** Only after your last edit, list the claims:

   ```sh
   {py} -I {skill_dir}/scripts/checks.py {workspace} {slug} --list
   ```

   Write `{workspace}/checks/{slug}.json` with one entry for each key it prints, and one for each claim you deleted:

   ```json
   {"items": {"<key exactly as printed>": {"verdict": "confirmed", "evidence": "path/to/file.py:42", "note": "optional"}},
    "deleted": [{"was": "<key or title>", "why": "one line"}]}
   ```

   `verdict` is `confirmed` (it held as written) or `corrected` (you changed it). `evidence` is the `path:line` you read to decide, which is not always the claim's own ref (for a missing transition, it is where the transition happens). Then stamp it, which fails on a missing verdict or a bad evidence line:

   ```sh
   {py} -I {skill_dir}/scripts/checks.py {workspace} {slug}
   ```

   The merge refuses any claim without a stamped verdict, and any claim edited after the stamp, so stamp last.

Reply in at most 120 words: the stamp line `checks.py` printed, each item you corrected or deleted (one line each, with `file:line` and why), and any flow step or link the part is missing.

---
