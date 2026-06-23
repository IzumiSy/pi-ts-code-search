# pi-ts-code-search

A **pi extension** for TypeScript/TSX-oriented code search.

It uses `ts-morph` to extract symbols and `MiniSearch` to index them in memory, so pi can find code by **symbol shape** instead of raw text alone.

## What it adds

This extension registers these tools:

- `ts_index_search`
  - Search TS/TSX/JS/JSX symbols by keyword
- `ts_index_file_outline`
  - Return indexed symbols for a single file
- `ts_index_exports`
  - Return exported symbols for one file or the whole project
- `ts_index_importers`
  - Find files that import or re-export a file or symbol
- `ts_index_references`
  - Find lightweight references for a top-level symbol

## Why it exists

Plain `grep` is good for text.
This is for questions like:

- "Find auth token related code"
- "Show login components"
- "Find cache invalidation hooks"
- "List exports in this file"

## How it works

1. If `tsconfig.json` exists, build a `ts-morph` `Project` from it
2. Otherwise, fall back to globbing `*.ts`, `*.tsx`, `*.js`, `*.jsx`
3. Extract top-level declarations plus common members (methods, properties, enum members)
4. Build an in-memory `MiniSearch` index
5. Apply a small post-ranking pass for code-aware relevance

Ignored by default:

- `node_modules`
- `dist`
- `build`
- `coverage`
- `.next`
- `.turbo`
- `*.d.ts`

## Indexed symbol kinds

- function
- class
- interface
- type
- enum
- enum-member
- const
- variable
- component
- hook
- method
- property

Heuristics:

- names like `useThing` are treated as hooks
- PascalCase functions with JSX are treated as components

## Install

Requirements:

- Node.js
- pnpm
- pi

Install dependencies:

```bash
pnpm install
```

## Run

Start pi with the extension enabled, while disabling globally installed extensions to avoid conflicts:

```bash
pnpm dev
```

The package is wired through `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./extension/index.ts"
    ]
  }
}
```

## Tool examples

### Search symbols

```text
ts_index_search query="auth token"
ts_index_search query="session manager" kind="class"
ts_index_search query="login" limit=10
ts_index_search query="cache invalidation" refresh=true
```

### Outline one file

```text
ts_index_file_outline file="src/auth.ts"
ts_index_file_outline file="src/auth.ts" refresh=true
```

### List exports

```text
ts_index_exports file="src/auth.ts"
ts_index_exports query="session"
```

### Find importers

```text
ts_index_importers file="src/auth.ts"
ts_index_importers symbol="AuthProvider"
ts_index_importers file="src/auth.ts" symbol="AuthProvider"
```

### Find references

```text
ts_index_references symbol="getAccessToken" file="src/auth.ts"
ts_index_references symbol="AuthProvider"
```

## Ranking signals

Results are mainly ranked by:

- symbol name
- file path tokens
- JSDoc tokens
- prop-like tokens
- import module tokens
- export/default-export status
- component/hook kind matches

For example, `getAccessToken` is tokenized roughly as `get access token`.

## Current limits

This is intentionally small.
It does **not** try to do:

- full references / implementations lookup
- rename / refactor-grade symbol resolution
- rename / refactor actions
- a background daemon
- file watching
- vector search
- multi-language indexing

The index is cached **per cwd in memory**. Use `refresh=true` when you want a rebuild.

## Development

Current implementation lives mostly in:

- `extension/index.ts`

Dependencies:

- `ts-morph`
- `minisearch`
- `typescript`

Peer dependencies:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

## License

MIT
