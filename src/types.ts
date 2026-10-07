// Shared types for the Deno side, the user extension points and the UI contract.

export type Info = Record<string, string | number | boolean>;

export interface InfoColumn {
  key: string;
  label: string;
}

export interface Settings {
  cdpAddress: string;
  outputDir: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export interface TabInfo {
  targetId: string;
  title: string;
  url: string;
}

export interface ExtractResult {
  info: Info;
  mainPath: string;
  auxPath: string;
  mainSize: number;
  auxSize: number;
}

export interface FfmpegArgsContext {
  mainPath: string;
  auxPath: string;
  info: Info;
  outputPath: string;
}

export interface ToolCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface ProgressUpdate {
  percent: number | null;
  outTimeSec: number;
  durationSec: number | null;
  speed: number | null;
  /** Last stderr line printed by ffmpeg. */
  message: string | null;
}

export type JobStatus =
  | { state: "idle" }
  | { state: "extracting"; received: number; total: number }
  | {
    state: "ready";
    info: Info;
    columns: InfoColumn[];
    mainSize: number;
    auxSize: number;
    defaultFilename: string;
    /** Set when returning to ready after a destination failure. */
    lastError?: string;
  }
  | (
    & { state: "processing"; phase: "preparing" | "running" | "publishing" }
    & ProgressUpdate
  )
  | { state: "done"; outputPath: string; cleanupWarning?: string }
  | {
    state: "failed";
    stage: "extract" | "process";
    message: string;
    detail?: string[];
    cleanupWarning?: string;
  }
  | { state: "cancelled"; cleanupWarning?: string };
