import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWalletLabArtifact } from "./dist/index.js";
import { broadcastLocalDeploymentCall, inspectDeploymentTransaction, simulateDeploymentCall } from "./execution-engine.mjs";
import { createJsonRpc, inspectSepoliaDeployment, rpcEndpointOrigin } from "./sepolia-deployment.mjs";

const uiRoot = fileURLToPath(new URL("./ui/", import.meta.url));
const mime = Object.freeze({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" });
const MAX_CONTROL_BODY_BYTES = 32_768;
const LOCAL_CHAIN_ID = 31337;
const LOCAL_TEST_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const PUBLIC_SEPOLIA_RPC_PROVIDERS = Object.freeze([
  Object.freeze({ id: "publicnode", label: "PublicNode", endpoint: "https://ethereum-sepolia-rpc.publicnode.com" }),
  Object.freeze({ id: "drpc", label: "dRPC public", endpoint: "https://sepolia.drpc.org" })
]);

function safeUiPath(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(uiRoot, relative));
  return resolved.startsWith(uiRoot) ? resolved : null;
}

async function readControlBody(request) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new Error("JSON content type is required");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_CONTROL_BODY_BYTES) throw new Error("Control request is too large");
  }
  return JSON.parse(body);
}

export function createWalletLabServer({ artifactPath, host = "127.0.0.1", port = 4173, localExecution, sepolia, sepoliaProfile, sepoliaProviders = PUBLIC_SEPOLIA_RPC_PROVIDERS } = {}) {
  if (!artifactPath) throw new Error("wallet lab artifact path is required");
  const profile = sepoliaProfile ?? (sepolia ? { repoRoot: sepolia.repoRoot, manifest: sepolia.manifest } : null);
  const providers = sepoliaProviders.map(provider => Object.freeze({ ...provider, origin: rpcEndpointOrigin(provider.endpoint) }));
  let activeSepolia = sepolia;
  let sepoliaInspection;
  const local = localExecution ?? null;
  const readArtifact = () => {
    if (!existsSync(artifactPath)) throw new Error("Wallet Lab run evidence is not available");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    assertWalletLabArtifact(artifact);
    return artifact;
  };
  const localDeployment = () => {
    const artifact = readArtifact();
    const deployment = [...(artifact.events ?? [])].reverse().find(event => event.phase === "deployment")?.payload?.deployment;
    if (!deployment?.nodes?.length) throw new Error("Local deployment evidence is not available");
    return deployment;
  };
  const inspectSepolia = () => {
    if (!sepoliaInspection) {
      sepoliaInspection = inspectSepoliaDeployment(activeSepolia).catch(error => {
        sepoliaInspection = undefined;
        throw error;
      });
    }
    return sepoliaInspection;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    const controlOriginAllowed = () => {
      const origin = request.headers.origin;
      return !origin || origin === `http://${host}:${server.address()?.port ?? port}`;
    };
    const writeJson = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
    };

    if (["/api/execution/simulate", "/api/execution/local", "/api/execution/sepolia/inspect"].includes(url.pathname)) {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end(JSON.stringify({ status: "error", message: "POST is required." }));
        return;
      }
      if (!controlOriginAllowed()) {
        writeJson(403, { status: "error", message: "Cross-origin control requests are not allowed." });
        return;
      }
      try {
        const body = await readControlBody(request);
        if (url.pathname === "/api/execution/sepolia/inspect") {
          const report = await inspectSepolia();
          if (report.status !== "verified") throw new Error("Sepolia deployment must be verified before inspecting a transaction");
          const result = await inspectDeploymentTransaction({ rpc: activeSepolia.rpc, deployment: report.deployment, chainId: report.chainId, contractId: body.contractId, selector: body.selector, transactionHash: body.transactionHash });
          writeJson(200, result);
          return;
        }
        const network = body.network;
        let context;
        if (network === "local") {
          if (!local?.rpc) throw new Error("Local devnet execution is unavailable; start Wallet Lab with wallet-lab:run");
          context = { rpc: local.rpc, deployment: localDeployment(), chainId: local.chainId ?? LOCAL_CHAIN_ID };
        } else if (network === "sepolia") {
          const report = await inspectSepolia();
          if (report.status !== "verified") throw new Error("Sepolia deployment must be verified before simulation");
          context = { rpc: activeSepolia.rpc, deployment: report.deployment, chainId: report.chainId };
        } else {
          throw new Error("Execution network must be local or sepolia");
        }
        const input = { ...context, contractId: body.contractId, selector: body.selector, args: body.args, valueWei: body.valueWei, from: body.from };
        if (url.pathname === "/api/execution/local") {
          if (network !== "local") throw new Error("Local broadcast cannot target Sepolia");
          const result = await broadcastLocalDeploymentCall({ ...input, sender: local.sender ?? LOCAL_TEST_SENDER });
          writeJson(200, result);
          return;
        }
        writeJson(200, await simulateDeploymentCall(input));
      } catch (error) {
        writeJson(400, { status: "error", code: "EXECUTION_REQUEST_REJECTED", message: String(error?.message ?? "Execution request was rejected") });
      }
      return;
    }

    if (url.pathname === "/api/deployments/sepolia/connect") {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end(JSON.stringify({ status: "error", message: "POST is required." }));
        return;
      }
      if (!controlOriginAllowed()) {
        response.writeHead(403);
        response.end(JSON.stringify({ status: "error", message: "Cross-origin control requests are not allowed." }));
        return;
      }
      try {
        const body = await readControlBody(request);
        const provider = providers.find(candidate => candidate.id === body.provider);
        if (!profile || !provider) {
          response.writeHead(400);
          response.end(JSON.stringify({ status: "error", message: "Select one of the published Sepolia RPC presets." }));
          return;
        }
        activeSepolia = { ...profile, rpc: createJsonRpc(provider.endpoint), endpointOrigin: provider.origin };
        sepoliaInspection = undefined;
        const report = await inspectSepolia();
        response.writeHead(200);
        response.end(JSON.stringify(report));
      } catch {
        response.writeHead(502);
        response.end(JSON.stringify({ status: "unavailable", message: "Sepolia deployment verification could not be completed." }));
      }
      return;
    }

    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end("method not allowed");
      return;
    }
    if (url.pathname === "/api/deployments/sepolia/providers") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ providers: providers.map(({ id, label, origin }) => ({ id, label, origin })) }));
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
        const artifact = readArtifact();
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(artifact));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "artifact-invalid", message: String(error?.message ?? error) }));
      }
      return;
    }
    if (url.pathname === "/api/deployments/sepolia") {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      if (!activeSepolia) {
        response.writeHead(503);
        response.end(JSON.stringify({ status: "unavailable", message: "Sepolia deployment is not configured." }));
        return;
      }
      try {
        response.writeHead(200);
        response.end(JSON.stringify(await inspectSepolia()));
      } catch {
        response.writeHead(502);
        response.end(JSON.stringify({ status: "unavailable", message: "Sepolia deployment verification could not be completed." }));
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
