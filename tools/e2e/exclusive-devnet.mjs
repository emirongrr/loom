// Refuse to rehearse against a chain we did not start.
//
// Every rehearsal spawns its own anvil on a fixed port and then waits for the
// port to answer. If something else already holds that port -- another
// worktree's devnet, a wallet-lab session -- anvil exits immediately and the
// wait succeeds anyway, because the stranger answers. The rehearsal then
// deploys onto a chain with unknown state and reports whatever it finds there.
//
// That is the worst kind of failure: it looks like a finding. The run that
// prompted this printed "the recipient was not paid", which was true of the
// foreign chain and said nothing about the code under test. A rehearsal that
// cannot get its own chain must say so instead of guessing.
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * The port the rehearsal's own anvil should listen on.
 *
 * Taken from the same URL the rehearsal will talk to, so that overriding
 * DEVNET_RPC_URL moves both ends. Spawning on a fixed port while reading from
 * an overridden one is how a rehearsal ends up on a chain it did not start.
 */
export function devnetPort(url) {
  const port = new URL(url).port;
  if (!port) throw new Error(`devnet url must name a port: ${url}`);
  return port;
}

export async function whoIsServing(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: abort
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.result === "string" ? body.result : null;
  } catch {
    // Nothing listening, or not a JSON-RPC node. Either way the port is ours.
    return null;
  }
}

export function occupiedMessage(url, chainId) {
  return `${url} is already serving a chain (chainId ${chainId}).`
    + ` This rehearsal needs a devnet of its own: if it shared one, it would deploy onto unknown state`
    + ` and report that state as a result. Stop the other node, or point DEVNET_RPC_URL elsewhere.`;
}

/** Throws unless the devnet port is free. */
export async function requireExclusiveDevnet(url, options) {
  const chainId = await whoIsServing(url, options);
  if (chainId !== null) throw new Error(occupiedMessage(url, chainId));
}
