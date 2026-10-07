import { assertEquals } from "@std/assert";
import {
  flushStderr,
  newProgressState,
  newStderrState,
  parseProgress,
  splitStderr,
} from "../src/ffmpeg.ts";

Deno.test("parseProgress emits one event per progress block", () => {
  const state = newProgressState();
  const events = parseProgress(
    "frame=10\nout_time_us=1500000\nout_time_ms=1500000\nspeed=1.5x\nprogress=continue\n",
    state,
  );
  assertEquals(events, [{ outTimeSec: 1.5, speed: 1.5, ended: false }]);
});

Deno.test("parseProgress marks the final block as ended", () => {
  const state = newProgressState();
  const events = parseProgress(
    "out_time_us=3000000\nspeed=26.3x\nprogress=end\n",
    state,
  );
  assertEquals(events, [{ outTimeSec: 3, speed: 26.3, ended: true }]);
});

Deno.test("parseProgress ignores N/A values and keeps the previous time", () => {
  const state = newProgressState();
  parseProgress("out_time_us=2000000\nprogress=continue\n", state);
  const events = parseProgress(
    "out_time_us=N/A\nspeed=N/A\nprogress=continue\n",
    state,
  );
  assertEquals(events, [{ outTimeSec: 2, speed: null, ended: false }]);
});

Deno.test("parseProgress falls back to out_time_ms (microseconds)", () => {
  const state = newProgressState();
  const events = parseProgress(
    "out_time_ms=500000\nprogress=continue\n",
    state,
  );
  assertEquals(events, [{ outTimeSec: 0.5, speed: null, ended: false }]);
});

Deno.test("parseProgress prefers out_time_us over out_time_ms within a block", () => {
  const usFirst = newProgressState();
  assertEquals(
    parseProgress(
      "out_time_us=2000000\nout_time_ms=1000000\nprogress=continue\n",
      usFirst,
    ),
    [{ outTimeSec: 2, speed: null, ended: false }],
  );
  const msFirst = newProgressState();
  assertEquals(
    parseProgress(
      "out_time_ms=1000000\nout_time_us=2000000\nprogress=continue\n",
      msFirst,
    ),
    [{ outTimeSec: 2, speed: null, ended: false }],
  );
  // The next block without out_time_us falls back to out_time_ms.
  assertEquals(
    parseProgress("out_time_ms=3000000\nprogress=continue\n", msFirst),
    [{ outTimeSec: 3, speed: null, ended: false }],
  );
});

Deno.test("parseProgress joins lines split across chunks", () => {
  const state = newProgressState();
  assertEquals(parseProgress("out_time_us=25", state), []);
  assertEquals(parseProgress("00000\nspeed=2x\nprog", state), []);
  assertEquals(parseProgress("ress=end\n", state), [{
    outTimeSec: 2.5,
    speed: 2,
    ended: true,
  }]);
});

Deno.test("splitStderr marks \\r-terminated segments as transient", () => {
  const state = newStderrState();
  assertEquals(
    splitStderr(
      "Input #0\nframe=  1 time=00:00:00.10    \rframe=  2 time=00:00:00.20    \r",
      state,
    ),
    [
      { segment: "Input #0", transient: false },
      { segment: "frame=  1 time=00:00:00.10", transient: true },
    ],
  );
  // The second \r is only resolved once the next character arrives.
  assertEquals(splitStderr("x", state), [{
    segment: "frame=  2 time=00:00:00.20",
    transient: true,
  }]);
});

Deno.test("splitStderr treats \\n-terminated segments as permanent", () => {
  const state = newStderrState();
  assertEquals(splitStderr("frame= 90 time=00:00:02.93   \n", state), [
    { segment: "frame= 90 time=00:00:02.93", transient: false },
  ]);
});

Deno.test("splitStderr treats \\r\\n as a single newline", () => {
  const state = newStderrState();
  assertEquals(splitStderr("warning one\r\nwarning two\r", state), [
    { segment: "warning one", transient: false },
  ]);
  assertEquals(splitStderr("\n", state), [{
    segment: "warning two",
    transient: false,
  }]);
});

Deno.test("splitStderr reassembles segments split across chunks", () => {
  const state = newStderrState();
  assertEquals(splitStderr("[mp4 @ 0x1] some ", state), []);
  assertEquals(splitStderr("warning\n", state), [{
    segment: "[mp4 @ 0x1] some warning",
    transient: false,
  }]);
});

Deno.test("splitStderr skips empty and whitespace-only segments", () => {
  const state = newStderrState();
  assertEquals(splitStderr("\n\n   \n\r\rtext\n", state), [{
    segment: "text",
    transient: false,
  }]);
});

Deno.test("flushStderr emits an unterminated final line as permanent", () => {
  const state = newStderrState();
  assertEquals(splitStderr("fatal-error", state), []);
  assertEquals(flushStderr(state), [{
    segment: "fatal-error",
    transient: false,
  }]);
  assertEquals(flushStderr(state), []);
});

Deno.test("flushStderr keeps a trailing lone \\r transient", () => {
  const state = newStderrState();
  assertEquals(splitStderr("frame=  1 time=00:00:00.10    \r", state), []);
  assertEquals(flushStderr(state), [{
    segment: "frame=  1 time=00:00:00.10",
    transient: true,
  }]);
});
