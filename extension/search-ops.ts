import path from "node:path";
import { Node, type Project } from "ts-morph";
import { createIgnoreMatcher, shouldIndexSourceFile } from "./search-store.ts";
import {
  compactText,
  firstLine,
  normalizeQuery,
  relativeFile,
  toPosix,
  tokenize,
  type ImportEdge,
  type IndexEntry,
  type ReferenceHit,
  type SearchHit,
  type SearchKind,
  type SearchScoreContribution,
  type SearchStore,
} from "./search-shared.ts";

export function searchEntries(
  store: SearchStore,
  options: { query: string; kind?: SearchKind; file?: string; limit: number; explain?: boolean },
): SearchHit[] {
  const normalizedQuery = normalizeQuery(options.query);
  if (!normalizedQuery) {
    return [];
  }

  const queryTokens = tokenize(options.query);
  const strictIdentifierSearch = shouldUseStrictIdentifierSearch(options.query, queryTokens);
  const primaryResults = store.search.search(normalizedQuery, getSearchOptions(strictIdentifierSearch));
  const results = strictIdentifierSearch && primaryResults.length === 0
    ? store.search.search(normalizedQuery, getSearchOptions(false))
    : primaryResults;

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

      const ranked = rankEntry(entry, result.score, options.query, queryTokens, options.kind, Boolean(options.explain));

      return {
        entry,
        score: ranked.score,
        scoreBreakdown: ranked.scoreBreakdown,
      };
    })
    .filter((hit): hit is SearchHit => Boolean(hit))
    .sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file) || a.entry.line - b.entry.line)
    .slice(0, options.limit);
}

export function exportEntries(
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

export function importerEntries(
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

export function referenceEntries(
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

export function outlineEntries(store: SearchStore, cwd: string, file: string): IndexEntry[] {
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
  explain = false,
): { score: number; scoreBreakdown?: SearchScoreContribution[] } {
  const entryTokens = new Set([
    ...entry.nameTokens,
    ...entry.containerTokens,
    ...entry.pathTokens,
    ...entry.jsDocTokens,
    ...entry.propTokens,
    ...entry.importTokens,
  ]);
  const queryKind = detectKindFromQuery(queryTokens);
  const strictIdentifierSearch = shouldUseStrictIdentifierSearch(rawQuery, queryTokens);
  const scoreBreakdown = explain ? [{ label: "MiniSearch base", value: baseScore }] : undefined;
  let score = baseScore;

  if (compactText(entry.name) === compactText(rawQuery) || compactText(entry.qualifiedName) === compactText(rawQuery)) {
    score += addScore(scoreBreakdown, "exact identifier match", 100);
  }
  if (
    queryTokens.length > 0 &&
    queryTokens.every((token) => [...entry.nameTokens, ...entry.containerTokens].includes(token))
  ) {
    score += addScore(scoreBreakdown, "all query tokens in name/container", 30);
  }
  if (strictIdentifierSearch && endsWithTokens(entry.nameTokens, queryTokens)) {
    score += addScore(scoreBreakdown, "identifier suffix match", 20, entry.name);
  }

  const matchedTokens = queryTokens.filter((token) => entryTokens.has(token));
  if (matchedTokens.length > 0) {
    score += addScore(scoreBreakdown, "matched query tokens", matchedTokens.length * 4, matchedTokens.join(", "));
  }
  if (entry.exported) {
    score += addScore(scoreBreakdown, "exported", 8);
  }
  if (entry.defaultExport) {
    score += addScore(scoreBreakdown, "default export", 6);
  }
  if (desiredKind && entry.kind === desiredKind) {
    score += addScore(scoreBreakdown, "requested kind match", 8, desiredKind);
  }
  if (queryKind && entry.kind === queryKind) {
    score += addScore(scoreBreakdown, "query kind hint match", 8, queryKind);
  }
  if (queryTokens.includes("component") && entry.kind === "component") {
    score += addScore(scoreBreakdown, '"component" query bonus', 8);
  }
  if (queryTokens.includes("hook") && entry.kind === "hook") {
    score += addScore(scoreBreakdown, '"hook" query bonus', 8);
  }

  return { score, scoreBreakdown };
}

function addScore(
  scoreBreakdown: SearchScoreContribution[] | undefined,
  label: string,
  value: number,
  detail?: string,
): number {
  if (scoreBreakdown && value !== 0) {
    scoreBreakdown.push({ label, value, detail });
  }
  return value;
}

function getSearchOptions(strictIdentifierSearch: boolean) {
  return {
    prefix: !strictIdentifierSearch,
    combineWith: strictIdentifierSearch ? "AND" : "OR",
    boost: {
      nameText: 5,
      pathText: 2,
      jsDocText: 1.5,
      propText: 1.5,
      importText: 1,
      text: 1,
    },
  } as const;
}

function shouldUseStrictIdentifierSearch(rawQuery: string, queryTokens: string[]): boolean {
  const trimmed = rawQuery.trim();
  return (
    queryTokens.length >= 2 &&
    !/\s/.test(trimmed) &&
    (/[._\-/]/.test(trimmed) || /[a-z0-9][A-Z]/.test(trimmed) || /[A-Z]+[A-Z][a-z]/.test(trimmed))
  );
}

function endsWithTokens(value: string[], suffix: string[]): boolean {
  if (suffix.length === 0 || suffix.length > value.length) {
    return false;
  }

  return suffix.every((token, index) => value[value.length - suffix.length + index] === token);
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

export function formatSearchResults(query: string, hits: SearchHit[], explain = false): string {
  if (hits.length === 0) {
    return `No TS/TSX symbol matches for "${query}".`;
  }

  return [`${hits.length} TS/TSX symbol matches for "${query}":`, ...hits.map((hit, index) => formatHit(hit, index, explain))].join("\n");
}

export function formatOutlineResults(file: string, entries: IndexEntry[]): string {
  if (entries.length === 0) {
    return `No indexed TS/TSX symbols found for ${file}.`;
  }

  return [`${entries.length} indexed symbols in ${file}:`, ...entries.map((entry) => formatEntryLine(entry))].join("\n");
}

export function formatExportResults(query: string | undefined, file: string | undefined, hits: SearchHit[]): string {
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

export function formatImporterResults(file: string | undefined, symbol: string | undefined, hits: ImportEdge[]): string {
  const target = [symbol ? `symbol "${symbol}"` : undefined, file ? `file ${file}` : undefined].filter(Boolean).join(" in ");
  const header = `${hits.length} TS/TSX importers for ${target}:`;

  if (hits.length === 0) {
    return `No TS/TSX importers found for ${target}.`;
  }

  return [header, ...hits.map(formatImportEdge)].join("\n");
}

export function formatReferenceResults(symbol: string, file: string | undefined, hits: ReferenceHit[]): string {
  const target = file ? `"${symbol}" in ${file}` : `"${symbol}"`;
  if (hits.length === 0) {
    return `No TS/TSX references found for ${target}.`;
  }

  return [`${hits.length} TS/TSX references for ${target}:`, ...hits.map(formatReferenceHit)].join("\n");
}

function formatHit(hit: SearchHit, index: number, explain = false): string {
  const line = formatEntryLine(hit.entry, index + 1);
  if (!explain || !hit.scoreBreakdown || hit.scoreBreakdown.length === 0) {
    return line;
  }

  return `${line}\n   score ${formatScore(hit.score)} = ${formatScoreBreakdown(hit.scoreBreakdown)}`;
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

function formatScoreBreakdown(scoreBreakdown: SearchScoreContribution[]): string {
  return scoreBreakdown
    .map((part) => `${part.label} ${formatSignedScore(part.value)}${part.detail ? ` (${part.detail})` : ""}`)
    .join("; ");
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatSignedScore(value: number): string {
  const formatted = formatScore(value);
  return value >= 0 ? `+${formatted}` : formatted;
}
