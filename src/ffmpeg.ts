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
