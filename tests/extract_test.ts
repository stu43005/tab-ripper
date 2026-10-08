import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { CdpClient } from "../src/cdp/client.ts";
import { CHUNK_SIZE, ExtractError, extractFromTab } from "../src/extract.ts";
import { FakeCdpServer } from "./helpers/fake_cdp.ts";
import {
  type FakePage,
  fakePage,
  type FakePageOptions,
} from "./helpers/fake_page.ts";
import { makeTempDir } from "./helpers/fixtures.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

interface Harness {
  page: FakePage;
  server: FakeCdpServer;
  client: CdpClient;
  dir: string;
  dispose(): Promise<void>;
}

async function harness(options: FakePageOptions = {}): Promise<Harness> {
  const page = fakePage(options);
  const server = new FakeCdpServer({ handler: page.handler });
  const client = await CdpClient.connect(server.wsUrl);
  const dir = await makeTempDir();
  return {
    page,
    server,
    client,
    dir,
    async dispose() {
      client.close();
      await server.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function patternBytes(length: number): Uint8Array {
  return new Uint8Array(length).map((_, i) => (i * 7) & 255);
}

Deno.test({
  name:
    "extractFromTab writes multi-chunk and empty files and reports progress",
  ...opts,
  fn: async () => {
    const main = patternBytes(CHUNK_SIZE * 2 + 123);
    const h = await harness({
      main,
      aux: new Uint8Array(),
      info: { title: "Clip", n: 2 },
    });
    try {
      const progress: [number, number][] = [];
      const result = await extractFromTab(
        h.client,
        "T1",
        h.dir,
        (r, t) => progress.push([r, t]),
      );
      assertEquals(result, {
        info: { title: "Clip", n: 2 },
        mainPath: join(h.dir, "main.bin"),
        auxPath: join(h.dir, "aux.bin"),
        mainSize: main.length,
        auxSize: 0,
      });
      assertEquals(await Deno.readFile(result.mainPath), main);
      assertEquals(await Deno.readFile(result.auxPath), new Uint8Array());
      assertEquals(progress[progress.length - 1], [main.length, main.length]);
      assertEquals(h.page.readTokens.length, 3);
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab surfaces a page exception message",
  ...opts,
  fn: async () => {
    const h = await harness({ wrapperException: "boom" });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "boom",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab reports the exception description unchanged",
  ...opts,
  fn: async () => {
    const h = await harness({ wrapperException: "line one\nline two" });
    try {
      const error = await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
      );
      assertEquals(
        (error as Error).message,
        "Error: line one\nline two\n    at <anonymous>:1:1",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab fails when the tab detaches after the last chunk",
  ...opts,
  fn: async () => {
    const h = await harness({ detachAfterLastRead: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "分頁已關閉或已中斷偵錯連線",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab fails when the connection drops after the last chunk",
  ...opts,
  fn: async () => {
    const h = await harness({ closeAfterLastRead: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "與瀏覽器的連線已中斷",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab fails when the connection drops while detaching",
  ...opts,
  fn: async () => {
    const h = await harness({ closeOnDetach: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "與瀏覽器的連線已中斷",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab reports a changed page URL",
  ...opts,
  fn: async () => {
    const h = await harness({
      wrapperException:
        "分頁網址已變更為 https://other.com/，不符合網址規則，請重新選擇分頁",
    });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "分頁網址已變更為 https://other.com/",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab fails fast on a dormant tab without sending the script",
  ...opts,
  fn: async () => {
    const h = await harness({ dormant: true });
    try {
      const start = Date.now();
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "分頁尚未載入（可能被瀏覽器休眠），請先在瀏覽器點開該分頁後再試一次",
      );
      assert(Date.now() - start < 7000);
      assertEquals(h.page.wrapperTokens.length, 0);
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab ends within 1s when the tab detaches during the script",
  ...opts,
  fn: async () => {
    const h = await harness({ detachDuringWrapper: true });
    try {
      const start = Date.now();
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "分頁已關閉或已中斷偵錯連線",
      );
      assert(Date.now() - start < 1000);
      assertEquals(
        h.server.requests.some((r) => r.method === "Target.detachFromTarget"),
        false,
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab reports lost page data",
  ...opts,
  fn: async () => {
    const h = await harness({ dropDataAfterWrapper: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "頁面資料遺失，分頁可能已重新載入",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab reports a dropped browser connection",
  ...opts,
  fn: async () => {
    const h = await harness({ closeDuringWrapper: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "與瀏覽器的連線已中斷",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab uses a fresh token per run and sends no page cleanup",
  ...opts,
  fn: async () => {
    const h = await harness();
    try {
      await extractFromTab(h.client, "T1", h.dir, () => {});
      await extractFromTab(h.client, "T1", h.dir, () => {});
      const [first, second] = h.page.wrapperTokens;
      assert(first !== second);
      assertEquals(h.page.readTokens, [first, first, second, second]);
      const evaluates = h.server.requests.filter((r) =>
        r.method === "Runtime.evaluate"
      );
      for (const request of evaluates) {
        const expression = String(request.params.expression);
        assert(
          expression === "1" || expression.startsWith("/*ffdl-wrapper:") ||
            expression.startsWith("/*ffdl-read:"),
          `unexpected page expression: ${expression.slice(0, 40)}`,
        );
      }
      assertEquals(
        h.server.requests[h.server.requests.length - 1].method,
        "Target.detachFromTarget",
      );
    } finally {
      await h.dispose();
    }
  },
});
