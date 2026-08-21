import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import type { AccountHandle } from "../../types";

/**
 * Which wallet pays for a permissionless step, and whether it can.
 *
 * A bare select asked the reader to choose between labels. The thing that
 * decides whether a choice works is the balance, and not showing it meant the
 * only way to discover an empty wallet was a transaction that failed for
 * reasons the wallet could not explain.
 *
 * One candidate is not a choice, so it is stated rather than offered: a select
 * with a single option is a decision the reader cannot make.
 */
export function GasPayerChoice({ label, candidates, selected, disabled, onSelect }: {
  readonly label: string;
  readonly candidates: readonly AccountHandle[];
  readonly selected: AccountHandle | undefined;
  readonly disabled?: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const { config } = useNetwork();
  const { publicClients } = useAppServices();
  const [balances, setBalances] = useState<Readonly<Record<string, bigint>>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const client = publicClients.forEndpoint(config.rpcUrl);
      const found: Record<string, bigint> = {};
      for (const candidate of candidates) {
        try { found[candidate.id] = await client.getBalance({ address: candidate.account }); }
        catch { /* A balance that will not load is reported as unknown, not as zero. */ }
      }
      if (!cancelled) setBalances(Object.freeze(found));
    })();
    return () => { cancelled = true; };
  }, [candidates, config.rpcUrl, publicClients]);

  const describe = (candidate: AccountHandle): string => {
    const balance = balances[candidate.id];
    const funds = balance === undefined ? "balance unknown" : `${trim(formatEther(balance))} ETH`;
    return `${candidate.label} · ${short(candidate.account)} · ${funds}`;
  };

  if (candidates.length === 0) return null;

  const empty = selected && balances[selected.id] === 0n;

  return <div className="gas-payer-choice">
    {candidates.length === 1
      ? <p className="form-note"><strong>{label}:</strong> {describe(candidates[0]!)}</p>
      : <label className="field">
        <span>{label}</span>
        <select value={selected?.id ?? ""} disabled={disabled} onChange={event => onSelect(event.target.value)}>
          {candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{describe(candidate)}</option>)}
        </select>
      </label>}
    {empty && <p className="callout warning">
      That wallet holds nothing, so it cannot pay for this. Fund it, or choose another.
    </p>}
    <p className="form-note">
      It pays the network fee and gains nothing: this step grants no authority over the account being recovered,
      to anyone, including whoever pays for it.
    </p>
  </div>;
}

const short = (value: string): string => `${value.slice(0, 6)}…${value.slice(-4)}`;

/** Enough digits to tell empty from funded, without a wall of zeroes. */
function trim(value: string): string {
  if (!value.includes(".")) return value;
  const [whole, fraction = ""] = value.split(".");
  const shown = fraction.slice(0, 5).replace(/0+$/u, "");
  return shown.length > 0 ? `${whole}.${shown}` : whole!;
}
