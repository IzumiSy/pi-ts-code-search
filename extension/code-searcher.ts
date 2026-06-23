import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ignore from "ignore";
import MiniSearch from "minisearch";
import { existsSync, readFileSync } from "node:fs";
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
  "enum-member",
  "const",
  "component",
  "hook",
  "method",
  "property",
  "variable",
  "export",
] as const;
const SEARCH_KIND_SET = new Set<string>(SEARCH_KINDS);
const DEFAULT_IGNORE_RULES = ["node_modules/", "dist/", "build/", "coverage/", ".next/", ".turbo/", "*.d.ts"];

type SearchKind = (typeof SEARCH_KINDS)[number];

interface IndexEntry {
  id: string;
  absFile: string;
  file: string;
  line: number;
  column: number;
  name: string;
  qualifiedName: string;
  kind: SearchKind;
  exported: boolean;
  defaultExport: boolean;
  container?: string;
  containerTokens: string[];
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

interface ImportEdge {
  importerFile: string;
  importerLine: number;
  importerColumn: number;
  importerKind: "import" | "re-export";
  moduleSpecifier: string;
  importedFile?: string;
  importedSymbols: string[];
  preview: string;
}

interface ReferenceHit {
  declarationName: string;
  declarationFile: string;
  declarationKind: SearchKind;
  file: string;
  line: number;
  column: number;
  kind: "call" | "type" | "import" | "export" | "read" | "write";
  preview: string;
}

interface SearchStore {
  cwd: string;
  builtAt: number;
  project: Project;
  entries: IndexEntry[];
  entriesById: Map<string, IndexEntry>;
  importEdges: ImportEdge[];
  search: MiniSearch<SearchDocument>;
}

const storeByCwd = new Map<string, SearchStore>();

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
  const ignoreMatcher = createIgnoreMatcher(cwd);
  const entries = collectEntries(project, cwd, ignoreMatcher);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const importEdges = collectImportEdges(project, cwd, ignoreMatcher);
  const search = new MiniSearch<SearchDocument>({
    fields: ["nameText", "pathText", "jsDocText", "propText", "importText", "text"],
    storeFields: ["id"],
  });

  search.addAll(entries.map(toSearchDocument));

  return {
    cwd,
    builtAt: Date.now(),
    project,
    entries,
    entriesById,
    importEdges,
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

function createIgnoreMatcher(cwd: string) {
  const matcher = ignore().add(DEFAULT_IGNORE_RULES);
  const gitignorePath = path.join(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    matcher.add(readFileSync(gitignorePath, "utf8"));
  }
  return matcher;
}

function collectEntries(project: Project, cwd: string, ignoreMatcher: ReturnType<typeof ignore>): IndexEntry[] {
  const entries: IndexEntry[] = [];

  for (const source of project.getSourceFiles()) {
    if (!shouldIndexSourceFile(cwd, source, ignoreMatcher)) {
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

      for (const method of cls.getMethods()) {
        const methodJsDoc = readJsDoc(method);
        entries.push(
          createEntry({
            cwd,
            source,
            node: method,
            name: method.getName(),
            kind: "method",
            exported: false,
            defaultExport: false,
            container: name,
            importTokens,
            jsDocText: methodJsDoc.text,
            jsDocTokens: methodJsDoc.tokens,
            propTokens: collectFunctionPropTokens(method),
          }),
        );
      }

      for (const property of cls.getProperties()) {
        const propertyJsDoc = readJsDoc(property);
        entries.push(
          createEntry({
            cwd,
            source,
            node: property,
            name: property.getName(),
            kind: "property",
            exported: false,
            defaultExport: false,
            container: name,
            importTokens,
            jsDocText: propertyJsDoc.text,
            jsDocTokens: propertyJsDoc.tokens,
            propTokens: [],
          }),
        );
      }
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

      for (const member of enumDecl.getMembers()) {
        entries.push(
          createEntry({
            cwd,
            source,
            node: member,
            name: member.getName(),
            kind: "enum-member",
            exported: false,
            defaultExport: false,
            container: name,
            importTokens,
            jsDocText: "",
            jsDocTokens: [],
            propTokens: [],
          }),
        );
      }
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

        for (const member of collectObjectMembers(name, declaration)) {
          entries.push(
            createEntry({
              cwd,
              source,
              node: member.node,
              name: member.name,
              kind: member.kind,
              exported: false,
              defaultExport: false,
              container: name,
              importTokens,
              jsDocText: "",
              jsDocTokens: [],
              propTokens: member.propTokens,
            }),
          );
        }
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

function shouldIndexSourceFile(cwd: string, source: SourceFile, ignoreMatcher: ReturnType<typeof ignore>): boolean {
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
  return !ignoreMatcher.ignores(relative);
}

function collectImportEdges(project: Project, cwd: string, ignoreMatcher: ReturnType<typeof ignore>): ImportEdge[] {
  const edges: ImportEdge[] = [];

  for (const source of project.getSourceFiles()) {
    if (!shouldIndexSourceFile(cwd, source, ignoreMatcher)) {
      continue;
    }

    for (const declaration of source.getImportDeclarations()) {
      const edge = createImportEdge(cwd, source, declaration, "import");
      if (edge) {
        edges.push(edge);
      }
    }

    for (const declaration of source.getExportDeclarations()) {
      const edge = createImportEdge(cwd, source, declaration, "re-export");
      if (edge) {
        edges.push(edge);
      }
    }
  }

  return edges.sort(
    (a, b) =>
      a.importerFile.localeCompare(b.importerFile) ||
      a.importerLine - b.importerLine ||
      a.importerColumn - b.importerColumn,
  );
}

function createImportEdge(cwd: string, source: SourceFile, declaration: any, importerKind: ImportEdge["importerKind"]) {
  const moduleSpecifier = declaration.getModuleSpecifierValue?.();
  if (!moduleSpecifier) {
    return undefined;
  }

  const pos = source.getLineAndColumnAtPos(declaration.getStart());
  const importedSource = declaration.getModuleSpecifierSourceFile?.();
  const importedFile = importedSource ? relativeFile(cwd, importedSource.getFilePath()) : undefined;

  return {
    importerFile: relativeFile(cwd, source.getFilePath()),
    importerLine: pos.line,
    importerColumn: pos.column,
    importerKind,
    moduleSpecifier,
    importedFile: importedFile?.startsWith("../") ? undefined : importedFile,
    importedSymbols: collectImportedSymbols(declaration),
    preview: firstLine(declaration.getText()),
  } satisfies ImportEdge;
}

function collectImportedSymbols(declaration: any): string[] {
  const symbols: string[] = [];
  const defaultImport = declaration.getDefaultImport?.();
  if (defaultImport) {
    symbols.push("default", defaultImport.getText());
  }

  const namespaceImport = declaration.getNamespaceImport?.();
  if (namespaceImport) {
    symbols.push("*", namespaceImport.getText());
  }

  for (const specifier of declaration.getNamedImports?.() ?? declaration.getNamedExports?.() ?? []) {
    const name = specifier.getName?.();
    if (name) {
      symbols.push(name);
    }
    const alias = specifier.getAliasNode?.()?.getText?.();
    if (alias) {
      symbols.push(alias);
    }
  }

  if (declaration.isNamespaceExport?.()) {
    symbols.push("*");
  }

  return dedupe(symbols);
}

function collectImportTokens(source: SourceFile): string[] {
  return dedupe(
    [
      ...source.getImportDeclarations().flatMap((declaration) => tokenize(declaration.getModuleSpecifierValue())),
      ...source
        .getExportDeclarations()
        .flatMap((declaration) => tokenize(declaration.getModuleSpecifierValue?.() ?? "")),
    ].flat(),
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

function collectObjectMembers(name: string, declaration: VariableDeclaration) {
  const objectLiteral = getVariableObjectLiteral(declaration);
  if (!objectLiteral) {
    return [];
  }

  return objectLiteral.getProperties().flatMap((member: any) => {
    if (!member.getName) {
      return [];
    }

    const memberName = member.getName();
    if (!memberName) {
      return [];
    }

    if (Node.isMethodDeclaration(member)) {
      return [{ node: member, name: memberName, kind: "method" as const, propTokens: collectFunctionPropTokens(member) }];
    }

    if (Node.isPropertyAssignment(member)) {
      const initializer = member.getInitializer();
      if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return [
          {
            node: member,
            name: memberName,
            kind: "method" as const,
            propTokens: collectFunctionPropTokens(initializer),
          },
        ];
      }

      return [{ node: member, name: memberName, kind: "property" as const, propTokens: [] }];
    }

    if (Node.isShorthandPropertyAssignment(member)) {
      return [{ node: member, name: memberName, kind: "property" as const, propTokens: [] }];
    }

    return [];
  });
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

function getVariableObjectLiteral(declaration: VariableDeclaration) {
  const initializer = declaration.getInitializer();
  if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
    return undefined;
  }
  return initializer;
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
  container?: string;
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
  const containerTokens = tokenize(args.container ?? "");
  const qualifiedName = args.container ? `${args.container}.${args.name}` : args.name;
  const preview = firstLine(args.jsDocText) || `${args.kind} ${qualifiedName}`;
  const text = [
    args.name,
    qualifiedName,
    args.kind,
    nameTokens.join(" "),
    containerTokens.join(" "),
    pathTokens.join(" "),
    args.jsDocTokens.join(" "),
    args.propTokens.join(" "),
    args.importTokens.join(" "),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: `${file}:${pos.line}:${pos.column}:${args.kind}:${qualifiedName}`,
    absFile,
    file,
    line: pos.line,
    column: pos.column,
    name: args.name,
    qualifiedName,
    kind: args.kind,
    exported: args.exported,
    defaultExport: args.defaultExport,
    container: args.container,
    containerTokens,
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
    nameText: [entry.name.toLowerCase(), entry.qualifiedName.toLowerCase(), entry.nameTokens.join(" "), entry.containerTokens.join(" ")]
      .filter(Boolean)
      .join(" "),
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

function importerEntries(
  store: SearchStore,
  cwd: string,
  options: { file?: string; symbol?: string; limit: number },
): ImportEdge[] {
  const symbolTokens = tokenize(options.symbol ?? "");

  return store.importEdges
    .filter((edge) => !options.file || matchesImportedFile(edge, cwd, options.file))
    .filter((edge) => {
      if (symbolTokens.length === 0) {
        return true;
      }

      const importedTokens = new Set(edge.importedSymbols.flatMap((symbol) => tokenize(symbol)));
      return symbolTokens.every((token) => importedTokens.has(token));
    })
    .slice(0, options.limit);
}

function referenceEntries(
  store: SearchStore,
  cwd: string,
  options: { symbol: string; file?: string; limit: number },
): ReferenceHit[] {
  const hits = new Map<string, ReferenceHit>();
  const ignoreMatcher = createIgnoreMatcher(cwd);

  for (const entry of findReferenceTargets(store, cwd, options.symbol, options.file)) {
    const referenceNode = findReferenceNode(store.project, entry);
    if (!referenceNode) {
      continue;
    }

    for (const node of referenceNode.findReferencesAsNodes()) {
      if (node.getSourceFile().getFilePath() === entry.absFile && node.getStart() === referenceNode.getStart()) {
        continue;
      }

      const source = node.getSourceFile();
      if (!shouldIndexSourceFile(cwd, source, ignoreMatcher)) {
        continue;
      }

      const file = relativeFile(cwd, source.getFilePath());
      const pos = source.getLineAndColumnAtPos(node.getStart());
      const key = `${entry.id}:${file}:${pos.line}:${pos.column}`;
      hits.set(key, {
        declarationName: entry.qualifiedName,
        declarationFile: entry.file,
        declarationKind: entry.kind,
        file,
        line: pos.line,
        column: pos.column,
        kind: classifyReferenceKind(node),
        preview: previewNode(node),
      });
    }
  }

  return [...hits.values()]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
    .slice(0, options.limit);
}

function findReferenceTargets(store: SearchStore, cwd: string, symbol: string, file?: string): IndexEntry[] {
  const compactSymbol = compactText(symbol);

  return store.entries.filter((entry) => {
    if (entry.container) {
      return false;
    }
    if (entry.kind === "enum-member" || entry.kind === "method" || entry.kind === "property") {
      return false;
    }
    if (file && !matchesFile(entry, cwd, file)) {
      return false;
    }
    return compactText(entry.name) === compactSymbol || compactText(entry.qualifiedName) === compactSymbol;
  });
}

function findReferenceNode(project: Project, entry: IndexEntry) {
  const source = project.getSourceFile(entry.absFile);
  if (!source) {
    return undefined;
  }

  for (const fn of source.getFunctions()) {
    if ((fn.getName() ?? (fn.isDefaultExport() ? "default" : undefined)) === entry.name) {
      return fn.getNameNode();
    }
  }
  for (const cls of source.getClasses()) {
    if ((cls.getName() ?? (cls.isDefaultExport() ? "default" : undefined)) === entry.name) {
      return cls.getNameNode();
    }
  }
  for (const iface of source.getInterfaces()) {
    if (iface.getName() === entry.name) {
      return iface.getNameNode();
    }
  }
  for (const typeAlias of source.getTypeAliases()) {
    if (typeAlias.getName() === entry.name) {
      return typeAlias.getNameNode();
    }
  }
  for (const enumDecl of source.getEnums()) {
    if (enumDecl.getName() === entry.name) {
      return enumDecl.getNameNode();
    }
  }
  for (const statement of source.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const nameNode = declaration.getNameNode();
      if (Node.isIdentifier(nameNode) && nameNode.getText() === entry.name) {
        return nameNode;
      }
    }
  }

  return undefined;
}

function classifyReferenceKind(node: Node): ReferenceHit["kind"] {
  const parent = node.getParent();
  if (!parent) {
    return "read";
  }

  if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent)) {
    return "import";
  }
  if (Node.isExportSpecifier(parent)) {
    return "export";
  }
  if (Node.isTypeReference(parent) || Node.isExpressionWithTypeArguments(parent) || Node.isHeritageClause(parent)) {
    return "type";
  }
  if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === node) {
    return "call";
  }
  if (Node.isBinaryExpression(parent) && parent.getLeft() === node && parent.getOperatorToken().getText().includes("=")) {
    return "write";
  }
  if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
    return "write";
  }

  return "read";
}

function previewNode(node: Node): string {
  const text = node.getSourceFile().getFullText();
  const start = node.getStartLinePos();
  const end = text.indexOf("\n", start);
  return firstLine(text.slice(start, end === -1 ? text.length : end));
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
    ...entry.containerTokens,
    ...entry.pathTokens,
    ...entry.jsDocTokens,
    ...entry.propTokens,
    ...entry.importTokens,
  ]);
  const queryKind = detectKindFromQuery(queryTokens);
  let score = baseScore;

  if (compactText(entry.name) === compactText(rawQuery) || compactText(entry.qualifiedName) === compactText(rawQuery)) {
    score += 100;
  }
  if (
    queryTokens.length > 0 &&
    queryTokens.every((token) => [...entry.nameTokens, ...entry.containerTokens].includes(token))
  ) {
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
    "enum-member": "enum-member",
    "enum-members": "enum-member",
    component: "component",
    components: "component",
    hook: "hook",
    hooks: "hook",
    method: "method",
    methods: "method",
    property: "property",
    properties: "property",
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
  return matchesRequestedFile(entry.file, cwd, requestedFile);
}

function matchesImportedFile(edge: ImportEdge, cwd: string, requestedFile: string): boolean {
  return edge.importedFile ? matchesRequestedFile(edge.importedFile, cwd, requestedFile) : false;
}

function matchesRequestedFile(actualFile: string, cwd: string, requestedFile: string): boolean {
  const entryFile = actualFile.toLowerCase();
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

function formatImporterResults(file: string | undefined, symbol: string | undefined, hits: ImportEdge[]): string {
  const target = [symbol ? `symbol "${symbol}"` : undefined, file ? `file ${file}` : undefined].filter(Boolean).join(" in ");
  const header = `${hits.length} TS/TSX importers for ${target}:`;

  if (hits.length === 0) {
    return `No TS/TSX importers found for ${target}.`;
  }

  return [header, ...hits.map(formatImportEdge)].join("\n");
}

function formatReferenceResults(symbol: string, file: string | undefined, hits: ReferenceHit[]): string {
  const target = file ? `"${symbol}" in ${file}` : `"${symbol}"`;
  if (hits.length === 0) {
    return `No TS/TSX references found for ${target}.`;
  }

  return [`${hits.length} TS/TSX references for ${target}:`, ...hits.map(formatReferenceHit)].join("\n");
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
  return `${prefix}${entry.qualifiedName} — ${entry.file}:${entry.line} [${flags}]${suffix}`;
}

function formatImportEdge(edge: ImportEdge, index: number): string {
  const prefix = `${index + 1}. `;
  const symbolText = edge.importedSymbols.length > 0 ? ` [${edge.importedSymbols.join(", ")}]` : "";
  const target = edge.importedFile ? ` -> ${edge.importedFile}` : ` -> ${edge.moduleSpecifier}`;
  return `${prefix}${edge.importerFile}:${edge.importerLine} [${edge.importerKind}]${symbolText}${target} — ${edge.preview}`;
}

function formatReferenceHit(hit: ReferenceHit, index: number): string {
  return `${index + 1}. ${hit.file}:${hit.line} [${hit.kind}] <- ${hit.declarationName} @ ${hit.declarationFile} — ${hit.preview}`;
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
