import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  exportEntries,
  formatExportResults,
  formatImporterResults,
  formatOutlineResults,
  formatReferenceResults,
  formatSearchResults,
  importerEntries,
  outlineEntries,
  referenceEntries,
  searchEntries,
} from "./search-ops.ts";
import { clearStores, getStore, invalidateStore } from "./search-store.ts";
import { normalizeKind, normalizeLimit } from "./search-shared.ts";

export default function registerCodeSearcher(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ts_code_search_search",
    label: "TS Index Search",
    description: "Search indexed TypeScript/TSX symbols by name, path, docs, props, and import context. Prefer this over grep/rg for TypeScript/TSX symbol and concept search.",
    promptSnippet:
      "Search TypeScript/TSX symbols semantically using an in-memory ts-morph + MiniSearch index.",
    promptGuidelines: [
      "Use ts_code_search_search first for TypeScript/TSX symbol or concept search before grep/rg when the user asks about functions, classes, hooks, components, exports, or symbol names.",
      "Fall back to grep/rg only for exact string search, non-TS files, or when the indexed tools clearly do not cover the task.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-ish search query, for example 'auth token' or 'session manager'." }),
      kind: Type.Optional(Type.String({ description: "Optional symbol kind filter." })),
      file: Type.Optional(Type.String({ description: "Optional file path filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return.", minimum: 1, maximum: 50 })),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before searching." })),
      explain: Type.Optional(Type.Boolean({ description: "Include score breakdown details for each hit." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const kind = normalizeKind(params.kind);
      if (params.kind && !kind) {
        throw new Error(`Unsupported kind: ${params.kind}`);
      }

      const { store, cacheHit } = getStore(ctx.cwd, Boolean(params.refresh));
      const hits = searchEntries(store, {
        query: params.query,
        kind,
        file: params.file,
        limit: normalizeLimit(params.limit, 10),
        explain: Boolean(params.explain),
      });

      return {
        content: [{ type: "text", text: formatSearchResults(params.query, hits, Boolean(params.explain)) }],
        details: {
          cwd: ctx.cwd,
          builtAt: store.builtAt,
          cacheHit,
          timings: store.timings,
          query: params.query,
          kind,
          file: params.file,
          explain: Boolean(params.explain),
          hits: hits.map(({ entry, score, scoreBreakdown }) => ({ ...entry, score, scoreBreakdown })),
        },
      };
    },
  });

  pi.registerTool({
    name: "ts_code_search_file_outline",
    label: "TS File Outline",
    description: "Return indexed TypeScript/TSX symbols for one file. Prefer this over grep/rg when the user wants a file-level symbol outline.",
    promptSnippet: "Return an outline of indexed symbols for one TypeScript/TSX file.",
    promptGuidelines: [
      "Use ts_code_search_file_outline before grep/rg when the user asks for exports, components, hooks, or top-level symbols in one TypeScript/TSX file.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "File path to outline." }),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before outlining." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { store, cacheHit } = getStore(ctx.cwd, Boolean(params.refresh));
      const entries = outlineEntries(store, ctx.cwd, params.file);

      return {
        content: [{ type: "text", text: formatOutlineResults(params.file, entries) }],
        details: {
          cwd: ctx.cwd,
          builtAt: store.builtAt,
          cacheHit,
          timings: store.timings,
          file: params.file,
          entries,
        },
      };
    },
  });

  pi.registerTool({
    name: "ts_code_search_exports",
    label: "TS Exports",
    description: "Return indexed exported TypeScript/TSX symbols for a file or the project. Prefer this over grep/rg for export discovery in TypeScript/TSX.",
    promptSnippet: "Return exported TypeScript/TSX symbols from the in-memory index.",
    promptGuidelines: [
      "Use ts_code_search_exports before grep/rg when the user explicitly asks for exported TypeScript/TSX symbols in a file or across the project.",
    ],
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Optional file path filter." })),
      query: Type.Optional(Type.String({ description: "Optional search query to rank exports." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return.", minimum: 1, maximum: 100 })),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before listing exports." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { store, cacheHit } = getStore(ctx.cwd, Boolean(params.refresh));
      const limit = normalizeLimit(params.limit, 50);
      const hits = exportEntries(store, ctx.cwd, {
        file: params.file,
        query: params.query,
        limit,
      });

      return {
        content: [{ type: "text", text: formatExportResults(params.query, params.file, hits) }],
        details: {
          cwd: ctx.cwd,
          builtAt: store.builtAt,
          cacheHit,
          timings: store.timings,
          query: params.query,
          file: params.file,
          hits: hits.map(({ entry, score }) => ({ ...entry, score })),
        },
      };
    },
  });

  pi.registerTool({
    name: "ts_code_search_importers",
    label: "TS Importers",
    description: "Return files that import or re-export a TypeScript/TSX file or symbol. Prefer this over grep/rg for importer discovery.",
    promptSnippet: "Find files that import or re-export a TypeScript/TSX file or symbol.",
    promptGuidelines: [
      "Use ts_code_search_importers before grep/rg when the user asks which files import or re-export a TypeScript/TSX file or symbol.",
    ],
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Optional file path filter for the imported module." })),
      symbol: Type.Optional(Type.String({ description: "Optional imported symbol name filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return.", minimum: 1, maximum: 100 })),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before listing importers." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.file && !params.symbol) {
        throw new Error("Provide file or symbol.");
      }

      const { store, cacheHit } = getStore(ctx.cwd, Boolean(params.refresh));
      const hits = importerEntries(store, ctx.cwd, {
        file: params.file,
        symbol: params.symbol,
        limit: normalizeLimit(params.limit, 50),
      });

      return {
        content: [{ type: "text", text: formatImporterResults(params.file, params.symbol, hits) }],
        details: {
          cwd: ctx.cwd,
          builtAt: store.builtAt,
          cacheHit,
          timings: store.timings,
          file: params.file,
          symbol: params.symbol,
          hits,
        },
      };
    },
  });

  pi.registerTool({
    name: "ts_code_search_references",
    label: "TS References",
    description: "Return lightweight references for a top-level TypeScript/TSX symbol. Prefer this over grep/rg for symbol usage lookup in TypeScript/TSX.",
    promptSnippet: "Find lightweight references for a top-level TypeScript/TSX symbol.",
    promptGuidelines: [
      "Use ts_code_search_references before grep/rg when the user asks where a top-level TypeScript/TSX symbol is used.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Top-level symbol name to resolve." }),
      file: Type.Optional(Type.String({ description: "Optional declaring file path filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return.", minimum: 1, maximum: 100 })),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before finding references." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { store, cacheHit } = getStore(ctx.cwd, Boolean(params.refresh));
      const hits = referenceEntries(store, ctx.cwd, {
        symbol: params.symbol,
        file: params.file,
        limit: normalizeLimit(params.limit, 50),
      });

      return {
        content: [{ type: "text", text: formatReferenceResults(params.symbol, params.file, hits) }],
        details: {
          cwd: ctx.cwd,
          builtAt: store.builtAt,
          cacheHit,
          timings: store.timings,
          symbol: params.symbol,
          file: params.file,
          hits,
        },
      };
    },
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
      invalidateStore(ctx.cwd);
    }
  });

  pi.on("user_bash", async (_event, ctx) => {
    invalidateStore(ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    clearStores();
  });
}
