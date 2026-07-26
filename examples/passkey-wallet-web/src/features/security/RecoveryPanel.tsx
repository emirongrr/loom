import { useReducer } from "react";
import { initialRecoveryState, recoveryReducer } from "../recovery/reducer";

export function RecoveryPanel() {
  const [state, dispatch] = useReducer(recoveryReducer, initialRecoveryState);
  const code = "Unavailable until a live adapter supplies the exact proposal digest";
  const start = () => { dispatch({ type: "LOAD_ACCOUNT" }); queueMicrotask(() => dispatch({ type: "CREATE_PASSKEY" })); };
  return <section className="section-card recovery-panel">
    <div className="section-heading"><div><p className="eyebrow">Dedicated recovery entry point</p><h2>Recover an existing account</h2></div><span className="pill">{state.status.replaceAll("-", " ")}</span></div>
    {state.status === "idle" && <><p>Verify the account and its current guardian root, create a new passkey, then collect approvals off chain.</p><button className="primary" onClick={start}>Start recovery</button></>}
    {state.status === "creating-passkey" && <div className="step-card"><span>1</span><div><strong>Create the replacement passkey</strong><p>The private credential stays in this device authenticator.</p></div><button onClick={() => dispatch({ type: "COLLECT", have: 0, need: 2, authenticationCode: code })}>Create passkey</button></div>}
    {state.status === "collecting-approvals" && <>
      <div className="progress"><div style={{ width: `${state.have / state.need * 100}%` }} /></div><strong>{state.have} of {state.need} guardians verified</strong>
      <p className="auth-code"><span>Compare through a trusted channel</span>{state.authenticationCode}</p>
      <p className="callout warning">This illustrative flow has no live proposal digest, so it does not claim an authenticated comparison code.</p>
      <p>Each encrypted approval is verified locally before it counts. No raw digest or signature is shown.</p>
      <button onClick={() => state.have + 1 >= state.need ? (dispatch({ type: "COLLECT", have: state.need, need: state.need, authenticationCode: code }), queueMicrotask(() => dispatch({ type: "READY", authenticationCode: code }))) : dispatch({ type: "COLLECT", have: state.have + 1, need: state.need, authenticationCode: code })}>Simulate encrypted approval arrival</button>
    </>}
    {state.status === "ready-to-propose" && <><p className="callout">Quorum reached. One replaceable submitter can publish the exact threshold-approved proposal.</p><button className="primary" onClick={() => { dispatch({ type: "PROPOSING" }); queueMicrotask(() => dispatch({ type: "PROPOSED", readyAt: 1_900_259_200n, expiresAt: 1_900_864_000n })); }}>Propose recovery</button></>}
    {state.status === "delay-active" && <><Timeline readyAt={state.readyAt} expiresAt={state.expiresAt} /><button className="danger-button" onClick={() => dispatch({ type: "CANCEL" })}>Cancel recovery</button><button onClick={() => dispatch({ type: "TICK", now: state.readyAt })}>Advance demo to ready</button></>}
    {state.status === "ready-to-execute" && <><Timeline readyAt={0n} expiresAt={state.expiresAt} /><p>Anyone may execute now; the executor receives no account authority.</p><button className="primary" onClick={() => dispatch({ type: "EXECUTE" })}>Execute recovery</button></>}
    {state.status === "executing" && <button onClick={() => dispatch({ type: "COMPLETE", account: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" })}>Confirm inclusion</button>}
    {state.status === "complete" && <p className="callout success">Recovery complete. The same account address now uses the new passkey; old validators are removed and the guardian root rotated.</p>}
    {(state.status === "cancelled" || state.status === "expired") && <><p className="callout warning">Recovery {state.status}. Collected approvals are stale and cannot be replayed.</p><button onClick={() => dispatch({ type: "RESET" })}>Start over</button></>}
  </section>;
}

function Timeline({ readyAt, expiresAt }: { readyAt: bigint; expiresAt: bigint }) {
  return <div className="security-timeline"><div className="done"><span>✓</span><strong>Proposed</strong></div><div className={readyAt === 0n ? "done" : "active"}><span>2</span><strong>3-day delay</strong></div><div><span>3</span><strong>Execute before {formatTimestamp(expiresAt)}</strong></div></div>;
}

function formatTimestamp(timestamp: bigint): string {
  const milliseconds = timestamp * 1_000n;
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(Number(milliseconds)))
    : "the on-chain expiry";
}
