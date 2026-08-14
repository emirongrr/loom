import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWalletLabArtifact } from "./dist/index.js";

const uiRoot = fileURLToPath(new URL("./ui/", import.meta.url));
const mime = Object.freeze({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" });

function safeUiPath(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(uiRoot, relative));
  return resolved.startsWith(uiRoot) ? resolved : null;
}

export function createWalletLabServer({ artifactPath, host = "127.0.0.1", port = 4173 } = {}) {
  if (!artifactPath) throw new Error("wallet lab artifact path is required");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end("method not allowed");
      return;
    }
    if (url.pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "healthy", artifact: existsSync(artifactPath) ? "available" : "waiting" }));
      return;
    }
    if (url.pathname === "/api/run") {
      if (!existsSync(artifactPath)) {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      try {
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
        assertWalletLabArtifact(artifact);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(artifact));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "artifact-invalid", message: String(error?.message ?? error) }));
      }
      return;
    }

    const path = safeUiPath(url.pathname);
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  });

  return Object.freeze({
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      return { host, port: boundPort, url: `http://${host}:${boundPort}/` };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
