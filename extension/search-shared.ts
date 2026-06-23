import type MiniSearch from "minisearch";
import path from "node:path";
import type { Project } from "ts-morph";

export const SEARCH_KINDS = [
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
export const DEFAULT_IGNORE_RULES = ["node_modules/", "dist/", "build/", "coverage/", ".next/", ".turbo/", "*.d.ts"];

export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface IndexEntry {
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

export interface SearchDocument {
  id: string;
  nameText: string;
  pathText: string;
  jsDocText: string;
  propText: string;
  importText: string;
  text: string;
}

export interface SearchScoreContribution {
  label: string;
  value: number;
  detail?: string;
}

export interface SearchHit {
  entry: IndexEntry;
  score: number;
  scoreBreakdown?: SearchScoreContribution[];
}

export interface ImportEdge {
  importerFile: string;
  importerLine: number;
  importerColumn: number;
  importerKind: "import" | "re-export";
  moduleSpecifier: string;
  importedFile?: string;
  importedSymbols: string[];
  preview: string;
}

export interface ReferenceHit {
  declarationName: string;
  declarationFile: string;
  declarationKind: SearchKind;
  file: string;
  line: number;
  column: number;
  kind: "call" | "type" | "import" | "export" | "read" | "write";
  preview: string;
}

export interface SearchStoreBuildTimings {
  totalMs: number;
  createProjectMs: number;
  createIgnoreMatcherMs: number;
  collectEntriesMs: number;
  collectImportEdgesMs: number;
  addSearchDocumentsMs: number;
}

export interface SearchStore {
  cwd: string;
  builtAt: number;
  project: Project;
  entries: IndexEntry[];
  entriesById: Map<string, IndexEntry>;
  importEdges: ImportEdge[];
  search: MiniSearch<SearchDocument>;
  timings: SearchStoreBuildTimings;
}

export interface SearchStoreAccess {
  store: SearchStore;
  cacheHit: boolean;
}

export function normalizeKind(kind?: string): SearchKind | undefined {
  if (!kind) {
    return undefined;
  }
  const normalized = kind.trim().toLowerCase();
  return SEARCH_KIND_SET.has(normalized) ? (normalized as SearchKind) : undefined;
}

export function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), 100));
}

export function normalizeQuery(query: string): string {
  return tokenize(query).join(" ");
}

export function tokenize(value: string): string[] {
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

export function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function relativeFile(cwd: string, file: string): string {
  return toPosix(path.relative(cwd, file));
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

export function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function firstLine(value: string): string {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}
