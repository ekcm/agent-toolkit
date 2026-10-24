# wiki.json format

The agent writes `wiki.json` in the workspace. `verify.py` checks it against `graph.json` and the repository, and `build.py` refuses to build until it passes.

## Conventions

- **Node ids** come from `graph.json` (`query.py <ws> search <text>` finds them). Classes in Java/Kotlin use the class name (`TermsheetService`); every other language uses the file path without extension (`pythia/web/routers/mupload`); entry points start with `ep:`, `trg:`, `app:` or `cli:`; tables with `table:`.
- **Refs** are `path:line` or `path:start-end`, with the path relative to the repository root, exactly as `git ls-files` prints it. The file must be tracked by git. A ref without a line (`path`) is allowed for whole files.
- **expect** is a short piece of text that must appear within 3 lines of the ref (anywhere in the file for a ref without a line). It is required on every key part, and allowed on any object with a `ref`, so a later refresh catches refs that drifted.
- **Prose fields** accept `inline code`, **bold**, `[[nodeId]]` links to a node, blank-line paragraphs, `- ` bullet lists, and inline refs written as `` `path/to/File.java:42` `` (backticks required, and the file name must have an extension), which become source links. Inline refs are verified too.

## Shape

```json
{
  "title": "Termsheet Import",
  "overview": "Two to four paragraphs: what the system does, for whom, how work moves through it, and the two or three facts a newcomer most needs (async boundaries, storage model, unusual conventions).",
  "groups": [
    {"id": "service", "label": "Import orchestration", "body": "What this feature group is responsible for, and how it relates to its neighbours."}
  ],
  "components": [
    {"id": "termsheet-service", "role": "Domain, persistence, jobs", "body": "What lives here and how it relates to the other components."}
  ],
  "keyParts": [
    {
      "title": "Import status is an append-only log",
      "node": "ImportStatusRepository",
      "ref": "termsheet-service/src/main/java/com/edgelab/termsheet/repository/ImportStatusRepository.java:30",
      "expect": "onConflictDoNothing",
      "why": "Every state change is a new row; the newest row is the current state. All job batching and the UI list depend on this.",
      "invariant": "UNIQUE(import_id, status): each status at most once per import.",
      "failure": "A retry that needs to revisit a status is silently dropped.",
      "tests": ["termsheet-service/src/test/java/com/edgelab/termsheet/repository/ImportStatusRepositoryIT.java"]
    }
  ],
  "flows": [
    {
      "id": "upload",
      "title": "Upload a term sheet",
      "trigger": "ep:POST /import",
      "summary": "One sentence on what the flow achieves and whether it is synchronous.",
      "steps": [
        {"node": "ep:POST /import", "ref": "termsheet-api/.../TermSheetController.java:47", "note": "Multipart upload, 16MB max."},
        {"node": "TermsheetService", "from": "ep:POST /import", "ref": "termsheet-service/.../TermsheetService.java:24", "expect": "importFile", "note": "Orchestrates the upload."},
        {"node": "RetrieveImportStatusJob", "ref": "termsheet-service/.../RetrieveImportStatusJob.java:39", "async": "every 3 minutes", "note": "Polls the parser."}
      ]
    }
  ],
  "recipes": [
    {
      "id": "new-product-type",
      "title": "Add a product type",
      "goal": "Support a third structured product alongside RC and BRC.",
      "steps": [
        {"do": "Add the type to the enum.", "ref": "termsheet-service/.../ProductType.java:9", "node": "ProductType"},
        {"do": "Write a mapper that implements `StructuredProductMapper` and decides `isApplicable`.", "ref": "oracle-api/.../StructuredProductMapper.java:6"}
      ]
    }
  ],
  "stateMachines": [
    {
      "id": "import-status",
      "title": "Import status",
      "summary": "Where the state lives and what reads it.",
      "states": ["IN_PROGRESS", "PARSING_COMPLETE", "TO_BE_VALIDATED", "DONE", "FAILED"],
      "transitions": [
        {"from": "start", "to": "IN_PROGRESS", "by": "POST /import", "ref": "oracle-api/.../OracleRequestMapper.java:33"},
        {"from": "any", "to": "FAILED", "by": "content job error", "ref": "termsheet-service/.../RetrieveParsedContentJob.java:68"}
      ]
    }
  ],
  "glossary": [
    {"term": "Barrier Reverse Convertible", "def": "Domain meaning first, then where the code models it: `BarrierReverseConvertible`."}
  ],
  "summaries": {
    "TermsheetService": "One or two sentences: what it does and why a reader would open it.",
    "ep:POST /import": "Uploads one PDF and starts an import."
  },
  "extras": {
    "nodes": [{"id": "ext:pythia", "label": "Pythia", "layer": "external", "kind": "service", "ref": "oracle-api/src/main/resources/ts-oracle-openapi.yaml", "summary": "The LLM extraction service this calls."}],
    "edges": [{"source": "OracleClient", "target": "ext:pythia", "kind": "http", "ref": "oracle-api/.../OracleClient.java:47", "expect": "postForEntity"}]
  },
  "starters": ["Walk me through what happens after POST /import.", "Why could an import stay IN_PROGRESS forever?"]
}
```

## Fragments (parallel mode)

In parallel mode the wiki is assembled from several files in the workspace, then `merge.py` writes `wiki.json`:

- `wiki.base.json`, written by the lead: `title`, `overview`, `groups`, `components`, cross-area `glossary` terms, `extras`, `starters`, `uncoveredEntries`, and the end-to-end flows that span areas.
- `wiki.d/<slug>.json`, one per research area: any of `flows`, `keyParts`, `stateMachines`, `recipes`, `summaries`, `glossary`, `extras`, `uncoveredEntries`. Never `title`, `overview`, `components`, `groups` or `starters`.

Each fragment uses exactly the format below and is checked on its own with `verify.py <workspace> --fragment <file>`, which skips whole-wiki requirements but checks every ref, `expect` and node id. The base is checked on its own with `verify.py <workspace> --base`, which also requires its title and overview. Together the fragments may hold at most 12 key parts, the limit for the whole wiki, so each research brief gives its area a share. Flow, recipe and state-machine ids in a fragment start with its slug (`api-send-message`), so they cannot collide.

Each fragment, and the base, is then checked by an agent that did not write it. The checker records a verdict for every claim (each flow step, state-machine transition and extras node and edge) in `checks/<slug>.json` (`checks/base.json` for the base), with the `path:line` it read to decide, and `checks.py` stamps the record with each claim's content. `merge.py` refuses a claim with no stamped verdict, or one edited after its stamp. The record's format is in `scripts/checks.py`. When two sources describe the same key part (same node), term, summary or extra, the merge keeps the first and reports the rest.

## Field rules

| Field | Required | Rules |
|---|---|---|
| `title` | yes | The repository's or system's own name, at most four words. The page is titled "<title> Wiki". |
| `overview` | yes | At least 200 characters. |
| `groups` | recommended | Ids from `graph.json` `groups` (`query.py <ws> groups`). Give the 5-10 largest or most coupled groups a `body` saying what they are for; `label` renames a group on the page. |
| `components` | no | Only for ids in `graph.json` `components`. Worth writing for a monorepo. |
| `keyParts` | yes | 5 to 12 entries. Each needs `title`, `node`, `ref`, `expect`, `why`; `invariant`, `failure` and `tests` are strongly recommended. |
| `flows` | yes if the graph has entry points | `id` is lowercase-hyphenated and unique. At least 2 steps, each with `node`, `ref`, `note`. `from` names the caller when it is not the previous step's node (the sequence diagram draws the arrow from it); write it whenever one unit calls several steps in turn. `async` (a short label such as "every 3 minutes" or "when the queue delivers") marks a step that happens later, not in the same call. |
| `recipes` | recommended | 2 to 5 common changes. Steps in the order a developer would do them. |
| `stateMachines` | when the code has explicit states | `from`/`to` must be listed states, or `start` / `any`. |
| `glossary` | recommended | Domain terms first; code names second. |
| `summaries` | yes for the top units | Keyed by node id, at most 320 characters. `verify.py` warns about important units without one. |
| `extras` | no | Nodes and edges static analysis cannot see: other services, other repositories, infrastructure the extractor missed. Every one needs a `ref` as evidence. Layers: `external`, `table`, `client`, `job`, `service`. `kind` (`database`, `cache`, `queue`, `storage`, `search`, `auth`, `service`) picks the icon in the architecture view. Do not duplicate infrastructure the extractor found (`infra:redis`, `infra:postgres`, ...): link to those ids instead. |
| `starters` | no | 3 to 5 questions for the Ask tab. |
| `gotchas` | never | The wiki explains how the code works; it does not list bugs, risks or problems. `verify.py` rejects the section. |
| `uncoveredEntries` | no | Entry point ids you deliberately leave out of every flow (health checks, metrics, duplicate legacy routes). Say why in the overview. `verify.py` stops warning about them. |
