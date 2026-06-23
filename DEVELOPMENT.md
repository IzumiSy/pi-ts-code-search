# Development

## Local setup

Install dependencies:

```bash
pnpm install
```

Run pi with this extension enabled and global extensions disabled:

```bash
pnpm dev
```

Run tests:

```bash
pnpm test
```

## Package wiring

The extension is loaded through `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./extension/index.ts"
    ]
  }
}
```

## Implementation overview

1. If `tsconfig.json` exists, build a `ts-morph` `Project` from it.
2. Otherwise, fall back to globbing `*.ts`, `*.tsx`, `*.js`, `*.jsx`.
3. Extract top-level declarations plus common members such as methods, properties, and enum members.
4. Build an in-memory `MiniSearch` index.
5. Apply a small post-ranking pass for code-aware relevance.

Path filtering uses `ignore` with these built-in defaults:

- `node_modules/`
- `dist/`
- `build/`
- `coverage/`
- `.next/`
- `.turbo/`
- `*.d.ts`

It also loads patterns from the repo `.gitignore`.

## Ranking signals

Search results are mainly ranked by:

- symbol name
- file path tokens
- JSDoc tokens
- prop-like tokens
- import module tokens
- export/default-export status
- component/hook kind matches

For example, `getAccessToken` is tokenized roughly as `get access token`.

## Code layout

- `extension/index.ts` — extension entrypoint
- `extension/code-searcher.ts` — tool registration, indexing, ranking, importers, references
- `tests/code-searcher.test.ts` — cache invalidation and tool behavior tests

## Dependencies

Runtime dependencies:

- `ts-morph`
- `minisearch`
- `ignore`
- `typescript`

Peer dependencies:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

## Notes

- The index is cached per cwd in memory.
- Use `refresh=true` when you want a rebuild.
- This is intentionally lightweight, not a rename/refactor-grade engine.
