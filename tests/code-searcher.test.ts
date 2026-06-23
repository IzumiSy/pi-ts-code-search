import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import codeSearcher from "../extensions/code-searcher/index.ts";

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
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-search-"));
  const srcDir = join(cwd, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "example.ts"), `export function ${functionName}() { return "${functionName}"; }\n`);
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
