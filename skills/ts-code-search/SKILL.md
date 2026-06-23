---
name: ts-code-search
description: Search large TypeScript and TSX codebases with the bundled ts_code_search_* tools. Use this before grep or rg when you need symbols, exports, file outlines, importers, or references.
---

# TS Code Search

Use the indexed tools first for TypeScript and TSX code search.

## Preferred tool order

1. `ts_code_search_search`
   - General symbol and concept search
2. `ts_code_search_file_outline`
   - One file's symbols
3. `ts_code_search_exports`
   - Export discovery
4. `ts_code_search_importers`
   - Which files import or re-export something
5. `ts_code_search_references`
   - Where a top-level symbol is used

## Use grep or rg only when

- you need exact raw string matches
- the target is outside TS/TSX/JS/JSX
- you are searching logs, JSON, YAML, SQL, env keys, or generated text
- the indexed tools clearly do not cover the task

## Examples

- Find auth-related symbols:
  - `ts_code_search_search query="auth token"`
- Show one file's shape:
  - `ts_code_search_file_outline file="src/auth.ts"`
- List exports:
  - `ts_code_search_exports file="src/auth.ts"`
- Find importers:
  - `ts_code_search_importers file="src/auth.ts" symbol="AuthProvider"`
- Find references:
  - `ts_code_search_references symbol="getAccessToken" file="src/auth.ts"`
