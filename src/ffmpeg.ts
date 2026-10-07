import type { ProgressUpdate, ToolCheck } from "./types.ts";

export interface ProgressState {
  buffer: string;
  outTimeSec: number;
  speed: number | null;
  /** out_time_us / out_time_ms seen in the current block (microseconds). */
  blockUs: number | null;
  blockMs: number | null;
}

export interface ProgressEvent {
  outTimeSec: number;
  speed: number | null;
  ended: boolean;
}

export interface StderrState {
  buffer: string;
  pendingCR: boolean;
}

export interface StderrSegment {
  segment: string;
  transient: boolean;
}

export function newProgressState(): ProgressState {
  return {
    buffer: "",
    outTimeSec: 0,
    speed: null,
    blockUs: null,
    blockMs: null,
  };
}

export function newStderrState(): StderrState {
  return { buffer: "", pendingCR: false };
}

/**
 * Parses `-progress pipe:1` key=value output; one event per `progress=` line.
 * Within a block out_time_us wins; out_time_ms (also microseconds in ffmpeg)
 * is only a fallback when the block has no usable out_time_us.
 */
export function parseProgress(
  chunk: string,
  state: ProgressState,
): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  const lines = (state.buffer + chunk).split("\n");
  state.buffer = lines.pop() ?? "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "out_time_us" || key === "out_time_ms") {
      if (value === "N/A") continue;
      const micros = Number(value);
      if (!Number.isFinite(micros) || micros < 0) continue;
      if (key === "out_time_us") state.blockUs = micros;
      else state.blockMs = micros;
    } else if (key === "speed") {
      const match = /^([\d.]+)x$/.exec(value);
      state.speed = match ? Number(match[1]) : null;
    } else if (key === "progress") {
      const micros = state.blockUs ?? state.blockMs;
      if (micros !== null) state.outTimeSec = micros / 1_000_000;
      state.blockUs = null;
      state.blockMs = null;
      events.push({
        outTimeSec: state.outTimeSec,
        speed: state.speed,
        ended: value === "end",
      });
    }
  }
  return events;
}

/**
 * Splits stderr on \r and \n. Segments ended by a lone \r are ffmpeg's
 * in-place stats updates (transient); \n and \r\n end permanent lines.
 */
export function splitStderr(
  chunk: string,
  state: StderrState,
): StderrSegment[] {
  const segments: StderrSegment[] = [];
  const push = (text: string, transient: boolean) => {
    const segment = text.trim();
    if (segment !== "") segments.push({ segment, transient });
  };
  let buffer = state.buffer;
  for (const ch of chunk) {
    if (state.pendingCR) {
      state.pendingCR = false;
      if (ch === "\n") {
        push(buffer, false);
        buffer = "";
        continue;
      }
      push(buffer, true);
      buffer = "";
    }
    if (ch === "\r") {
      state.pendingCR = true;
    } else if (ch === "\n") {
      push(buffer, false);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  state.buffer = buffer;
  return segments;
}

/**
 * Emits whatever is still buffered at EOF. A pending lone \r keeps its
 * transient classification; an unterminated line counts as permanent so a
 * final error message still reaches the stderr tail.
 */
export function flushStderr(state: StderrState): StderrSegment[] {
  const segment = state.buffer.trim();
  const transient = state.pendingCR;
  state.buffer = "";
  state.pendingCR = false;
  return segment === "" ? [] : [{ segment, transient }];
}

export type ProgressUpdateCallback = (update: ProgressUpdate) => void;

export interface FfmpegRunOptions {
  ffmpegPath: string;
  args: string[];
  durationSec: number | null;
  onProgress: ProgressUpdateCallback;
}

export interface FfmpegRun {
  done: Promise<{ code: number; stderrTail: string[] }>;
  cancel(): void;
}

// Every child this module spawns is registered so shutdown paths can kill
// them synchronously: Deno.exit() does not terminate children.
const children = new Set<Deno.ChildProcess>();

function track(child: Deno.ChildProcess): void {
  children.add(child);
  const forget = () => children.delete(child);
  child.status.then(forget, forget);
}

function killQuietly(child: Deno.ChildProcess, signal: Deno.Signal): void {
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

export function activeChildCount(): number {
  return children.size;
}

export function killAllChildren(): void {
  for (const child of children) killQuietly(child, "SIGKILL");
}

export async function checkTool(
  path: string,
  timeoutMs = 5000,
): Promise<ToolCheck> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(path, {
      args: ["-version"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  track(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killQuietly(child, "SIGKILL");
  }, timeoutMs);
  const [status, stdout] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    return {
      ok: false,
      error: `執行逾時（${timeoutMs / 1000} 秒），請確認路徑是否正確`,
    };
  }
  if (!status.success) {
    return { ok: false, error: `執行失敗（結束碼 ${status.code}）` };
  }
  return { ok: true, version: stdout.split("\n")[0].trim() };
}

export async function probeDuration(
  ffprobePath: string,
  file: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<number | null> {
  if (signal.aborted) return null;
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(ffprobePath, {
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    return null;
  }
  track(child);
  const kill = () => killQuietly(child, "SIGKILL");
  const timer = setTimeout(kill, timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [status, stdout] = await Promise.all([
      child.status,
      new Response(child.stdout).text(),
    ]);
    if (!status.success || signal.aborted) return null;
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
}

const GLOBAL_ARGS = ["-hide_banner", "-stats", "-progress", "pipe:1", "-y"];
const STDERR_TAIL_LINES = 200;

export function runFfmpeg(opts: FfmpegRunOptions): FfmpegRun {
  const child = new Deno.Command(opts.ffmpegPath, {
    args: [...GLOBAL_ARGS, ...opts.args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  track(child);

  const progress = newProgressState();
  const stderrState = newStderrState();
  const stderrTail: string[] = [];
  let message: string | null = null;

  const emit = () => {
    const percent = opts.durationSec
      ? Math.min(100, (progress.outTimeSec / opts.durationSec) * 100)
      : null;
    opts.onProgress({
      percent,
      outTimeSec: progress.outTimeSec,
      durationSec: opts.durationSec,
      speed: progress.speed,
      message,
    });
  };

  const readStdout = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      if (
        parseProgress(decoder.decode(chunk, { stream: true }), progress)
          .length > 0
      ) emit();
    }
  })();

  // Every message update triggers onProgress; transient stats lines never
  // enter the error tail.
  const handleSegments = (segments: StderrSegment[]) => {
    for (const { segment, transient } of segments) {
      message = segment;
      if (!transient) {
        stderrTail.push(segment);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
      emit();
    }
  };

  const readStderr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      handleSegments(
        splitStderr(decoder.decode(chunk, { stream: true }), stderrState),
      );
    }
    handleSegments(splitStderr(decoder.decode(), stderrState));
    handleSegments(flushStderr(stderrState));
  })();

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const done = (async () => {
    const [status] = await Promise.all([child.status, readStdout, readStderr]);
    clearTimeout(killTimer);
    return { code: status.code, stderrTail };
  })();

  return {
    done,
    cancel() {
      if (killTimer !== undefined) return;
      killQuietly(child, "SIGTERM");
      killTimer = setTimeout(() => killQuietly(child, "SIGKILL"), 3000);
    },
  };
}
