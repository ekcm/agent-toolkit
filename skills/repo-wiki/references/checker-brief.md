# Checker brief template (parallel mode)

The lead fills the `{placeholders}` and gives the result to a checker agent: one per research fragment as each fragment arrives, and one for the lead's own `wiki.base.json` once the cross-area flows are in it. Do not add your own view of the file: the checker's value is that it starts from the code, not from anyone's conclusions. Run checkers on a fast model where you can choose one. Everything between the two lines below is the brief.

For a research fragment, `{file}` is `wiki.d/{slug}.json`, `{what}` is "one research area, **{area_title}**", and `{verify_command}` is `{py} -I {skill_dir}/scripts/verify.py {workspace} --fragment {workspace}/wiki.d/{slug}.json`.

For the base, `{file}` is `wiki.base.json`, `{what}` is "the overview, the feature-group descriptions, the infrastructure and external links (`extras`) and the end-to-end flows", and `{verify_command}` is `{py} -I {skill_dir}/scripts/verify.py {workspace} --base`.

---

You are checking one part of an onboarding wiki against the code it describes. Another agent wrote it; your job is to find what does not hold. Assume nothing in it is right until you have read the code.

- Repository (read only; never create, edit or delete anything in it): `{repo_root}`
- The part: `{workspace}/{file}`, covering {what}. Edit only this file. Write nothing else anywhere.
- Format: `{skill_dir}/references/wiki-format.md`. Python for the scripts: `{py}`; scripts in `{skill_dir}/scripts/`. Write every path in full in each command.
- Read nothing outside the repository: not installed libraries, not other projects. If a claim depends on what a library does, judge it from how the repository calls the library, or delete it.
- Keep your context small: search for the lines a claim cites, read those lines and a few around them, never a whole file.

Check these, in this order, and nothing else:

1. **Gotchas.** Open the code at each `ref` and read enough around it to judge the claim. Is the problem real, does it happen the way described, and is the severity fair? A gotcha that is wrong is worse than none.
2. **Flow steps.** For each step, confirm the call happens at the `ref`, in that order, from the unit named in `from`, and that steps marked `async` really run later (a queue, a task, an event).
3. **State machines.** Confirm every state and transition exists in the code, and that none is missing.
4. **For the base only:** each sentence of the overview and each group description that states a fact about the code (what calls what, what is stored where, which service is used for what), and each `extras` link.

Key parts, recipes and summaries are not yours to check; the verifier has already checked their references.

For anything that does not hold: correct it if the code shows what is true, otherwise delete it. Do not add new findings or new sections; note them in your reply instead. Keep ids unchanged so nothing else breaks.

Then run, until it reports no errors:

```sh
{verify_command}
```

Reply in at most 120 words: how many items you checked, each item you corrected or deleted (one line each, with `file:line` and why), and anything worth adding that you noticed but did not add.

---
