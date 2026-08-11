import { useState } from "react";
import { useNetwork } from "../../config/NetworkContext";
import { DEFAULT_NETWORK, type NetworkConfig } from "../../config/network";
import { safeUserMessage } from "../../domain/errors/appError.ts";

export function DeveloperSettings() {
  const { config, update, reset } = useNetwork();
  const [draft, setDraft] = useState<NetworkConfig>(config);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const dirty = (Object.keys(draft) as (keyof NetworkConfig)[]).some(key => draft[key] !== config[key]);

  const field = (key: keyof NetworkConfig, label: string, hint: string, placeholder = "") =>
    <label className="field"><span>{label}</span>
      <input value={draft[key]} placeholder={placeholder} spellCheck={false} autoComplete="off"
        onChange={event => { setDraft({ ...draft, [key]: event.target.value }); setSaved(false); }} />
      <small className="form-note">{hint}</small>
    </label>;

  // A refused endpoint keeps the draft on screen. Replacing it with the public
  // default would undo the change the user came here to make, quietly.
  const save = () => {
    try {
      update(draft);
      setSaved(true);
      setError("");
    } catch (issue) {
      setSaved(false);
      setError(safeUserMessage(issue, "Endpoints could not be saved.", "configuration"));
    }
  };
  const restore = () => { reset(); setDraft(DEFAULT_NETWORK); setSaved(false); setError(""); };

  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Advanced</p><h1>Developer settings</h1><p>Infrastructure is replaceable and kept outside consumer flows. Changing it cannot grant account authority — the same passkey-signed operation is valid through any endpoint.</p></header>
    <section className="section-card form-stack">
      {field("rpcUrl", "RPC endpoint", "Reads balances and simulates transactions. Defaults to a public Sepolia node.", DEFAULT_NETWORK.rpcUrl)}
      {field("verificationRpcUrl", "Independent verification RPC", "Corroborates deployment bytecode and confirmed EntryPoint events. Keep it operated separately from the primary RPC.", DEFAULT_NETWORK.verificationRpcUrl)}
      {field("bundlerUrl", "Bundler endpoint", "Submits account operations. Defaults to Pimlico's public keyless bundler.", DEFAULT_NETWORK.bundlerUrl)}
      {field("explorerUrl", "Block explorer", "Builds transaction links.", DEFAULT_NETWORK.explorerUrl)}
      {field("relayUrl", "Optional sponsor relay", "Development-only endpoint for funding and deploying new accounts. Leave empty to disable.", "http://localhost:8787")}
      <div className="guardian-actions">
        <button className="primary" onClick={save} disabled={!dirty}>Save endpoints</button>
        <button className="secondary" onClick={restore}>Restore public defaults</button>
      </div>
      {error && <p className="callout warning">{error}</p>}
      {saved && <p className="callout success">Endpoints saved. They are used for the next balance read and transaction.</p>}
    </section>
    <p className="callout warning">Public endpoints are rate-limited and best-effort. For production use, point these at your own RPC, bundler, and explorer, and add authentication and monitoring to any sponsor relay you operate.</p>
  </div>;
}
