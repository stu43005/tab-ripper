import type { CdpClient } from "./cdp/client.ts";
import type { TabInfo } from "./types.ts";

/** A copy without g/y so `test()` never depends on lastIndex. */
export function statelessPattern(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.replace("g", "").replace("y", ""),
  );
}

interface RawTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

/** Page targets whose URL matches `pattern`, in CDP order. */
export async function listTabs(
  client: CdpClient,
  pattern: RegExp,
): Promise<TabInfo[]> {
  const re = statelessPattern(pattern);
  const { targetInfos } = await client.send<{ targetInfos: RawTargetInfo[] }>(
    "Target.getTargets",
  );
  return targetInfos
    .filter((target) => target.type === "page" && re.test(target.url))
    .map(({ targetId, title, url }) => ({ targetId, title, url }));
}
