import indexHtml from "../ui/index.html" with { type: "text" };
import appJs from "../ui/app.js" with { type: "text" };
import styleCss from "../ui/style.css" with { type: "text" };

// A Map, not a plain object: paths like /constructor must not resolve to
// inherited properties.
export const UI_ASSETS = new Map<string, { body: string; contentType: string }>(
  [
    ["/", { body: indexHtml, contentType: "text/html; charset=utf-8" }],
    ["/app.js", { body: appJs, contentType: "text/javascript; charset=utf-8" }],
    ["/style.css", { body: styleCss, contentType: "text/css; charset=utf-8" }],
  ],
);

/** Serves `/`, `/app.js`, `/style.css`; everything else is 404. */
export function serveUi(request: Request): Response {
  const asset = UI_ASSETS.get(new URL(request.url).pathname);
  if (!asset) return new Response("Not Found", { status: 404 });
  return new Response(asset.body, {
    headers: { "content-type": asset.contentType },
  });
}
