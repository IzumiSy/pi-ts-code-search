# pi-ts-code-search

A **pi extension** for TypeScript/TSX-oriented code search.

It uses `ts-morph` to extract symbols, `MiniSearch` to rank them in memory, and `ignore` for gitignore-style path filtering, so pi can find code by **symbol shape** instead of raw text alone.

## What it adds

This package registers these tools and bundles a `ts-code-search` skill:

- `ts_code_search_search`
  - Search TS/TSX/JS/JSX symbols by keyword
- `ts_code_search_file_outline`
  - Return indexed symbols for a single file
- `ts_code_search_exports`
  - Return exported symbols for one file or the whole project
- `ts_code_search_importers`
  - Find files that import or re-export a file or symbol
- `ts_code_search_references`
  - Find lightweight references for a top-level symbol

It also includes a skill that nudges pi to prefer these tools over `grep`/`rg` for TypeScript and TSX code search.

## Why it exists

Plain `grep` is good for text.
This is for questions like:

- "Find auth token related code"
- "Show login components"
- "Find cache invalidation hooks"
- "List exports in this file"

For implementation details and contributor notes, see [DEVELOPMENT.md](./DEVELOPMENT.md).

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

Install directly from GitHub:

```bash
pi install git:github.com/IzumiSy/pi-ts-code-search
```

## Run

Start pi normally after installation:

```bash
pi
```


## Tool examples

### Search symbols

```text
ts_code_search_search query="auth token"
ts_code_search_search query="session manager" kind="class"
ts_code_search_search query="login" limit=10
ts_code_search_search query="autoLogin" explain=true
ts_code_search_search query="cache invalidation" refresh=true
```

### Outline one file

```text
ts_code_search_file_outline file="src/auth.ts"
ts_code_search_file_outline file="src/auth.ts" refresh=true
```

### List exports

```text
ts_code_search_exports file="src/auth.ts"
ts_code_search_exports query="session"
```

### Find importers

```text
ts_code_search_importers file="src/auth.ts"
ts_code_search_importers symbol="AuthProvider"
ts_code_search_importers file="src/auth.ts" symbol="AuthProvider"
```

### Find references

```text
ts_code_search_references symbol="getAccessToken" file="src/auth.ts"
ts_code_search_references symbol="AuthProvider"
```

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

## License

MIT
