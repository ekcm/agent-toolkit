# Researching and writing the wiki

The graph tells you what is connected. The wiki tells a newcomer what matters and how work moves through the code. It explains; it does not review. Do not look for bugs, risks or problems, and do not write about them. Everything you write must come from code you have read in this session.

## Research order

1. **Orient.** Read the extract report: languages, components, entry points, top 30 by importance, unreferenced units. Read the README and any architecture docs, but treat them as claims to check against the code, not as facts.
2. **Entry points.** `query.py <ws> entries`. Group them: HTTP routes, scheduled jobs, consumers, CLIs, app objects. Each group usually becomes one or more flows.
3. **Trace the main flows.** For each, start at the entry and follow calls: `query.py <ws> callees <Unit>.<method>`, then open each callee's source at the line given. Note every write to storage, every outbound call, every place work is handed to something that runs later (queue, scheduler, poller). Stop where the flow leaves the repository or reaches storage.
4. **Find the state.** Search for enums or columns named status, state, stage, phase. Find every writer (`query.py <ws> callers <method>`). If the transitions are spread across several files, it deserves a state machine.
5. **Read the top units** you have not met yet in `query.py <ws> top 30`. Write a summary for each as you go.
6. **Name the architecture.** `query.py <ws> groups` and `query.py <ws> infra`. Give the largest and most connected groups a plain-language label and a one-paragraph `body`: what they own, what they depend on, which infrastructure they touch. Check each infrastructure node's evidence line; if the extractor missed something the code clearly uses (another service, a queue it reaches through a library), add it under `extras` with a `kind`. The architecture view is what a reader explains the system from, so it must be right.
7. **Find the tests** for each key part (the node's `tests` field, or search the test folders).

On a large repository, do steps 2 to 4 for the two or three most important components only, and say in the overview which parts the wiki covers in depth.

## Groups and coupling

The page shows each feature group's cohesion (share of its code dependencies that stay inside it) and instability (Ce / (Ca + Ce)). Use them in the group bodies when they say something: a large group with low cohesion is usually several concepts in one package; a group with instability near 0 that many others depend on is where changes ripple furthest.

## What makes a key part

Pick 5 to 12. A key part is code a newcomer must understand before changing anything nearby. Pick it for at least one of these reasons, and say which in `why`:

- **It holds a rule:** a state machine, a uniqueness or ordering guarantee, money or permission logic.
- **It is a boundary:** the one place that talks to another service, a queue or the database for a given concept.
- **Everything goes through it:** an orchestrator or a shared query that many flows depend on.

High importance scores are a hint, not a reason. A logger can top the "depended on" ranking and still not be a key part.

## Flows

- One flow per user-visible or operational outcome: "Upload a term sheet", "Nightly reconciliation", not "TermSheetController".
- Steps follow the real call order. When one unit calls several things in turn (a service that writes three tables and calls a client), give each of those steps `"from": "<that unit>"`, so the sequence diagram shows who calls whom instead of a chain.
- Use the line of the call or of the method that does the work, not the top of the file.
- Notes say what happens and anything surprising: the batch size, the error handling, what gets written. Keep each under about 160 characters.
- Put `async` on the first step that runs later (for example the worker picking up the task), not on the step that enqueues it, and say what triggers it.
- Include the storage writes and outbound calls as steps (table and external nodes), since those are what a reader most often needs.

## Change recipes

2 to 5 changes a newcomer is likely to be asked to make (add an endpoint, add a field end to end, add a job, support a new variant). Derive them from how the existing examples are built: find two similar existing features and list what each touched. Steps are imperative ("Add the value to `ProductType`") with a ref to the place to edit.

## Writing style

- Write for a developer who is new to this repository but not to programming.
- Lead with what something does and why it matters; keep mechanics for the source link.
- Plain, specific sentences. Name the actual class, table, field or number.
- Read, never run. Do not write code, scripts or test programs, and do not run the repository's code or tools to see what they do: what the code says is what goes in the wiki.
- No speculation. If you could not confirm something, leave it out or say it is unconfirmed.
- Domain terms go in the glossary with their meaning first and their name in the code second.

## Optional second opinion

If another coding agent's CLI is available and the user agrees, ask it to read `wiki.json` and the repository and report any claim it cannot confirm in the code, with the line it checked. Fix what it confirms is wrong, then run `verify.py` again. It reviews; you decide what changes.
