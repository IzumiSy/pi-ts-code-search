import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ImportEdge,
  IndexEntry,
  ReferenceHit,
  SearchScoreContribution,
  SearchStoreBuildTimings,
} from "../extension/search-shared.ts";
import codeSearcher from "../extension/index.ts";

type ToolResult = {
  content?: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<ToolResult>;
};

type EventHandler = (event: unknown, ctx: { cwd: string }) => Promise<unknown> | unknown;
type SearchResultHit = IndexEntry & { score: number; scoreBreakdown?: SearchScoreContribution[] };
type SearchDetails = {
  builtAt?: number;
  cacheHit?: boolean;
  timings?: SearchStoreBuildTimings;
  hits?: SearchResultHit[];
  explain?: boolean;
  timing?: boolean;
};
type ImporterDetails = { hits?: ImportEdge[] };
type OutlineDetails = { entries?: IndexEntry[]; timing?: boolean };
type ReferenceDetails = { hits?: ReferenceHit[] };

function createFakePi() {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, EventHandler[]>();

  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(eventName: string, handler: EventHandler) {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
  };

  codeSearcher(pi as unknown as ExtensionAPI);

  return {
    tools,
    handlers,
  };
}

function makeProject(functionName: string) {
  return makeFilesProject({
    "src/example.ts": `export function ${functionName}() { return "${functionName}"; }\n`,
  });
}

function makeFilesProject(files: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ts-code-search-"));

  for (const [file, content] of Object.entries(files)) {
    const fullPath = join(cwd, file);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  return cwd;
}

function getSearchDetails(result: ToolResult): SearchDetails {
  return (result.details ?? {}) as SearchDetails;
}

function getImporterDetails(result: ToolResult): ImporterDetails {
  return (result.details ?? {}) as ImporterDetails;
}

function getOutlineDetails(result: ToolResult): OutlineDetails {
  return (result.details ?? {}) as OutlineDetails;
}

function getReferenceDetails(result: ToolResult): ReferenceDetails {
  return (result.details ?? {}) as ReferenceDetails;
}

async function hasMatch(searchTool: ToolDefinition, cwd: string, query: string) {
  const result = await searchTool.execute("tool-call", { query }, undefined, undefined, { cwd });
  const details = getSearchDetails(result);
  return typeof details.builtAt === "number" && (details.hits?.length ?? 0) > 0;
}

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("code-searcher cache invalidation", () => {
  it("returns build timings and cache state in tool details", async () => {
    const { tools } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const cwd = makeProject("alpha");
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();

    const firstResult = await searchTool!.execute("tool-call", { query: "alpha" }, undefined, undefined, { cwd });
    const secondResult = await searchTool!.execute("tool-call", { query: "alpha" }, undefined, undefined, { cwd });
    const firstDetails = getSearchDetails(firstResult);
    const secondDetails = getSearchDetails(secondResult);

    expect(firstDetails.cacheHit).toBe(false);
    expect(firstDetails.timings).toEqual(
      expect.objectContaining({
        totalMs: expect.any(Number),
        createProjectMs: expect.any(Number),
        createIgnoreMatcherMs: expect.any(Number),
        collectIndexDataMs: expect.any(Number),
        collectEntriesMs: expect.any(Number),
        collectImportEdgesMs: expect.any(Number),
        addSearchDocumentsMs: expect.any(Number),
      }),
    );
    expect(secondDetails.cacheHit).toBe(true);
    expect(secondDetails.timings).toEqual(firstDetails.timings);
  });

  it.each(["write", "edit", "bash"])("rebuilds after %s tool execution", async (toolName) => {
    const { tools, handlers } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const toolExecutionEndHandlers = handlers.get("tool_execution_end") ?? [];
    const cwd = makeProject("alpha");
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();
    expect(toolExecutionEndHandlers).toHaveLength(1);
    expect(await hasMatch(searchTool!, cwd, "alpha")).toBe(true);

    writeFileSync(join(cwd, "src/example.ts"), 'export function beta() { return "beta"; }\n');

    expect(await hasMatch(searchTool!, cwd, "beta")).toBe(false);

    await toolExecutionEndHandlers[0]!({ toolName }, { cwd });

    expect(await hasMatch(searchTool!, cwd, "beta")).toBe(true);
    expect(await hasMatch(searchTool!, cwd, "alpha")).toBe(false);
  });

  it("rebuilds after user bash", async () => {
    const { tools, handlers } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const userBashHandlers = handlers.get("user_bash") ?? [];
    const sessionShutdownHandlers = handlers.get("session_shutdown") ?? [];
    const cwd = makeProject("gamma");
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();
    expect(userBashHandlers).toHaveLength(1);
    expect(sessionShutdownHandlers).toHaveLength(1);
    expect(await hasMatch(searchTool!, cwd, "gamma")).toBe(true);

    writeFileSync(join(cwd, "src/example.ts"), 'export function delta() { return "delta"; }\n');

    expect(await hasMatch(searchTool!, cwd, "delta")).toBe(false);

    await userBashHandlers[0]!({ command: "touch src/example.ts" }, { cwd });

    expect(await hasMatch(searchTool!, cwd, "delta")).toBe(true);

    writeFileSync(join(cwd, "src/example.ts"), 'export function epsilon() { return "epsilon"; }\n');

    expect(await hasMatch(searchTool!, cwd, "epsilon")).toBe(false);

    await sessionShutdownHandlers[0]!({ reason: "quit" }, { cwd });

    expect(await hasMatch(searchTool!, cwd, "epsilon")).toBe(true);
  });
});

describe("ts_code_search_importers", () => {
  it("finds imports and re-exports for a file and symbol", async () => {
    const { tools } = createFakePi();
    const importerTool = tools.get("ts_code_search_importers");
    const cwd = makeFilesProject({
      "src/foo.ts": "export const Foo = 1;\n",
      "src/bar.ts": 'import { Foo } from "./foo";\nexport const bar = Foo;\n',
      "src/index.ts": 'export { Foo } from "./foo";\n',
    });
    createdDirs.push(cwd);

    expect(importerTool).toBeDefined();

    const result = await importerTool!.execute("tool-call", { file: "src/foo.ts", symbol: "Foo" }, undefined, undefined, {
      cwd,
    });
    const hits = getImporterDetails(result).hits ?? [];

    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => [hit.importerFile, hit.importerKind])).toEqual([
      ["src/bar.ts", "import"],
      ["src/index.ts", "re-export"],
    ]);
  });
});

describe("member indexing", () => {
  it("indexes class, enum, and object members", async () => {
    const { tools } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const outlineTool = tools.get("ts_code_search_file_outline");
    const cwd = makeFilesProject({
      "src/example.ts": `
export class AuthService {
  token = "";

  login(input: { userId: string }) {
    return input.userId;
  }
}

export enum Status {
  Active = "active",
}

export const authHelpers = {
  normalizeToken(value: string) {
    return value.trim();
  },
  storageKey: "token",
};
`,
    });
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();
    expect(outlineTool).toBeDefined();

    const searchResult = await searchTool!.execute(
      "tool-call",
      { query: "AuthService login", kind: "method" },
      undefined,
      undefined,
      { cwd },
    );
    const searchHits = getSearchDetails(searchResult).hits ?? [];
    expect(searchHits[0]?.qualifiedName).toBe("AuthService.login");

    const outlineResult = await outlineTool!.execute("tool-call", { file: "src/example.ts" }, undefined, undefined, {
      cwd,
    });
    const entries = getOutlineDetails(outlineResult).entries ?? [];
    expect(entries.map((entry) => entry.qualifiedName)).toEqual(
      expect.arrayContaining([
        "AuthService.login",
        "AuthService.token",
        "Status.Active",
        "authHelpers.normalizeToken",
        "authHelpers.storageKey",
      ]),
    );
  });
});

describe("ts_code_search_references", () => {
  it("finds local and imported references for a top-level symbol", async () => {
    const { tools } = createFakePi();
    const referenceTool = tools.get("ts_code_search_references");
    const cwd = makeFilesProject({
      "src/foo.ts": 'export function Foo() { return 1; }\nexport function wrap() { return Foo(); }\n',
      "src/bar.ts": 'import { Foo } from "./foo";\nexport const bar = Foo();\n',
    });
    createdDirs.push(cwd);

    expect(referenceTool).toBeDefined();

    const result = await referenceTool!.execute("tool-call", { symbol: "Foo", file: "src/foo.ts" }, undefined, undefined, {
      cwd,
    });
    const hits = getReferenceDetails(result).hits ?? [];

    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/foo.ts", kind: "call" }),
        expect.objectContaining({ file: "src/bar.ts", kind: "import" }),
        expect.objectContaining({ file: "src/bar.ts", kind: "call" }),
      ]),
    );
  });
});

describe("identifier-like search ranking", () => {
  it("keeps camelCase symbol queries focused", async () => {
    const { tools } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const cwd = makeFilesProject({
      "src/auth.ts": `
export function useAutoLogin() {
  return true;
}

export function autoMatchHeaders() {
  return [];
}
`,
      "src/sidebar.tsx": `
export function AutoSidebar() {
  return null;
}
`,
      "src/autocomplete.tsx": `
export function AutocompleteRoot() {
  return null;
}
`,
    });
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();

    const result = await searchTool!.execute("tool-call", { query: "autoLogin", limit: 10 }, undefined, undefined, { cwd });
    const hits = getSearchDetails(result).hits ?? [];

    expect(hits.map((hit) => hit.qualifiedName)).toEqual(["useAutoLogin"]);
  });

  it("falls back to broader search when strict identifier matching finds nothing", async () => {
    const { tools } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const cwd = makeFilesProject({
      "src/autocomplete.tsx": `
export function AutocompleteRoot() {
  return null;
}
`,
    });
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();

    const result = await searchTool!.execute("tool-call", { query: "autoComplete", limit: 10 }, undefined, undefined, { cwd });
    const hits = getSearchDetails(result).hits ?? [];

    expect(hits[0]?.qualifiedName).toBe("AutocompleteRoot");
  });

  it("returns score breakdowns when explain=true", async () => {
    const { tools } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const cwd = makeFilesProject({
      "src/auth.ts": `
export function useAutoLogin() {
  return true;
}
`,
    });
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();

    const result = await searchTool!.execute(
      "tool-call",
      { query: "autoLogin", limit: 10, explain: true },
      undefined,
      undefined,
      { cwd },
    );
    const details = getSearchDetails(result);
    const [firstHit] = details.hits ?? [];

    expect(details.explain).toBe(true);
    expect(firstHit.scoreBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "MiniSearch base" }),
        expect.objectContaining({ label: "all query tokens in name/container", value: 30 }),
        expect.objectContaining({ label: "identifier suffix match", value: 20 }),
        expect.objectContaining({ label: "matched query tokens", value: 8, detail: "auto, login" }),
        expect.objectContaining({ label: "exported", value: 8 }),
      ]),
    );
    expect(result.content?.[0]?.text).toContain("score ");
    expect(result.content?.[0]?.text).toContain("MiniSearch base");
    expect(result.content?.[0]?.text).not.toContain("timing total=");
  });

  it("appends a timing line when timing=true", async () => {
    const { tools } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const outlineTool = tools.get("ts_code_search_file_outline");
    const cwd = makeFilesProject({
      "src/auth.ts": `
export function useAutoLogin() {
  return true;
}
`,
    });
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();
    expect(outlineTool).toBeDefined();

    const searchResult = await searchTool!.execute(
      "tool-call",
      { query: "autoLogin", limit: 10, explain: true, timing: true },
      undefined,
      undefined,
      { cwd },
    );
    const searchDetails = getSearchDetails(searchResult);
    expect(searchDetails.timing).toBe(true);
    expect(searchResult.content?.[0]?.text).toContain("timing total=");

    const outlineResult = await outlineTool!.execute(
      "tool-call",
      { file: "src/auth.ts", timing: true },
      undefined,
      undefined,
      { cwd },
    );
    const outlineDetails = getOutlineDetails(outlineResult);
    expect(outlineDetails.timing).toBe(true);
    expect(outlineResult.content?.[0]?.text).toContain("timing total=");
  });
});

describe("ignore rules", () => {
  it("respects .gitignore patterns via ignore", async () => {
    const { tools } = createFakePi();
    const searchTool = tools.get("ts_code_search_search");
    const cwd = makeFilesProject({
      ".gitignore": "generated/\n",
      "src/visible.ts": 'export function visible() { return true; }\n',
      "generated/hidden.ts": 'export function hidden() { return false; }\n',
    });
    createdDirs.push(cwd);

    expect(searchTool).toBeDefined();
    expect(await hasMatch(searchTool!, cwd, "visible")).toBe(true);
    expect(await hasMatch(searchTool!, cwd, "hidden")).toBe(false);
  });
});
