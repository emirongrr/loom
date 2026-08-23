import { useEffect, useState } from "react";
import { parseAbi } from "viem";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import { loadWalletDeployment } from "../onboarding/accountLifecycle";
import { describePendingRecovery, type PendingRecoveryNotice } from "./pendingRecoveryWarning";
import type { AccountHandle } from "../../types";

const MANAGER = parseAbi([
  "function pendingRecoveries(address) view returns (bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint48 readyAt, uint48 expiresAt, uint64 configVersion, uint64 nonce)"
]);
const ACCOUNT = parseAbi(["function guardianThreshold() view returns (uint256)"]);

/**
 * Tell the owner when someone is recovering their account.
 *
 * A recovery replaces every validator on the account, and the owner is the one
 * person who can say whether it is theirs. Without this, the first sign would
 * be the account no longer answering to their key -- after the delay had run
 * and the window had opened, with nothing left to do about it.
 *
 * Read on the wallet's own screen rather than filed under settings, because the
 * cost of missing it is the account.
 */
export function PendingRecoveryBanner({ account, onStop }: {
  readonly account: AccountHandle;
  /** Where the reader goes next. Without this the warning led nowhere. */
  readonly onStop?: () => void;
}) {
  const { config } = useNetwork();
  const { publicClients } = useAppServices();
  const [notice, setNotice] = useState<PendingRecoveryNotice>({ kind: "none" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const deployment = await loadWalletDeployment();
        if (!deployment.recoveryModule || deployment.chainId !== account.chainId) return;
        const client = publicClients.forEndpoint(config.rpcUrl);
        const [pending, threshold, block] = await Promise.all([
          client.readContract({ address: deployment.recoveryModule, abi: MANAGER, functionName: "pendingRecoveries", args: [account.account] }),
          client.readContract({ address: account.account, abi: ACCOUNT, functionName: "guardianThreshold" }).catch(() => 1n),
          client.getBlock()
        ]);
        const record = pending as readonly unknown[];
        if (cancelled) return;
        setNotice(describePendingRecovery({
          pending: Number(record[5]) !== 0,
          newValidator: record[1] as `0x${string}`,
          readyAt: BigInt(record[5] as number),
          expiresAt: BigInt(record[6] as number),
          guardianThreshold: Number(threshold),
          // The chain's clock, not the device's: a wrong local clock would
          // report a recovery as still delayed when it is already executable.
          nowSeconds: block.timestamp
        }));
      } catch { /* Unreadable is not "nothing pending", but nor is it a claim. */ }
    })();
    return () => { cancelled = true; };
  }, [account.account, account.chainId, config.rpcUrl, publicClients]);

  if (notice.kind === "none") return null;

  return <div className={notice.urgency === "delay" ? "callout warning" : "callout danger"} role="alert">
    <strong>{notice.headline}</strong>
    <p>{notice.detail}</p>
    <p className="form-note">{notice.cancellation}</p>
    {onStop ? <div className="guardian-actions">
      <button className={notice.urgency === "delay" ? "secondary" : "primary"} onClick={onStop}>
        See when it happens, and how to stop it
      </button>
    </div> : null}
  </div>;
}
