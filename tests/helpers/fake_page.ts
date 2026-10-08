import { encodeBase64 } from "../../src/base64.ts";
import {
  type CdpRequest,
  type FakeConnection,
  reply,
  replyException,
} from "./fake_cdp.ts";

export interface FakeTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface FakePageOptions {
  main?: Uint8Array;
  aux?: Uint8Array;
  info?: Record<string, unknown>;
  targets?: FakeTarget[];
  /** Never answer Runtime.evaluate (a discarded tab). */
  dormant?: boolean;
  /** Answer the wrapper with a page exception carrying this message. */
  wrapperException?: string;
  /** Never answer the wrapper. */
  hangWrapper?: boolean;
  /** Emit Target.detachedFromTarget instead of answering the wrapper. */
  detachDuringWrapper?: boolean;
  /** Close the socket when the wrapper arrives. */
  closeDuringWrapper?: boolean;
  /** Answer the wrapper but lose the stored data (page reloaded). */
  dropDataAfterWrapper?: boolean;
  /** Emit Target.detachedFromTarget right after answering the last chunk read. */
  detachAfterLastRead?: boolean;
  /** Close the socket right after answering the last chunk read. */
  closeAfterLastRead?: boolean;
  /** Close the socket instead of answering Target.detachFromTarget. */
  closeOnDetach?: boolean;
}

export interface FakePage {
  handler: (request: CdpRequest, connection: FakeConnection) => void;
  wrapperTokens: string[];
  readTokens: string[];
}

export const DEFAULT_TARGETS: FakeTarget[] = [
  {
    targetId: "T1",
    type: "page",
    title: "Clip page",
    url: "https://example.com/watch/1",
  },
  {
    targetId: "T2",
    type: "page",
    title: "Elsewhere",
    url: "https://other.com/",
  },
];

export function fakePage(options: FakePageOptions = {}): FakePage {
  const main = options.main ?? new Uint8Array([1, 2, 3]);
  const aux = options.aux ?? new Uint8Array([9]);
  const info = options.info ?? { title: "Clip" };
  const store = new Map<string, { main: Uint8Array; aux: Uint8Array }>();
  const page: FakePage = {
    wrapperTokens: [],
    readTokens: [],
    handler: () => {},
  };
  let attachCount = 0;

  page.handler = (request, connection) => {
    switch (request.method) {
      case "Target.getTargets":
        reply(connection, request, {
          targetInfos: options.targets ?? DEFAULT_TARGETS,
        });
        return;
      case "Target.attachToTarget":
        // A fresh session per attach, like a real browser.
        attachCount++;
        reply(connection, request, {
          sessionId: `session-${
            String(request.params.targetId)
          }-${attachCount}`,
        });
        return;
      case "Target.detachFromTarget":
        if (options.closeOnDetach) {
          connection.close();
          return;
        }
        reply(connection, request, {});
        connection.send({
          method: "Target.detachedFromTarget",
          params: { sessionId: request.params.sessionId },
        });
        return;
      case "Runtime.evaluate":
        break;
      default:
        reply(connection, request, {});
        return;
    }
    if (options.dormant) return;
    const expression = String(request.params.expression);
    if (expression === "1") {
      reply(connection, request, {
        result: { type: "number", value: 1, description: "1" },
      });
      return;
    }
    const wrapper = /^\/\*ffdl-wrapper:(.*?)\*\//.exec(expression);
    if (wrapper) {
      const { token } = JSON.parse(wrapper[1]) as { token: string };
      page.wrapperTokens.push(token);
      if (options.hangWrapper) return;
      if (options.closeDuringWrapper) {
        connection.close();
        return;
      }
      if (options.detachDuringWrapper) {
        connection.send({
          method: "Target.detachedFromTarget",
          params: { sessionId: request.sessionId },
        });
        return;
      }
      if (options.wrapperException) {
        replyException(connection, request, options.wrapperException);
        return;
      }
      if (!options.dropDataAfterWrapper) store.set(token, { main, aux });
      reply(connection, request, {
        result: {
          type: "object",
          value: { info, sizes: { main: main.length, aux: aux.length } },
        },
      });
      return;
    }
    const read = /^\/\*ffdl-read:(.*?)\*\//.exec(expression);
    if (read) {
      const { token, name, offset, length } = JSON.parse(read[1]) as {
        token: string;
        name: "main" | "aux";
        offset: number;
        length: number;
      };
      page.readTokens.push(token);
      const entry = store.get(token);
      if (!entry) {
        replyException(connection, request, "FFDL_MISSING");
        return;
      }
      reply(connection, request, {
        result: {
          type: "string",
          value: encodeBase64(entry[name].subarray(offset, offset + length)),
        },
      });
      const isLastRead = name === "aux"
        ? offset + length >= aux.length
        : (aux.length === 0 && offset + length >= main.length);
      if (isLastRead && options.detachAfterLastRead) {
        connection.send({
          method: "Target.detachedFromTarget",
          params: { sessionId: request.sessionId },
        });
      }
      if (isLastRead && options.closeAfterLastRead) connection.close();
      return;
    }
    reply(connection, request, { result: { type: "undefined" } });
  };
  return page;
}
