import { useEffect, useState } from "react";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import { loadWalletDeployment } from "../onboarding/accountLifecycle";
import { readAccountOperations, summarizeOperation, type AccountOperation } from "../wallet/userOperationHistory";
import type { AccountHandle } from "../../types";

/**
 * The account's own history, read from the EntryPoint.
 *
 * A block explorer indexes transactions, and a Loom account never sends one:
 * its work travels inside someone else's `handleOps`. So the explorer view
 * beside this one shows an account that looks idle no matter how much it has
 * done -- every recovery it published, every call it scheduled, every payment
 * it made is missing, and only plain transfers *to* it appear.
 *
 * This needs no indexer and no service. It is `eth_getLogs` against one
 * contract, filtered by sender.
 */
export function AccountOperations({ account }: { readonly account: AccountHandle }) {
  const { config } = useNetwork();
  const { publicClients } = useAppServices();
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly reason: string }
    | {
      readonly kind: "ready";
      readonly operations: readonly AccountOperation[];
      readonly complete: boolean;
      readonly scannedFromBlock: bigint;
    }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const deployment = await loadWalletDeployment();
        const scan = await readAccountOperations({
          publicClient: publicClients.forEndpoint(config.rpcUrl) as never,
          account: account.account,
          deployment
        });
        if (!cancelled) setState({ kind: "ready", ...scan });
      } catch (error) {
        if (!cancelled) {
          setState({ kind: "failed", reason: error instanceof Error ? error.message.slice(0, 200) : "The EntryPoint could not be read." });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [account.account, config.rpcUrl, publicClients]);

  return <section className="section-card" aria-labelledby="account-operations-title">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Read from the EntryPoint, not an index</p>
        <h2 id="account-operations-title">What this account did</h2>
      </div>
      {state.kind === "ready" && <span className="pill">{state.operations.length}</span>}
    </div>

    <p className="form-note">
      A Loom account never sends a transaction of its own — its work travels inside someone else's bundle, which is
      why a block explorer shows it as idle. These come from the EntryPoint's own log, so they are the account's
      actual history.
    </p>

    {state.kind === "loading" && <p className="form-note">Reading the EntryPoint…</p>}

    {state.kind === "failed" && <p className="callout warning">
      The EntryPoint log could not be read, so this is unknown rather than empty: {state.reason}
    </p>}

    {state.kind === "ready" && state.operations.length === 0 && <div className="empty-state compact">
      <h3>Nothing in the scanned range</h3>
      <p>
        {state.complete
          ? "This account has never had an operation included."
          : `No operation was found back to block ${state.scannedFromBlock}. The scan is bounded, so older ones may exist.`}
      </p>
    </div>}

    {state.kind === "ready" && state.operations.length > 0 && <div className="recovery-request-list">
      {state.operations.map(operation => <article key={operation.userOpHash} className="recovery-request">
        <header>
          <strong>{summarizeOperation(operation)}</strong>
          <span className={operation.succeeded ? "pill included" : "pill failed"}>
            {operation.succeeded ? "succeeded" : "reverted"}
          </span>
        </header>
        <p className="breakable form-note">
          Block {String(operation.blockNumber)} · nonce {String(operation.nonce)} · {operation.transactionHash}
        </p>
      </article>)}
      {!state.complete && <p className="form-note">
        Scanned back to block {String(state.scannedFromBlock)} only. Anything older is not shown, and not ruled out.
      </p>}
    </div>}
  </section>;
}
