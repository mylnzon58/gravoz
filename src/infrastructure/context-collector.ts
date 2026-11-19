/**
 * Bounded, cached workspace & artifact context collector.
 * Recolector acotado y en caché del contexto del proyecto y sus artefactos recientes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectContext } from "../domain/types.js";
import { isAllowedAntigravityPath, isPathWithinRoot } from "./paths.js";

const MAX_PROJECT_SUMMARY_CHARS = 6_000;
const MAX_ARTIFACTS_CHARS = 3_000;
const CACHE_TTL_MS = 60_000;

interface CachedContext {
  readonly expiresAt: number;
  readonly summary: string;
  readonly projectName: string;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "target",
]);

const MANIFEST_FILES = [
  "README.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

function readSnippet(filePath: string, root: string, maxChars: number): string {
  if (!isPathWithinRoot(filePath, root)) return "";
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return "";
    return readFileSync(filePath, "utf8").slice(0, maxChars).trim();
  } catch {
    return "";
  }
}

export class ContextCollector {
  private readonly cache = new Map<string, CachedContext>();

  public collect(params: {
    readonly workspacePaths?: readonly string[];
    readonly artifactDirectoryPath?: string;
    readonly cwd?: string;
  }): ProjectContext {
    const workspaceRoot = params.workspacePaths?.[0] ?? params.cwd ?? "";
    const { projectName, summary } = this.collectWorkspaceSummary(workspaceRoot);
    const recentArtifacts = this.collectRecentArtifacts(
      params.artifactDirectoryPath,
      params.workspacePaths ?? [],
    );

    return { projectName, summary, recentArtifacts };
  }

  private collectWorkspaceSummary(workspaceRoot: string): {
    readonly projectName: string;
    readonly summary: string;
  } {
    if (!workspaceRoot || !existsSync(workspaceRoot)) {
      return { projectName: "Proyecto Antigravity", summary: "" };
    }

    const cached = this.cache.get(workspaceRoot);
    if (cached && cached.expiresAt > Date.now()) {
      return { projectName: cached.projectName, summary: cached.summary };
    }

    const projectName = basename(workspaceRoot) || "Proyecto Antigravity";
    const parts: string[] = [];

    try {
      const entries = readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((entry) => !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".env"))
        .slice(0, 35)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      if (entries.length > 0) {
        parts.push(`Estructura raíz: ${entries.join(", ")}`);
      }
    } catch {
      // Directory listing optional.
    }

    for (const fileName of MANIFEST_FILES) {
      const fullPath = join(workspaceRoot, fileName);
      if (existsSync(fullPath)) {
        const snippet = readSnippet(fullPath, workspaceRoot, 1_800);
        if (snippet) {
          parts.push(`--- ${fileName} ---\n${snippet}`);
        }
      }
    }

    const summary = parts.join("\n\n").slice(0, MAX_PROJECT_SUMMARY_CHARS);
    this.cache.set(workspaceRoot, {
      projectName,
      summary,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { projectName, summary };
  }

  private collectRecentArtifacts(
    artifactDir: string | undefined,
    workspacePaths: readonly string[],
  ): string {
    if (!artifactDir || !existsSync(artifactDir)) return "";
    if (!isAllowedAntigravityPath(artifactDir, workspacePaths)) return "";

    try {
      const mdFiles = readdirSync(artifactDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => {
          const full = join(artifactDir, e.name);
          const mtimeMs = statSync(full).mtimeMs;
          return { name: e.name, full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 2);

      const snippets = mdFiles
        .map((f) => {
          const text = readSnippet(f.full, artifactDir, 1_400);
          return text ? `[Artefacto: ${f.name}]\n${text}` : "";
        })
        .filter((s) => s.length > 0);

      return snippets.join("\n\n").slice(0, MAX_ARTIFACTS_CHARS);
    } catch {
      return "";
    }
  }
}
