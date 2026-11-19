/**
 * Cross-platform state paths and symlink-safe path containment checks (OWASP A01).
 * Rutas de estado multiplataforma y validación segura contra path traversal / symlinks.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Resolves Gravoz's persistent data directory across Linux, macOS, and Windows. */
/** Resuelve el directorio persistente de datos de Gravoz en Linux, macOS y Windows. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const pluginData = env["PLUGIN_DATA"]?.trim();
  if (pluginData && pluginData.length > 0) {
    return resolve(pluginData);
  }

  if (process.platform === "win32") {
    const localAppData = env["LOCALAPPDATA"]?.trim();
    if (localAppData && localAppData.length > 0) {
      return join(resolve(localAppData), "gravoz");
    }
  }

  return join(homedir(), ".gravoz");
}

/** Ensures a directory exists with owner-only permissions on Unix (0o700). */
/** Garantiza que un directorio exista con permisos exclusivos del propietario en Unix. */
export function ensurePrivateDir(dirPath: string): string {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  return dirPath;
}

/**
 * Verifies that `targetPath` resolves inside `allowedRoot` after following symlinks.
 * Verifica que `targetPath` permanezca dentro de `allowedRoot` tras resolver enlaces simbólicos.
 */
export function isPathWithinRoot(targetPath: string, allowedRoot: string): boolean {
  try {
    const realRoot = realpathSync(resolve(allowedRoot));
    const realTarget = realpathSync(resolve(targetPath));
    const rel = relative(realRoot, realTarget);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * Checks whether a transcript or artifact path belongs to an allowed workspace or ~/.gemini root.
 * Comprueba si una ruta de transcripción o artefacto pertenece al workspace o a ~/.gemini.
 */
export function isAllowedAntigravityPath(
  candidatePath: string,
  workspacePaths: readonly string[] = [],
): boolean {
  const geminiRoot = join(homedir(), ".gemini");
  const allowedRoots = [geminiRoot, ...workspacePaths];
  return allowedRoots.some((root) => root.length > 0 && isPathWithinRoot(candidatePath, root));
}
