import { useEffect, useState } from "react";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import { loadWalletDeployment } from "../onboarding/accountLifecycle";
import { operationRow, readAccountOperations, type AccountOperation } from "../wallet/userOperationHistory";
import { transactionUrl } from "../../config/network";
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

  return <>
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

    {/* The same row shape the transaction list uses. These are the account's
        own history and those are transfers an index saw; showing them in two
        different formats made them look like two different kinds of fact. */}
    {state.kind === "ready" && state.operations.length > 0 && <>
      <div className="timeline">
        {state.operations.map(operation => {
          const row = operationRow(operation);
          return <article key={operation.userOpHash} className="timeline-item">
            <span className={`timeline-dot ${operation.succeeded ? "finalized" : "failed"}`} aria-hidden="true" />
            <div>
              <strong>{row.title}</strong>
              <p>{row.detail}</p>
            </div>
            <div className="timeline-side">
              <strong>{row.fee}</strong>
              <span className={operation.succeeded ? "pill finalized" : "pill failed"}>
                {operation.succeeded ? "succeeded" : "reverted"}
              </span>
              <a className="text-button" href={transactionUrl(config, operation.transactionHash)} target="_blank" rel="noreferrer noopener">Explorer</a>
            </div>
          </article>;
        })}
      </div>
      {!state.complete && <p className="form-note">
        Scanned back to block {String(state.scannedFromBlock)}. Older operations are not shown, and not ruled out.
      </p>}
    </>}
  </>;
}
