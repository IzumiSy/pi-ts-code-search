# Code Searcher Plan

## Goal

Provide a TypeScript/TSX-focused **semantic-ish code search** extension for pi so the agent can search code at the **symbol/index level** instead of relying only on `rg`/`grep` text matches.

The implementation will use:
- **`ts-morph`** for project loading and TS/TSX symbol extraction
- **`MiniSearch`** for in-memory indexing and ranking

This is **not** an LSP tool and **not** a vector database. The first version should be a fast, read-only repo-local index with good symbol-oriented results and minimal custom search infrastructure.

## Non-goals for MVP

- No diagnostics
- No rename/refactor actions
- No references/implementations resolution
- No background daemon
- No file watcher
- No embeddings/vector DB
- No multi-language indexing in v1
- No raw Compiler API traversal unless `ts-morph` falls short in a narrow spot

## MVP shape

### User value

Allow the agent to answer questions like:

- "Find auth token related code"
- "Search for session manager symbols"
- "Show exports in this file"
- "Find React components related to login"
- "Find hooks around cache invalidation"

with better results than plain text grep.

### Core idea

Build a repo-local in-memory index of TS/TSX symbols using **`ts-morph`**, then query that index with **`MiniSearch`** using field boosts and a small amount of post-ranking.

## Dependencies

MVP dependencies:
- `ts-morph`
- `minisearch`

Likely runtime support:
- `typescript`

Optional later:
- `react-docgen-typescript` if TSX prop extraction needs help

## Architecture

### 1. Project loader / index builder

Use `ts-morph`'s `Project` as the main entry point.

Inputs:
- `tsconfig.json` when present
- fallback glob/source-file discovery when needed
- TS/TSX/JS/JSX files only

Excluded by default:
- `node_modules`
- `dist`
- `build`
- `coverage`
- `.next`
- `.turbo`
- generated declaration files

`ts-morph` should handle the boring parts first:
- loading project config
- populating source files
- navigating declarations
- reading exported/default-export state

### 2. Index entries

Each symbol becomes one index entry.

```ts
interface IndexEntry {
  id: string
  file: string
  line: number
  column: number
  name: string
  kind: "function" | "class" | "interface" | "type" | "enum" | "const" | "component" | "hook" | "method" | "variable" | "export"
  exported: boolean
  defaultExport: boolean
  container?: string
  pathTokens: string[]
  nameTokens: string[]
  jsDocTokens: string[]
  propTokens?: string[]
  importTokens?: string[]
  text: string
}
```

MiniSearch documents can be built directly from these entries, for example:

```ts
interface SearchDocument {
  id: string
  name: string
  nameText: string
  pathText: string
  jsDocText: string
  propText: string
  importText: string
  kind: string
  text: string
}
```

### 3. Search engine / ranking

Use **MiniSearch** as the default search engine instead of building a custom inverted index first.

Primary ranking signals:
- symbol name match
- normalized token match (`getAccessToken` -> `get access token`)
- file path token match
- JSDoc token match
- prop token match for TSX components
- kind filtering / kind-aware boost

Additional lightweight post-ranking is fine for:
- exported boost
- default export boost
- component/hook boost
- exact symbol-name tie-breaks

This should behave like **semantic grep**, not true semantic/vector search.

### 4. Query tools

Minimal first set:

#### `ts_code_search_search`
Search the symbol index by natural-ish keyword query.

Example inputs:
- `{ "query": "auth token" }`
- `{ "query": "session manager", "kind": "class" }`
- `{ "query": "login", "limit": 10 }`
- `{ "query": "cache invalidation", "refresh": true }`

Returns ranked symbol hits with file, line, kind, exported flag, and a small preview.

#### `ts_code_search_file_outline`
Return indexed symbols for one file.

Example:
- `{ "file": "src/auth.ts" }`
- `{ "file": "src/auth.ts", "refresh": true }`

#### `ts_code_search_exports`
Return export-oriented entries for a file or the whole project.

Example:
- `{ "file": "src/auth.ts" }`
- `{ "query": "session" }`

Optional if still cheap:

#### `ts_code_search_related`
Given a file + symbol name, return nearby/index-neighbor entries from the same file/container.

## Implementation plan

### Phase 1: Basic index with `ts-morph` + `MiniSearch`

- Load project through `ts-morph`
- Discover candidate source files from `tsconfig.json` or fallback globs
- Parse files through `ts-morph`
- Extract top-level symbols:
  - functions
  - classes
  - interfaces
  - type aliases
  - enums
  - exported const/let/var
- Tokenize names and file paths
- Build `IndexEntry[]`
- Build a MiniSearch index over symbol documents
- Implement `ts_code_search_search`
- Implement `ts_code_search_file_outline`

Exit condition:
- `ts_code_search_search` returns useful ranked results for common symbol-name queries

### Phase 2: TSX-aware entries

- Detect React components heuristically
- Detect hooks (`useX`)
- Extract prop names where practical
- Add component/hook boosts
- Decide whether plain `ts-morph` extraction is enough or if `react-docgen-typescript` is worth adding

Exit condition:
- searching for component or hook concepts beats plain grep in UI-heavy repos

### Phase 3: Search quality

- Add JSDoc/leading-comment tokens
- Add import-module tokens
- Add kind filters
- Improve MiniSearch field boosts
- Add a small post-ranking pass for exported/default/component/hook ties
- Add small snippets/previews
- Add `ts_code_search_exports`

Exit condition:
- typical agent queries produce sensible top 5 results without manual retries

### Phase 4: Incremental refresh

Keep it simple:
- build lazily on first tool call
- cache per `cwd`
- rebuild on demand when stale
- optionally refresh touched files after tool calls

Do **not** start with file watchers.

Exit condition:
- edits in normal agent flow can be reflected without restarting the session

## Update strategy

MVP:
- lazy-build index on first tool call
- store singleton per `cwd`
- expose a cheap `refresh` flag on tools

Later:
- refresh single file after known edits
- invalidate cached entries for changed files only
- keep MiniSearch in sync with add/remove/update operations instead of full rebuilds

## Suggested project structure

```text
extensions/code-searcher/
  index.ts
  src/
    config.ts
    discover.ts
    extract.ts
    tokenize.ts
    documents.ts
    search.ts
    store.ts
    tools.ts
    format.ts
    types.ts
```

Notes:
- `config.ts` and `discover.ts` should stay thin because `ts-morph` already covers most of the boring project-loading work
- `search.ts` should mostly be MiniSearch setup/query glue, not a custom engine
- `documents.ts` can hold `IndexEntry -> SearchDocument` conversion

## Extraction rules

Start boring.

Extract first:
- exported declarations first
- then notable non-exported top-level declarations
- optionally class methods if clearly useful

Detect components heuristically:
- PascalCase function returning JSX
- `const X = () => <...>`
- function/arrow typed with React-ish props

Detect hooks heuristically:
- symbol name starts with `use`

Skip for MVP:
- full semantic type resolution beyond what `ts-morph` already makes easy
- cross-file symbol graph
- exact references
- implementation finding

## Tokenization rules

Normalize aggressively:
- lowercase
- split camelCase/PascalCase
- split `_`, `-`, `/`, `.`
- dedupe tokens
- optionally singularize only if trivial; otherwise skip

Examples:
- `getAccessToken` -> `get access token`
- `src/auth/token-store.ts` -> `src auth token store ts`

## Search / ranking outline

MiniSearch should do the bulk of candidate retrieval.

Suggested indexed fields:
- `nameText`
- `pathText`
- `jsDocText`
- `propText`
- `importText`
- `text`

Suggested boost shape:

```ts
miniSearch.search(query, {
  boost: {
    nameText: 5,
    pathText: 2,
    jsDocText: 1.5,
    propText: 1.5,
    importText: 1,
    text: 1,
  },
  prefix: true,
})
```

Then apply a tiny post-score/tie-break pass:

```ts
score = miniSearchScore
+ exactNameMatch * 100
+ exported * 8
+ defaultExport * 6
+ kindMatch * 8
+ componentOrHookMatch * 8
```

Keep these weights plain constants in one file for easy tuning.

## Why `ts-morph` first

Because the goal is TS/TSX symbol search, not generic AST search.

`ts-morph` gives us:
- easier project loading
- easier declaration traversal
- easier export/default-export detection
- easier access to source positions and symbol-ish metadata

That is a better fit than starting from raw `tree-sitter` or the raw TypeScript Compiler API.

## Why MiniSearch first

Because the hard part is the **code-aware extraction**, not building yet another inverted index.

MiniSearch already gives us:
- in-memory indexing
- decent ranking
- field boosts
- prefix/fuzzy-ish search behavior if needed later

Plan:
1. extract structured code data well
2. feed it into MiniSearch
3. add only a tiny post-ranking layer where code-specific boosts matter

## pi integration

Extension behavior:
- lazy init on first tool call
- one in-memory index per `cwd`
- no long-lived background process
- no factory-time heavy work
- session shutdown can simply clear caches

Tool guidance should tell the agent:
- use `ts_code_search_search` for semantic TS/TSX search
- use `read` for exact file inspection
- use `rg`/`grep` only for raw text/path search

## Testing

Keep tests small.

Need:
- tokenizer tests
- symbol extraction tests on small fixture files
- MiniSearch query/ranking tests for a few representative queries
- one smoke test for `ts_code_search_search`

No need for heavy integration tests first.

## Risks

- ranking may still need repo-specific tuning
- component detection heuristics may miss edge cases
- MiniSearch ranking may need a light post-pass for code-specific quality
- large repos may need better refresh/invalidation later
- "semantic" expectations may drift toward true natural-language search

## Success criteria

MVP is good enough if:
- for symbol-ish queries, top results beat grep in precision
- the agent can discover relevant TS/TSX code with fewer follow-up searches
- startup and query latency stay reasonable on medium repos
- no extra service/process management is required
- custom search infrastructure stays small because `ts-morph` and MiniSearch do most of the work

## Nice-to-have later

Only add later if MVP proves useful:
- single-file incremental refresh
- file summary entries
- import/export relationship browsing
- `react-docgen-typescript` for richer component prop extraction
- fuzzy reranking only if MiniSearch is not enough
- optional tsserver-backed "go deeper" tools for references
- optional multi-language support once the TS path is solid

## First milestone

Ship only this:
- `ts_code_search_search`
- `ts_code_search_file_outline`
- top-level TS/TSX symbol extraction via `ts-morph`
- tokenization
- MiniSearch-backed ranking
- per-cwd lazy cache

That is the shortest path to something meaningfully better than grep without re-implementing a search engine or AST layer.
