import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.WEBAUTHN_COLLECTOR_PORT ?? 8788);

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"]
]);

function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://localhost:${port}`).pathname);
  const candidate = normalize(join(root, pathname));
  if (!candidate.startsWith(root)) throw new Error("path traversal");
  return candidate;
}

createServer((request, response) => {
  try {
    const path = resolvePath(request.url ?? "/");
    if (!statSync(path).isFile()) throw new Error("not found");
    response.writeHead(200, {
      "content-type": types.get(extname(path)) ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
    response.end("not found");
  }
}).listen(port, "localhost", () => {
  console.log(`WebAuthn fixture collector: http://localhost:${port}/tools/webauthn-fixture/collector.html`);
});
