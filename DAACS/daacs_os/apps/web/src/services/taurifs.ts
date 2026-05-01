import type { IdeFileResponse, IdeTreeResponse } from "../types/agent";
import { isTauri } from "./tauriCli";

type ReadDirEntry = { path: string; name: string; isFile?: boolean; isDirectory?: boolean; children?: ReadDirEntry[] };

function flattenFiles(entries: ReadDirEntry[]): Array<{ path: string; size_bytes: number; modified_at: string; language: string }> {
  const out: Array<{ path: string; size_bytes: number; modified_at: string; language: string }> = [];
  for (const e of entries) {
    const isFile = e.isFile === true || (e.isDirectory !== true && e.path && !e.children?.length);
    if (isFile && e.path) {
      out.push({ path: e.path, size_bytes: 0, modified_at: "", language: "" });
    }
    if (e.children?.length) {
      out.push(...flattenFiles(e.children));
    }
  }
  return out;
}

const DEFAULT_BASE_DIR = 18;

export async function getIdeTreeLocal(InRootPath: string): Promise<IdeTreeResponse | null> {
  if (!isTauri()) return null;
  try {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/plugin-fs") as unknown as {
      readDir?: (path: string, opts?: { recursive?: boolean; baseDir?: number }) => Promise<ReadDirEntry[]>;
      BaseDirectory?: { AppData?: number };
    };
    const readDir = mod?.readDir;
    if (typeof readDir !== "function") return null;
    const baseDir = mod?.BaseDirectory?.AppData ?? DEFAULT_BASE_DIR;
    const entries = await readDir(InRootPath || ".", { recursive: true, baseDir });
    const files = flattenFiles(Array.isArray(entries) ? entries : []);
    return {
      project_id: "",
      exists: true,
      root: InRootPath || ".",
      files,
      read_only: false,
    };
  } catch {
    return null;
  }
}

export async function getIdeFileLocal(InPath: string): Promise<IdeFileResponse | null> {
  if (!isTauri() || !InPath) return null;
  try {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/plugin-fs") as unknown as {
      readTextFile?: (path: string, opts?: { baseDir?: number }) => Promise<string>;
      BaseDirectory?: { AppData?: number };
    };
    const readTextFile = mod?.readTextFile;
    if (typeof readTextFile !== "function") return null;
    const baseDir = mod?.BaseDirectory?.AppData ?? DEFAULT_BASE_DIR;
    const content = await readTextFile(InPath, { baseDir });
    return {
      project_id: "",
      path: InPath,
      language: "",
      content: content ?? "",
      read_only: false,
    };
  } catch {
    return null;
  }
}
