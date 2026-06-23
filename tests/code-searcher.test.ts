import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import codeSearcher from "../extension/index.ts";

type ToolDefinition = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ details?: { builtAt?: number } }>;
};

type EventHandler = (event: any, ctx: { cwd: string }) => Promise<unknown> | unknown;

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

  codeSearcher(pi as never);

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

async function hasMatch(searchTool: ToolDefinition, cwd: string, query: string) {
  const result = await searchTool.execute("tool-call", { query }, undefined, undefined, { cwd });
  return typeof result.details?.builtAt === "number" && Array.isArray((result.details as any).hits)
    ? (result.details as any).hits.length > 0
    : false;
}

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("code-searcher cache invalidation", () => {
  it.each(["write", "edit", "bash"])("rebuilds after %s tool execution", async (toolName) => {
    const { tools, handlers } = createFakePi();
    const searchTool = tools.get("ts_index_search");
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
    const searchTool = tools.get("ts_index_search");
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

describe("ts_index_importers", () => {
  it("finds imports and re-exports for a file and symbol", async () => {
    const { tools } = createFakePi();
    const importerTool = tools.get("ts_index_importers");
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
    const hits = (result.details as any).hits;

    expect(hits).toHaveLength(2);
    expect(hits.map((hit: any) => [hit.importerFile, hit.importerKind])).toEqual([
      ["src/bar.ts", "import"],
      ["src/index.ts", "re-export"],
    ]);
  });
});

describe("member indexing", () => {
  it("indexes class, enum, and object members", async () => {
    const { tools } = createFakePi();
    const searchTool = tools.get("ts_index_search");
    const outlineTool = tools.get("ts_index_file_outline");
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
    const searchHits = (searchResult.details as any).hits;
    expect(searchHits[0].qualifiedName).toBe("AuthService.login");

    const outlineResult = await outlineTool!.execute("tool-call", { file: "src/example.ts" }, undefined, undefined, {
      cwd,
    });
    const entries = (outlineResult.details as any).entries;
    expect(entries.map((entry: any) => entry.qualifiedName)).toEqual(
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

describe("ts_index_references", () => {
  it("finds local and imported references for a top-level symbol", async () => {
    const { tools } = createFakePi();
    const referenceTool = tools.get("ts_index_references");
    const cwd = makeFilesProject({
      "src/foo.ts": 'export function Foo() { return 1; }\nexport function wrap() { return Foo(); }\n',
      "src/bar.ts": 'import { Foo } from "./foo";\nexport const bar = Foo();\n',
    });
    createdDirs.push(cwd);

    expect(referenceTool).toBeDefined();

    const result = await referenceTool!.execute("tool-call", { symbol: "Foo", file: "src/foo.ts" }, undefined, undefined, {
      cwd,
    });
    const hits = (result.details as any).hits;

    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/foo.ts", kind: "call" }),
        expect.objectContaining({ file: "src/bar.ts", kind: "import" }),
        expect.objectContaining({ file: "src/bar.ts", kind: "call" }),
      ]),
    );
  });
});
