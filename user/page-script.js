/**
 * Runs INSIDE the selected browser tab. Must be self-contained:
 * it is serialized with Function.prototype.toString(), so it cannot
 * reference imports or variables outside its own body.
 * @returns {Promise<{ main: ArrayBuffer | ArrayBufferView,
 *                     aux: ArrayBuffer | ArrayBufferView,
 *                     info: Record<string, string | number | boolean> }>}
 */
// deno-lint-ignore require-await
export default async function pageScript() {
  function* getAllHookFiber(dom) {
    const key = Object.keys(dom).find(k =>
      k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (!key) throw new Error("no fiber on node (isolated world / wrong node?)");

    for (let f = dom[key], depth = 0; f; f = f.return, depth++) {
      // Only these tags own hooks: function(0), forwardRef(11), simple memo(15)
      if (![0, 11, 15].includes(f.tag)) continue;
      yield f;
    }
  }

  function getRefs(fiber) {
    const refs = [];
    for (let hook = fiber.memoizedState, i = 0; hook; hook = hook.next, i++) {
      const s = hook.memoizedState;
      // useRef: no update queue, state is a plain object whose only key is "current"
      if (hook.queue === null && s && typeof s === "object" && !Array.isArray(s) &&
          Object.keys(s).length === 1 && "current" in s) {
        refs.push({ hookIndex: i, ref: s });
      }
    }
    return refs;
  }

  const dom = document.querySelector("div[class*='VideoPlayer_videoWrapper");

  let hls, info;
  for (const fiber of getAllHookFiber(dom)) {
    const refs = getRefs(fiber);
    for (const r of refs) {
      const current = r.ref.current;
      if (current && typeof current === "object" && "userConfig" in current) {
        hls = current;
      }
      else if (current && typeof current === "object" && "displayName" in current && "description" in current) {
        info = current;
      }
    }
  }
  if (!hls) {
    throw new Error("Can't find HLS.js");
  }
  if (!info) {
    throw new Error("Can't find information");
  }

  const key = hls.streamController.keyLoader.keyUriToKeyInfo["irvine://aes"].decryptdata.key;
  const playlistUrl = hls.levelController.currentLevel.details.url;
  let m3u8 = hls.levelController.currentLevel.details.m3u8;
  m3u8 = m3u8.replaceAll("irvine://aes", "aux.bin");
  m3u8 = m3u8.replace(
    /^([^#\r\n][^\r\n]*)$/gm,
    (line, uriLine) => {
      return new URL(uriLine, playlistUrl).href;
    }
  );

  const {
    width,
    height,
    bitrate,
    frameRate,
    videoCodec,
    audioCodec,
  } = hls.levelController.currentLevel;
  const utf8encoder = new TextEncoder();
  return {
    main: utf8encoder.encode(m3u8),
    aux: key.buffer,
    info: {
      title: info.displayName,
      playlistUrl: playlistUrl,
      aesKey: new Uint8Array(key).toHex(),
      resolution: `${width}x${height}`,
      bitrate: bitrate,
      frameRate: frameRate,
      videoCodec: videoCodec,
      audioCodec: audioCodec,
    }
  };
}
