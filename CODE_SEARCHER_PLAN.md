# Code Searcher Plan

## Goal

Provide a TypeScript/TSX-focused **semantic code search** extension for pi so the agent can search code at the **symbol/index level** instead of relying only on `rg`/`grep` text matches.

This is **not** an LSP tool and **not** a vector database. The first version should be a fast, read-only **Compiler API-based code index** with simple ranking.

## Non-goals for MVP

- No diagnostics
- No rename/refactor actions
- No references/implementations resolution
- No background daemon
- No file watcher
- No embeddings/vector DB
- No new external search dependency unless ranking proves weak

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

Build a repo-local in-memory index of TS/TSX symbols using the TypeScript Compiler API, then expose a small toolset that queries that index.

## Architecture

### 1. Index builder

Use the TypeScript Compiler API to scan source files and emit searchable entries.

Inputs:
- `tsconfig.json` when present
- fallback source-file discovery when needed
- TS/TSX/JS/JSX files only

Excluded by default:
- `node_modules`
- `dist`
- `build`
- `coverage`
- `.next`
- `.turbo`
- generated declaration files

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

### 3. Ranking

Start with hand-written scoring, not Fuse.js.

Scoring signals:
- exact symbol name match
- normalized token match (`getAccessToken` -> `get access token`)
- file path token match
- exported boost
- component/hook/kind match boost
- JSDoc token match
- prop name match for TSX components

This should behave like **semantic grep**, not true semantic/vector search.

### 4. Query tools

Minimal first set:

#### `ts_index_search`
Search the symbol index by natural-ish keyword query.

Example inputs:
- `{ "query": "auth token" }`
- `{ "query": "session manager", "kind": "class" }`
- `{ "query": "login", "limit": 10 }`

Returns ranked symbol hits with file, line, kind, exported flag, and a small preview.

#### `ts_index_file_outline`
Return indexed symbols for one file.

Example:
- `{ "file": "src/auth.ts" }`

#### `ts_index_exports`
Return export-oriented entries for a file or the whole project.

Example:
- `{ "file": "src/auth.ts" }`
- `{ "query": "session" }`

Optional if still cheap:

#### `ts_index_related`
Given a file + symbol name, return nearby/index-neighbor entries from the same file/container.

## Implementation plan

### Phase 1: Basic index

- Load project config
- Discover candidate source files
- Parse files with Compiler API
- Extract top-level symbols:
  - functions
  - classes
  - interfaces
  - type aliases
  - enums
  - exported const/let/var
- Tokenize names and paths
- Build in-memory array + simple inverted token map

Exit condition:
- `ts_index_search` returns useful ranked results for common symbol-name queries

### Phase 2: TSX-aware entries

- Detect React components
n- Detect hooks (`useX`)
- Extract prop names/types where practical
- Add component/hook boosts in ranking

Exit condition:
- searching for component or hook concepts beats plain grep in UI-heavy repos

### Phase 3: Search quality

- Add JSDoc/leading-comment tokens
- Add import-module tokens
- Add kind filters
- Improve scoring weights
- Add small snippets/previews

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
- expose a cheap `refresh` flag or helper command/tool

Later:
- refresh single file after known edits
- invalidate cached entries for changed files only

## Suggested project structure

```text
extensions/code-searcher/
  index.ts
  src/
    config.ts
    discover.ts
    indexer.ts
    extract.ts
    tokenize.ts
    rank.ts
    store.ts
    tools.ts
    format.ts
```

## Extraction rules

Start boring.

Extract:
- exported declarations first
- then notable non-exported top-level declarations
- optionally class methods

Detect components heuristically:
- PascalCase function returning JSX
- `const X = () => <...>`
- function/arrow typed with React-ish props

Detect hooks heuristically:
- symbol name starts with `use`

Skip for MVP:
- full semantic type resolution
- cross-file symbol graph
- exact references

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

## Ranking outline

Pseudo-scoring:

```ts
score = 0
+ exactNameMatch * 100
+ fullTokenMatch * 30
+ partialTokenMatch * 10
+ exported * 8
+ kindMatch * 8
+ filePathMatch * 5
+ jsDocMatch * 3
+ propMatch * 3
```

Keep weights plain constants in one file for easy tuning.

## Why not Fuse.js first

Fuse.js helps typo/fuzzy matching, but the hard part here is the **code-aware index**, not fuzziness.

Plan:
1. build structured index
2. use hand-written scoring
3. only add Fuse.js later as a reranker if misspellings or fuzzy recall are a real issue

## pi integration

Extension behavior:
- lazy init on first tool call
- one in-memory index per `cwd`
- no long-lived background process
- no factory-time heavy work
- session shutdown can simply clear caches

Tool guidance should tell the agent:
- use `ts_index_search` for semantic TS/TSX search
- use `read` for exact file inspection
- use `rg`/`grep` only for raw text/path search

## Testing

Keep tests small.

Need:
- tokenizer tests
- symbol extraction tests on small fixture files
- ranking tests for a few representative queries
- one smoke test for `ts_index_search`

No need for heavy integration tests first.

## Risks

- ranking may feel weak at first
- component detection heuristics may miss edge cases
- large repos may need better file discovery/invalidation
- "semantic" expectations may drift toward true natural-language search

## Success criteria

MVP is good enough if:
- for symbol-ish queries, top results beat grep in precision
- the agent can discover relevant TS/TSX code with fewer follow-up searches
- startup and query latency stay reasonable on medium repos
- no extra service/process management is required

## Nice-to-have later

Only add later if MVP proves useful:
- Fuse.js reranking
- single-file incremental refresh
- file summary entries
- import/export relationship browsing
- optional embeddings for natural-language-heavy queries
- optional tsserver-backed "go deeper" tools for references

## First milestone

Ship only this:
- `ts_index_search`
- top-level TS/TSX symbol extraction
- tokenization + simple ranking
- per-cwd lazy cache

That is the shortest path to something meaningfully better than grep.
