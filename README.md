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
ts_code_search_search query="autoLogin" explain=true timing=true
ts_code_search_search query="cache invalidation" refresh=true
```

Identifier-like queries such as `autoLogin`, `AuthProvider`, or `foo_bar` are treated a bit more strictly than natural-language queries:

- camelCase / PascalCase / separator-based names are tokenized before search
- strict identifier-style search prefers matches that contain **all** identifier tokens
- if strict matching finds nothing, search falls back to a broader query automatically

This helps queries like `autoLogin` prefer `useAutoLogin` over noisy partial matches such as unrelated `Auto*` or `Autocomplete*` symbols.

### Explain score breakdowns

Use `explain=true` when you want to understand why a result ranked where it did:

```text
ts_code_search_search query="autoLogin" explain=true
```

When enabled, the tool includes per-hit score details in both:

- text output
- `details.hits[].scoreBreakdown`

Typical score contributions include:

- `MiniSearch base`
- `exact identifier match`
- `all query tokens in name/container`
- `identifier suffix match`
- `matched query tokens`
- `exported`
- `requested kind match`

Example:

```text
1. useAutoLogin — src/auth.ts:2 [function, export] — function useAutoLogin
   score 71.40 = MiniSearch base +5.40; all query tokens in name/container +30; identifier suffix match +20 (useAutoLogin); matched query tokens +8 (auto, login); exported +8
```

`explain=true` only affects score explanations. It does **not** print timing information by itself.

### Show timing information

Use `timing=true` to append one timing line to the end of the text output.
This works for all `ts_code_search_*` tools.

```text
ts_code_search_search query="autoLogin" timing=true
ts_code_search_search query="autoLogin" explain=true timing=true
ts_code_search_file_outline file="src/auth.ts" timing=true
ts_code_search_exports query="session" timing=true
ts_code_search_importers symbol="AuthProvider" timing=true
ts_code_search_references symbol="getAccessToken" file="src/auth.ts" timing=true
```

The timing line looks like this on a rebuild:

```text
timing total=967.26ms createProject=785.73ms collectIndexData=177.11ms entries=4.51ms importEdges=163.7ms addSearchDocuments=2.8ms
```

When the cached index is reused instead of rebuilt, the tool prints:

```text
timing cache hit — reused existing index
```

The same build data is also available in `details.timings`, and cache reuse is reflected in `details.cacheHit`.

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
