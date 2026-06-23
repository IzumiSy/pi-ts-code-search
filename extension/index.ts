import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import MiniSearch from "minisearch";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  VariableDeclarationKind,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";

const SEARCH_KINDS = [
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "const",
  "component",
  "hook",
  "method",
  "variable",
  "export",
] as const;
const SEARCH_KIND_SET = new Set<string>(SEARCH_KINDS);
const IGNORED_PATH_PARTS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

type SearchKind = (typeof SEARCH_KINDS)[number];

interface IndexEntry {
  id: string;
  absFile: string;
  file: string;
  line: number;
  column: number;
  name: string;
  kind: SearchKind;
  exported: boolean;
  defaultExport: boolean;
  container?: string;
  pathTokens: string[];
  nameTokens: string[];
  jsDocTokens: string[];
  propTokens: string[];
  importTokens: string[];
  text: string;
  preview: string;
}

interface SearchDocument {
  id: string;
  nameText: string;
  pathText: string;
  jsDocText: string;
  propText: string;
  importText: string;
  text: string;
}

interface SearchHit {
  entry: IndexEntry;
  score: number;
}

interface SearchStore {
  cwd: string;
  builtAt: number;
  entries: IndexEntry[];
  entriesById: Map<string, IndexEntry>;
  search: MiniSearch<SearchDocument>;
}

const storeByCwd = new Map<string, SearchStore>();

export default function (pi: ExtensionAPI) {
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

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
      storeByCwd.delete(ctx.cwd);
    }
  });

  pi.on("user_bash", async (_event, ctx) => {
    storeByCwd.delete(ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    storeByCwd.clear();
  });
}

function getStore(cwd: string, refresh = false): SearchStore {
  const cached = storeByCwd.get(cwd);
  if (cached && !refresh) {
    return cached;
  }

  const store = buildStore(cwd);
  storeByCwd.set(cwd, store);
  return store;
}

function buildStore(cwd: string): SearchStore {
  const project = createProject(cwd);
  const entries = collectEntries(project, cwd);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const search = new MiniSearch<SearchDocument>({
    fields: ["nameText", "pathText", "jsDocText", "propText", "importText", "text"],
    storeFields: ["id"],
  });

  search.addAll(entries.map(toSearchDocument));

  return {
    cwd,
    builtAt: Date.now(),
    entries,
    entriesById,
    search,
  };
}

function createProject(cwd: string): Project {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    return new Project({ tsConfigFilePath: tsconfigPath });
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  const root = toPosix(cwd);
  project.addSourceFilesAtPaths([
    `${root}/**/*.ts`,
    `${root}/**/*.tsx`,
    `${root}/**/*.js`,
    `${root}/**/*.jsx`,
    `!${root}/**/*.d.ts`,
    `!${root}/**/node_modules/**`,
    `!${root}/**/dist/**`,
    `!${root}/**/build/**`,
    `!${root}/**/coverage/**`,
    `!${root}/**/.next/**`,
    `!${root}/**/.turbo/**`,
  ]);
  return project;
}

function collectEntries(project: Project, cwd: string): IndexEntry[] {
  const entries: IndexEntry[] = [];

  for (const source of project.getSourceFiles()) {
    if (!shouldIndexSourceFile(cwd, source)) {
      continue;
    }

    const importTokens = collectImportTokens(source);

    for (const fn of source.getFunctions()) {
      const name = fn.getName() ?? (fn.isDefaultExport() ? "default" : undefined);
      if (!name) {
        continue;
      }

      const jsDoc = readJsDoc(fn);
      const propTokens = collectFunctionPropTokens(fn);
      entries.push(
        createEntry({
          cwd,
          source,
          node: fn,
          name,
          kind: classifyFunction(name, fn),
          exported: fn.isExported(),
          defaultExport: fn.isDefaultExport(),
          importTokens,
          jsDocText: jsDoc.text,
          jsDocTokens: jsDoc.tokens,
          propTokens,
        }),
      );
    }

    for (const cls of source.getClasses()) {
      const name = cls.getName() ?? (cls.isDefaultExport() ? "default" : undefined);
      if (!name) {
        continue;
      }

      const jsDoc = readJsDoc(cls);
      entries.push(
        createEntry({
          cwd,
          source,
          node: cls,
          name,
          kind: "class",
          exported: cls.isExported(),
          defaultExport: cls.isDefaultExport(),
          importTokens,
          jsDocText: jsDoc.text,
          jsDocTokens: jsDoc.tokens,
          propTokens: [],
        }),
      );
    }

    for (const iface of source.getInterfaces()) {
      const name = iface.getName();
      const jsDoc = readJsDoc(iface);
      entries.push(
        createEntry({
          cwd,
          source,
          node: iface,
          name,
          kind: "interface",
          exported: iface.isExported(),
          defaultExport: iface.isDefaultExport(),
          importTokens,
          jsDocText: jsDoc.text,
          jsDocTokens: jsDoc.tokens,
          propTokens: [],
        }),
      );
    }

    for (const typeAlias of source.getTypeAliases()) {
      const name = typeAlias.getName();
      const jsDoc = readJsDoc(typeAlias);
      entries.push(
        createEntry({
          cwd,
          source,
          node: typeAlias,
          name,
          kind: "type",
          exported: typeAlias.isExported(),
          defaultExport: typeAlias.isDefaultExport(),
          importTokens,
          jsDocText: jsDoc.text,
          jsDocTokens: jsDoc.tokens,
          propTokens: [],
        }),
      );
    }

    for (const enumDecl of source.getEnums()) {
      const name = enumDecl.getName();
      const jsDoc = readJsDoc(enumDecl);
      entries.push(
        createEntry({
          cwd,
          source,
          node: enumDecl,
          name,
          kind: "enum",
          exported: enumDecl.isExported(),
          defaultExport: enumDecl.isDefaultExport(),
          importTokens,
          jsDocText: jsDoc.text,
          jsDocTokens: jsDoc.tokens,
          propTokens: [],
        }),
      );
    }

    for (const statement of source.getVariableStatements()) {
      const jsDoc = readJsDoc(statement);
      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        if (!Node.isIdentifier(nameNode)) {
          continue;
        }

        const name = nameNode.getText();
        const propTokens = collectVariablePropTokens(declaration);
        entries.push(
          createEntry({
            cwd,
            source,
            node: declaration,
            name,
            kind: classifyVariable(name, declaration, statement.getDeclarationKind()),
            exported: statement.isExported(),
            defaultExport: statement.isDefaultExport(),
            importTokens,
            jsDocText: jsDoc.text,
            jsDocTokens: jsDoc.tokens,
            propTokens,
          }),
        );
      }
    }
  }

  return entries.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return a.column - b.column;
  });
}

function shouldIndexSourceFile(cwd: string, source: SourceFile): boolean {
  const absFile = source.getFilePath();
  if (absFile.endsWith(".d.ts")) {
    return false;
  }

  const relative = relativeFile(cwd, absFile);
  if (relative.startsWith("../")) {
    return false;
  }
  if (!/\.(ts|tsx|js|jsx)$/i.test(relative)) {
    return false;
  }
  return !relative.split("/").some((part) => IGNORED_PATH_PARTS.has(part));
}

function collectImportTokens(source: SourceFile): string[] {
  return dedupe(
    source
      .getImportDeclarations()
      .flatMap((declaration) => tokenize(declaration.getModuleSpecifierValue())),
  );
}

function classifyFunction(name: string, fn: Node): SearchKind {
  if (isHookName(name)) {
    return "hook";
  }
  if (looksLikeComponent(name, fn)) {
    return "component";
  }
  return "function";
}

function classifyVariable(
  name: string,
  declaration: VariableDeclaration,
  declarationKind: VariableDeclarationKind,
): SearchKind {
  if (isHookName(name)) {
    return "hook";
  }

  const fn = getVariableFunctionLike(declaration);
  if (fn && looksLikeComponent(name, fn)) {
    return "component";
  }

  return declarationKind === VariableDeclarationKind.Const ? "const" : "variable";
}

function collectFunctionPropTokens(fn: any): string[] {
  const firstParam = fn.getParameters?.()[0];
  if (!firstParam) {
    return [];
  }
  return collectParameterTokens(firstParam);
}

function collectVariablePropTokens(declaration: VariableDeclaration): string[] {
  const fn = getVariableFunctionLike(declaration);
  if (!fn) {
    return [];
  }
  return collectFunctionPropTokens(fn);
}

function collectParameterTokens(param: any): string[] {
  const tokens: string[] = [];
  const nameNode = param.getNameNode?.();
  if (nameNode && Node.isObjectBindingPattern(nameNode)) {
    for (const element of nameNode.getElements()) {
      tokens.push(...tokenize(element.getName()));
    }
  }

  const typeNode = param.getTypeNode?.();
  if (typeNode && Node.isTypeLiteral(typeNode)) {
    for (const member of typeNode.getMembers()) {
      if (Node.isPropertySignature(member)) {
        tokens.push(...tokenize(member.getName()));
      }
    }
  } else if (typeNode) {
    tokens.push(...tokenize(typeNode.getText()));
  }

  return dedupe(tokens);
}

function getVariableFunctionLike(declaration: VariableDeclaration) {
  const initializer = declaration.getInitializer();
  if (!initializer) {
    return undefined;
  }
  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    return initializer;
  }
  return undefined;
}

function looksLikeComponent(name: string, node: Node): boolean {
  if (!isPascalCase(name)) {
    return false;
  }
  if (containsJsx(node)) {
    return true;
  }

  const parameters = (node as any).getParameters?.() ?? [];
  return parameters.some((param: any) => {
    const typeText = param.getTypeNode?.()?.getText?.() ?? "";
    return /Props\b/.test(typeText) || /props/i.test(param.getName?.() ?? "");
  });
}

function containsJsx(node: Node): boolean {
  return (
    node.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 ||
    node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 ||
    node.getDescendantsOfKind(SyntaxKind.JsxFragment).length > 0
  );
}

function isHookName(name: string): boolean {
  return /^use[A-Z0-9_]/.test(name);
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function readJsDoc(node: any): { text: string; tokens: string[] } {
  const text = (node.getJsDocs?.() ?? [])
    .map((doc: any) => doc.getInnerText().trim())
    .filter(Boolean)
    .join("\n");

  return { text, tokens: tokenize(text) };
}

function createEntry(args: {
  cwd: string;
  source: SourceFile;
  node: any;
  name: string;
  kind: SearchKind;
  exported: boolean;
  defaultExport: boolean;
  importTokens: string[];
  jsDocText: string;
  jsDocTokens: string[];
  propTokens: string[];
}): IndexEntry {
  const positionNode = args.node.getNameNode?.() ?? args.node;
  const pos = args.source.getLineAndColumnAtPos(positionNode.getStart());
  const absFile = args.source.getFilePath();
  const file = relativeFile(args.cwd, absFile);
  const pathTokens = tokenize(file);
  const nameTokens = tokenize(args.name);
  const preview = firstLine(args.jsDocText) || `${args.kind} ${args.name}`;
  const text = [
    args.name,
    args.kind,
    nameTokens.join(" "),
    pathTokens.join(" "),
    args.jsDocTokens.join(" "),
    args.propTokens.join(" "),
    args.importTokens.join(" "),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: `${file}:${pos.line}:${pos.column}:${args.kind}:${args.name}`,
    absFile,
    file,
    line: pos.line,
    column: pos.column,
    name: args.name,
    kind: args.kind,
    exported: args.exported,
    defaultExport: args.defaultExport,
    pathTokens,
    nameTokens,
    jsDocTokens: args.jsDocTokens,
    propTokens: args.propTokens,
    importTokens: args.importTokens,
    text,
    preview,
  };
}

function toSearchDocument(entry: IndexEntry): SearchDocument {
  return {
    id: entry.id,
    nameText: [entry.name.toLowerCase(), entry.nameTokens.join(" ")].filter(Boolean).join(" "),
    pathText: entry.pathTokens.join(" "),
    jsDocText: entry.jsDocTokens.join(" "),
    propText: entry.propTokens.join(" "),
    importText: entry.importTokens.join(" "),
    text: entry.text,
  };
}

function searchEntries(
  store: SearchStore,
  options: { query: string; kind?: SearchKind; file?: string; limit: number },
): SearchHit[] {
  const normalizedQuery = normalizeQuery(options.query);
  if (!normalizedQuery) {
    return [];
  }

  const queryTokens = tokenize(options.query);
  const results = store.search.search(normalizedQuery, {
    prefix: true,
    boost: {
      nameText: 5,
      pathText: 2,
      jsDocText: 1.5,
      propText: 1.5,
      importText: 1,
      text: 1,
    },
  });

  return results
    .map((result) => {
      const entry = store.entriesById.get(String(result.id));
      if (!entry) {
        return undefined;
      }
      if (options.kind && entry.kind !== options.kind) {
        return undefined;
      }
      if (options.file && !matchesFile(entry, store.cwd, options.file)) {
        return undefined;
      }

      return {
        entry,
        score: rankEntry(entry, result.score, options.query, queryTokens, options.kind),
      };
    })
    .filter((hit): hit is SearchHit => Boolean(hit))
    .sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file) || a.entry.line - b.entry.line)
    .slice(0, options.limit);
}

function exportEntries(
  store: SearchStore,
  cwd: string,
  options: { file?: string; query?: string; limit: number },
): SearchHit[] {
  if (options.query) {
    return searchEntries(store, { query: options.query, file: options.file, limit: options.limit }).filter(
      ({ entry }) => entry.exported,
    );
  }

  return store.entries
    .filter((entry) => entry.exported)
    .filter((entry) => !options.file || matchesFile(entry, cwd, options.file))
    .sort((a, b) => {
      if (a.file !== b.file) {
        return a.file.localeCompare(b.file);
      }
      if (a.defaultExport !== b.defaultExport) {
        return a.defaultExport ? -1 : 1;
      }
      return a.line - b.line;
    })
    .slice(0, options.limit)
    .map((entry, index) => ({ entry, score: options.limit - index }));
}

function outlineEntries(store: SearchStore, cwd: string, file: string): IndexEntry[] {
  return store.entries
    .filter((entry) => matchesFile(entry, cwd, file))
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

function rankEntry(
  entry: IndexEntry,
  baseScore: number,
  rawQuery: string,
  queryTokens: string[],
  desiredKind?: SearchKind,
): number {
  const entryTokens = new Set([
    ...entry.nameTokens,
    ...entry.pathTokens,
    ...entry.jsDocTokens,
    ...entry.propTokens,
    ...entry.importTokens,
  ]);
  const queryKind = detectKindFromQuery(queryTokens);
  let score = baseScore;

  if (compactText(entry.name) === compactText(rawQuery)) {
    score += 100;
  }
  if (queryTokens.length > 0 && queryTokens.every((token) => entry.nameTokens.includes(token))) {
    score += 30;
  }

  score += queryTokens.filter((token) => entryTokens.has(token)).length * 4;
  if (entry.exported) {
    score += 8;
  }
  if (entry.defaultExport) {
    score += 6;
  }
  if (desiredKind && entry.kind === desiredKind) {
    score += 8;
  }
  if (queryKind && entry.kind === queryKind) {
    score += 8;
  }
  if (queryTokens.includes("component") && entry.kind === "component") {
    score += 8;
  }
  if (queryTokens.includes("hook") && entry.kind === "hook") {
    score += 8;
  }

  return score;
}

function detectKindFromQuery(tokens: string[]): SearchKind | undefined {
  const aliasMap: Record<string, SearchKind> = {
    function: "function",
    functions: "function",
    class: "class",
    classes: "class",
    interface: "interface",
    interfaces: "interface",
    type: "type",
    types: "type",
    enum: "enum",
    enums: "enum",
    component: "component",
    components: "component",
    hook: "hook",
    hooks: "hook",
    const: "const",
    variable: "variable",
    variables: "variable",
    export: "export",
    exports: "export",
  };

  for (const token of tokens) {
    const kind = aliasMap[token];
    if (kind) {
      return kind;
    }
  }

  return undefined;
}

function normalizeKind(kind?: string): SearchKind | undefined {
  if (!kind) {
    return undefined;
  }
  const normalized = kind.trim().toLowerCase();
  return SEARCH_KIND_SET.has(normalized) ? (normalized as SearchKind) : undefined;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), 100));
}

function normalizeQuery(query: string): string {
  return tokenize(query).join(" ");
}

function matchesFile(entry: IndexEntry, cwd: string, requestedFile: string): boolean {
  const entryFile = entry.file.toLowerCase();
  const raw = toPosix(requestedFile).toLowerCase().replace(/^\.\//, "");
  const resolved = toPosix(path.relative(cwd, path.resolve(cwd, requestedFile))).toLowerCase();

  return (
    entryFile === raw ||
    entryFile === resolved ||
    entryFile.endsWith(`/${raw}`) ||
    entryFile.endsWith(`/${resolved}`)
  );
}

function formatSearchResults(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `No TS/TSX symbol matches for "${query}".`;
  }

  return [`${hits.length} TS/TSX symbol matches for "${query}":`, ...hits.map(formatHit)].join("\n");
}

function formatOutlineResults(file: string, entries: IndexEntry[]): string {
  if (entries.length === 0) {
    return `No indexed TS/TSX symbols found for ${file}.`;
  }

  return [`${entries.length} indexed symbols in ${file}:`, ...entries.map((entry) => formatEntryLine(entry))].join("\n");
}

function formatExportResults(query: string | undefined, file: string | undefined, hits: SearchHit[]): string {
  const target = file ? ` in ${file}` : "";
  const header = query
    ? `${hits.length} exported TS/TSX symbols for "${query}"${target}:`
    : `${hits.length} exported TS/TSX symbols${target}:`;

  if (hits.length === 0) {
    return query
      ? `No exported TS/TSX symbols matched "${query}"${target}.`
      : `No exported TS/TSX symbols found${target}.`;
  }

  return [header, ...hits.map(formatHit)].join("\n");
}

function formatHit(hit: SearchHit, index: number): string {
  return formatEntryLine(hit.entry, index + 1);
}

function formatEntryLine(entry: IndexEntry, index?: number): string {
  const flags = [entry.kind, entry.exported ? "export" : undefined, entry.defaultExport ? "default" : undefined]
    .filter(Boolean)
    .join(", ");
  const prefix = typeof index === "number" ? `${index}. ` : "- ";
  const suffix = entry.preview ? ` — ${entry.preview}` : "";
  return `${prefix}${entry.name} — ${entry.file}:${entry.line} [${flags}]${suffix}`;
}

function tokenize(value: string): string[] {
  if (!value) {
    return [];
  }

  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._\-/]+/g, " ")
    .toLowerCase();

  return dedupe(spaced.split(/[^a-z0-9]+/).filter(Boolean));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function relativeFile(cwd: string, file: string): string {
  return toPosix(path.relative(cwd, file));
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function firstLine(value: string): string {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}
