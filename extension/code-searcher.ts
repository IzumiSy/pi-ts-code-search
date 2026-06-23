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
    name: "ts_index_search",
    label: "TS Index Search",
    description: "Search indexed TypeScript/TSX symbols by name, path, docs, props, and import context.",
    promptSnippet:
      "Search TypeScript/TSX symbols semantically using an in-memory ts-morph + MiniSearch index.",
    promptGuidelines: [
      "Use ts_index_search for TypeScript/TSX symbol or concept search before raw grep when the user asks about functions, classes, hooks, components, exports, or symbol names.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-ish search query, for example 'auth token' or 'session manager'." }),
      kind: Type.Optional(Type.String({ description: "Optional symbol kind filter." })),
      file: Type.Optional(Type.String({ description: "Optional file path filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return.", minimum: 1, maximum: 50 })),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before searching." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const kind = normalizeKind(params.kind);
      if (params.kind && !kind) {
        throw new Error(`Unsupported kind: ${params.kind}`);
      }

      const store = getStore(ctx.cwd, Boolean(params.refresh));
      const hits = searchEntries(store, {
        query: params.query,
        kind,
        file: params.file,
        limit: normalizeLimit(params.limit, 10),
      });

      return {
        content: [{ type: "text", text: formatSearchResults(params.query, hits) }],
        details: {
          cwd: ctx.cwd,
          builtAt: store.builtAt,
          query: params.query,
          kind,
          file: params.file,
          hits: hits.map(({ entry, score }) => ({ ...entry, score })),
        },
      };
    },
  });

  pi.registerTool({
    name: "ts_index_file_outline",
    label: "TS File Outline",
    description: "Return indexed TypeScript/TSX symbols for one file.",
    promptSnippet: "Return an outline of indexed symbols for one TypeScript/TSX file.",
    promptGuidelines: [
      "Use ts_index_file_outline when the user asks for exports, components, hooks, or top-level symbols in one TypeScript/TSX file.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "File path to outline." }),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before outlining." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = getStore(ctx.cwd, Boolean(params.refresh));
      const entries = outlineEntries(store, ctx.cwd, params.file);

      return {
        content: [{ type: "text", text: formatOutlineResults(params.file, entries) }],
        details: {
          cwd: ctx.cwd,
          builtAt: store.builtAt,
          file: params.file,
          entries,
        },
      };
    },
  });

  pi.registerTool({
    name: "ts_index_exports",
    label: "TS Exports",
    description: "Return indexed exported TypeScript/TSX symbols for a file or the project.",
    promptSnippet: "Return exported TypeScript/TSX symbols from the in-memory index.",
    promptGuidelines: [
      "Use ts_index_exports when the user explicitly asks for exported TypeScript/TSX symbols in a file or across the project.",
    ],
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Optional file path filter." })),
      query: Type.Optional(Type.String({ description: "Optional search query to rank exports." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return.", minimum: 1, maximum: 100 })),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before listing exports." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = getStore(ctx.cwd, Boolean(params.refresh));
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
          query: params.query,
          file: params.file,
          hits: hits.map(({ entry, score }) => ({ ...entry, score })),
        },
      };
    },
  });

  pi.registerTool({
    name: "ts_index_importers",
    label: "TS Importers",
    description: "Return files that import or re-export a TypeScript/TSX file or symbol.",
    promptSnippet: "Find files that import or re-export a TypeScript/TSX file or symbol.",
    promptGuidelines: [
      "Use ts_index_importers when the user asks which files import or re-export a TypeScript/TSX file or symbol.",
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

      const store = getStore(ctx.cwd, Boolean(params.refresh));
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
          file: params.file,
          symbol: params.symbol,
          hits,
        },
      };
    },
  });

  pi.registerTool({
    name: "ts_index_references",
    label: "TS References",
    description: "Return lightweight references for a top-level TypeScript/TSX symbol.",
    promptSnippet: "Find lightweight references for a top-level TypeScript/TSX symbol.",
    promptGuidelines: [
      "Use ts_index_references when the user asks where a top-level TypeScript/TSX symbol is used.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Top-level symbol name to resolve." }),
      file: Type.Optional(Type.String({ description: "Optional declaring file path filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return.", minimum: 1, maximum: 100 })),
      refresh: Type.Optional(Type.Boolean({ description: "Rebuild the index before finding references." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = getStore(ctx.cwd, Boolean(params.refresh));
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
