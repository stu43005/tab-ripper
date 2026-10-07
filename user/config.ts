/** Only tabs whose URL matches are listed. */
export const URL_PATTERN: RegExp = /^https:\/\/example\.com\//;

/** true: run ffprobe on the main file to get total duration (percentage progress).
 *  false: skip ffprobe; UI shows indeterminate progress with elapsed media time. */
export const PROBE_DURATION: boolean = true;
