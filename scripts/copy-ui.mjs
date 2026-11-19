// Copies static UI assets into dist/ui after TypeScript compilation.
// Copia los archivos estáticos de la UI hacia dist/ui tras compilar TypeScript.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcUi = resolve(rootDir, "src", "ui");
const distUi = resolve(rootDir, "dist", "src", "ui");

mkdirSync(distUi, { recursive: true });
cpSync(srcUi, distUi, { recursive: true });
