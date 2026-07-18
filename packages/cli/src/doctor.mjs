// Production-operation diagnostics for the `loom doctor` command.
//
// The doctor is an orchestrator: every substantive check delegates to an
// existing, tested primitive — manifest code-hash verification and the P-256
// precompile probe from @loom/deployment, account safety-state reads from
// @loom/sdk — and this module only sequences them, injects the transports, and
// normalizes the report. It is read-only: it never signs, sends, or mutates,
// and it never prints endpoint credentials (URLs are redacted to their origin).
//
// Every input is injected (an async `rpc(method, params)`, an optional bundler
// `rpc`, an optional sdk state transport) so the whole report is drivable with
// fakes in tests; the bin wires the real transports.

import { verifyManifestOnChain, probeP256Precompile } from "@loom/deployment";
import { readAccountSafetyState } from "@loom/sdk";

// EntryPoint.senderCreator() — the neutral address the EntryPoint calls initCode
// through; keccak256("senderCreator()")[:4].
const SENDER_CREATOR_SELECTOR = "0x09ccb880";

// Redact any credentials a transport URL may embed. Diagnostics must be safe to
// paste into a bug report, so only the origin (scheme + host + port) survives —
// userinfo, path, query, and fragment are dropped.
export function redactUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<redacted>";
  }
}

// Transport errors (e.g. undici's fetch failures) can embed the full endpoint
// URL, credentials and all, in their message. Every message that reaches a
// report field is scrubbed: any URL substring is reduced to its origin, so no
// userinfo, path, query, or fragment survives.
export function sanitizeMessage(message) {
  if (typeof message !== "string") return message;
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, match => redactUrl(match) ?? "<redacted>");
}

function check(name, status, detail, extra = {}) {
  return Object.freeze({ name, status, detail: sanitizeMessage(detail), ...extra });
}

async function codePresent(rpc, address) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  return typeof code === "string" && code !== "0x";
}

/**
 * Run the read-only production-operation diagnostics.
 *
 * @param {object} options
 * @param {(method: string, params: unknown[]) => Promise<any>} options.rpc  execution RPC (required)
 * @param {(method: string, params: unknown[]) => Promise<any>} [options.bundlerRpc]  bundler RPC
 * @param {object} [options.stateTransport]  an sdk state transport for the account check
 * @param {object} [options.manifest]  a canonical/app deployment manifest to verify on chain
 * @param {number} [options.chainId]  the chain the caller expects
 * @param {string} [options.entryPoint]  EntryPoint address (falls back to the manifest's)
 * @param {string} [options.account]  account to read safety state for
 * @param {string} [options.recoveryModule]  recovery module for the account check
 * @param {string} [options.altoVersion]  pinned bundler version, for the informational line
 * @returns {Promise<{ ok: boolean, checks: readonly object[] }>}
 */
export async function runDoctor(options = {}) {
  const rpc = options.rpc;
  if (typeof rpc !== "function") {
    throw Object.assign(new Error("doctor requires an rpc function"), { exitCode: 2 });
  }
  const checks = [];
  const entryPoint = options.entryPoint ?? options.manifest?.entryPoint?.address ?? null;

  // 1. Environment — informational, never a failure.
  checks.push(
    check("runtime", "ok", "process and pinned tool versions", {
      node: process.version,
      alto: options.altoVersion ?? null
    })
  );

  // 2. Chain reachability and identity.
  try {
    const chainIdHex = await rpc("eth_chainId", []);
    const observed = Number(BigInt(chainIdHex));
    if (options.chainId !== undefined && observed !== options.chainId) {
      checks.push(
        check("chain", "fail", "chain id does not match the expected value", {
          expected: options.chainId,
          observed
        })
      );
    } else {
      checks.push(check("chain", "ok", "chain is reachable", { chainId: observed }));
    }
  } catch (error) {
    checks.push(check("chain", "fail", `chain is unreachable: ${error.message}`));
  }

  // 3. Deployment component code hashes (delegated to the manifest verifier),
  //    or, without a manifest, at least that the EntryPoint has code.
  if (options.manifest !== undefined) {
    try {
      const result = await verifyManifestOnChain({ rpc, manifest: options.manifest });
      checks.push(
        check(result.ok ? "manifest" : "manifest", result.ok ? "ok" : "fail", result.ok ? "all component code hashes match" : "component code hashes do not match", {
          manifestHash: result.manifestHash,
          failures: result.failures.map(f => f.label)
        })
      );
    } catch (error) {
      checks.push(check("manifest", "fail", `manifest verification failed: ${error.message}`));
    }
  } else if (entryPoint) {
    const present = await codePresent(rpc, entryPoint).catch(() => false);
    checks.push(
      check("entryPoint", present ? "ok" : "fail", present ? "EntryPoint has code" : "EntryPoint has no code at the given address", { entryPoint })
    );
  } else {
    checks.push(check("manifest", "skip", "no manifest or EntryPoint address supplied"));
  }

  // 4. SenderCreator — the initCode-execution boundary — must exist. The
  //    EntryPoint reports its own SenderCreator; a missing one means the
  //    EntryPoint is not a real 4337 deployment.
  if (entryPoint) {
    try {
      const word = await rpc("eth_call", [{ to: entryPoint, data: SENDER_CREATOR_SELECTOR }, "latest"]);
      const senderCreator = typeof word === "string" && word.length >= 66 ? `0x${word.slice(26, 66)}` : null;
      if (!senderCreator || /^0x0+$/.test(senderCreator)) {
        checks.push(check("senderCreator", "fail", "EntryPoint reported no SenderCreator"));
      } else {
        const present = await codePresent(rpc, senderCreator);
        checks.push(
          check("senderCreator", present ? "ok" : "fail", present ? "SenderCreator has code" : "SenderCreator has no code", { senderCreator })
        );
      }
    } catch (error) {
      checks.push(check("senderCreator", "fail", `SenderCreator probe failed: ${error.message}`));
    }
  } else {
    checks.push(check("senderCreator", "skip", "no EntryPoint address to probe"));
  }

  // 5. Native P-256 precompile behaviour (accepts a valid signature, rejects a
  //    corrupted one). Delegated to the deployment probe.
  try {
    const p256 = await probeP256Precompile(rpc);
    checks.push(
      check("p256", p256.supported ? "ok" : "warn", p256.supported ? "native P-256 precompile verifies correctly" : "native P-256 precompile absent; a fallback verifier is required")
    );
  } catch (error) {
    checks.push(check("p256", "fail", `P-256 probe failed: ${error.message}`));
  }

  // 6. Bundler serves the EntryPoint the wallet will submit through.
  if (typeof options.bundlerRpc === "function") {
    try {
      const supported = await options.bundlerRpc("eth_supportedEntryPoints", []);
      const list = Array.isArray(supported) ? supported : [];
      const serves = entryPoint ? list.some(a => a.toLowerCase() === entryPoint.toLowerCase()) : list.length > 0;
      checks.push(
        check("bundler", serves ? "ok" : "fail", serves ? "bundler serves the EntryPoint" : "bundler does not serve the expected EntryPoint", {
          supportedEntryPoints: list
        })
      );
    } catch (error) {
      checks.push(check("bundler", "fail", `bundler is unreachable: ${error.message}`));
    }
  } else {
    checks.push(check("bundler", "skip", "no bundler URL supplied"));
  }

  // 7. Account safety state — freeze and pending high-risk operations an
  //    operator must know about before sending. Delegated to the sdk reader.
  if (options.account && options.stateTransport && options.chainId !== undefined) {
    try {
      const safety = await readAccountSafetyState({
        chainId: options.chainId,
        account: options.account,
        stateTransport: options.stateTransport,
        ...(options.recoveryModule ? { recoveryModule: options.recoveryModule } : {})
      });
      const warnings = safety.warnings ?? [];
      const frozen = safety.freeze?.active === true;
      checks.push(
        check("account", frozen || warnings.length > 0 ? "warn" : "ok", frozen ? "account is frozen" : warnings.length > 0 ? "account has advisories" : "account is operational", {
          status: safety.status,
          frozen,
          warnings
        })
      );
    } catch (error) {
      checks.push(check("account", "fail", `account safety read failed: ${error.message}`));
    }
  } else {
    checks.push(check("account", "skip", "no account (with chain id and state transport) supplied"));
  }

  // Privacy diagnostics are a separate, privacy-enabled concern; the base
  // doctor stays free of any privacy dependency.
  checks.push(check("privacy", "skip", "run `loom privacy doctor` when a privacy layer is configured"));

  const ok = !checks.some(entry => entry.status === "fail");
  return Object.freeze({ ok, checks: Object.freeze(checks) });
}
