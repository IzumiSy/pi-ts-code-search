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
import {
  DEFAULT_IGNORE_RULES,
  dedupe,
  firstLine,
  relativeFile,
  toPosix,
  tokenize,
  type ImportEdge,
  type IndexEntry,
  type SearchDocument,
  type SearchKind,
  type SearchStore,
} from "./search-shared.ts";

const storeByCwd = new Map<string, SearchStore>();

export function invalidateStore(cwd: string) {
  storeByCwd.delete(cwd);
}

export function clearStores() {
  storeByCwd.clear();
}

export function getStore(cwd: string, refresh = false): SearchStore {
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

export function createIgnoreMatcher(cwd: string) {
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

export function shouldIndexSourceFile(cwd: string, source: SourceFile, ignoreMatcher: ReturnType<typeof ignore>): boolean {
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
