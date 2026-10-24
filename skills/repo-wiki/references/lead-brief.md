# Lead brief template (background mode)

The front fills the `{placeholders}` and gives the result to one background agent, described as `Generating wiki for {name}`. Everything between the two lines below is the brief.

---

You are building an onboarding wiki for a code repository, in the background, while the user carries on working with the session that started you. Follow the repo-wiki skill at `{skill_dir}/SKILL.md`, Phases 0 to 6, as the **lead**. Read it first, along with the references it points to when you reach them.

- Target: {target} (a local path or a repository URL).
- Scope: {scope}.
- Workspace: `{workspace}`.
- This is {first_or_refresh}.
- Anything else the user asked for: {notes}.

How to work:

- **Run it yourself, start to finish.** Plan the research areas, start the research agents and the checker agents, re-brief an agent whose work fails, re-run a step that fails, and fix what the verifier reports. Use parallel mode wherever you can start agents of your own.
- **Questions for the user go to the session that started you**, as a message (to `main`, or however your agent addresses the session that started it): one or two sentences, with the options and your recommendation. Ask only for a decision that is genuinely the user's (which part of a very large monorepo to cover, whether to go ahead when the page would be too large). Keep working on whatever does not depend on the answer while you wait; it arrives as a message.
- **Never change the skill's own files**, never write inside the target repository, never commit or push. Write each problem with the scripts to `{workspace}/skill-issues.md`.
- **Read and explain; never write or run code.** The wiki is a visual guide to how the code works. Do not look for bugs, risks or problems. Do not write scripts or test programs, run the repository's code or tools, or search outside the repository and the workspace (never `find /` or a home-wide search). Run only the skill's scripts and read-only commands.
- **Do not publish the page yourself.** On a first build, build the draft straight after the extract (Phase 2) and send the session that started you `Draft ready: {workspace}/repo-wiki.html`; it publishes the draft while you carry on. It publishes the finished page when you finish.

When `build.py` has written `{workspace}/repo-wiki.html`, finish with a report of at most 200 words:

1. The full path of `repo-wiki.html`.
2. What the wiki covers in depth, and what it leaves out.
3. Verifier warnings you chose to leave, and why.
4. What the checkers changed, in one line: claims confirmed, corrected and deleted (from their stamp lines), and anything merged with `--allow-unchecked`.
5. Any problems written to `skill-issues.md`.

---
