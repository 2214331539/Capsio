import { invoke, isTauri } from '@tauri-apps/api/core';

export type LocalTex = { distribution: string; bin: string; latexmk: boolean; engines: string[] };
export type TexStatus = {
  local: LocalTex | null;
  /** The version of the Tectonic bundled with Scientify. */
  builtin: string | null;
};
export type Engine = 'auto' | 'builtin' | 'local';
export type CompileRequest = {
  folder: string;
  main: string;
  compiler: 'pdflatex' | 'xelatex' | 'lualatex';
  engine?: Engine;
  draft?: boolean;
  stopOnError?: boolean;
  clean?: boolean;
  writePdf?: boolean;
};
export type CompileResult = {
  status: 'success' | 'failed' | 'cancelled';
  engine: string;
  /** The bundled engine compiled it; it downloads missing packages by itself. */
  bundled: boolean;
  durationMs: number;
  log: string;
  output: string;
  pdf: boolean;
  /** The manuscript folder's absolute path, to make log and SyncTeX paths relative. */
  root: string;
};
/** A new folder made from a zip or a Git repository; `files` are relative to it. */
export type Imported = { folder: string; files: string[] };
type Target = { folder: string; main: string };

/** LaTeX compiling runs on this computer; the browser preview has none. */
export const writingApi = {
  available: () => isTauri(),
  status: () => invoke<TexStatus>('writing_tex_status'),
  compile: (projectId: string, request: CompileRequest) =>
    invoke<CompileResult>('writing_compile', { projectId, request }),
  cancel: (projectId: string, target: Target) =>
    invoke<void>('writing_cancel', { projectId, ...target }),
  pdf: async (projectId: string, target: Target) =>
    new Uint8Array(await invoke<ArrayBuffer>('writing_pdf', { projectId, ...target })),
  synctex: (projectId: string, target: Target) =>
    invoke<string>('writing_synctex', { projectId, ...target }),
  exportPdf: (projectId: string, target: Target) =>
    invoke<string | null>('writing_export_pdf', { projectId, ...target }),
  /** Asks for a zip and unpacks it into a new project folder; null when the person cancels. */
  importZip: (projectId: string) => invoke<Imported | null>('writing_import_zip', { projectId }),
  clone: (projectId: string, url: string, name: string, token: string) =>
    invoke<Imported>('writing_clone', { projectId, url, name, token: token || null }),
  exportSource: (projectId: string, target: Target, files: string[], bbl: boolean) =>
    invoke<string | null>('writing_export_source', { projectId, ...target, files, bbl }),
};
