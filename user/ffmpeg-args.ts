import type { FfmpegArgsContext } from "../src/types.ts";

/** Return ffmpeg arguments WITHOUT the leading global options the app adds
 *  (-hide_banner -stats -progress pipe:1 -y). Must write to ctx.outputPath.
 *  Do not add -nostats: the live status message relies on ffmpeg's stats line. */
export function buildFfmpegArgs(ctx: FfmpegArgsContext): string[] {
  return ["-i", ctx.mainPath, "-c", "copy", ctx.outputPath];
}
