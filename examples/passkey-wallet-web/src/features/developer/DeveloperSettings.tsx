import { useState } from "react";
import { useAppServices } from "../../app/AppServices";
import { InlineName } from "../../components/InlineName";
import type { AccountHandle } from "../../types";
import { useNetwork } from "../../config/NetworkContext";
import { DEFAULT_NETWORK, type NetworkConfig } from "../../config/network";
import { safeUserMessage } from "../../domain/errors/appError.ts";

export function DeveloperSettings({ account, onRenamed }: {
  readonly account: AccountHandle;
  readonly onRenamed: () => void;
}) {
  const { config, update, reset } = useNetwork();
  const services = useAppServices();
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
    {/* The storage caveat used to sit permanently above the guardian list.
        It is true, and it changes nothing a person can do about it -- so it
        belongs where someone comes looking for how the wallet works, not in
        front of the list they came to read. */}
    {/* Naming a wallet is configuring it, so it belongs with the other things
        you set rather than under a heading about the passkey. Local: nothing
        about the name is published, and the chain never sees it. */}
    <section className="section-card">
      <div className="section-heading"><div><p className="eyebrow">This wallet</p><h2>Name</h2></div></div>
      <InlineName
        label="Wallet name"
        value={account.label}
        placeholder="Everyday wallet"
        onSave={async name => {
          await services.accounts.save({ ...account, label: name });
          onRenamed();
        }}
      />
      <p className="form-note">Only you see it. Several wallets on one device are easier to tell apart by what they are for.</p>
    </section>

    {/* Moved out of wallet creation. It is a standing fact about this
        deployment rather than something the person choosing guardians decides,
        and it was the last thing they read before pressing the button. */}
    <section className="section-card">
      <div className="section-heading"><div><p className="eyebrow">Before real funds</p><h2>This deployment is not audited</h2></div></div>
      <p className="form-note">
        Verifier bytecode is rechecked through your configured RPC, but the deployment file does not yet pin audited
        code hashes. Check the deployment yourself before using this with money you cannot lose.
      </p>
    </section>

    <section className="section-card">
      <div className="section-heading"><div><p className="eyebrow">How this wallet stores things</p><h2>Local encryption</h2></div></div>
      <p className="form-note">
        Guardian capabilities and account handles are encrypted with a key held by this browser and never sent
        anywhere. That protects them from casual inspection of browser storage. It does not protect them from code
        running on this origin: a script injected into this page could use the same key.
      </p>
    </section>

    <section className="section-card form-stack">
      {field("rpcUrl", "RPC endpoint", "Reads balances and simulates transactions. Defaults to a public Sepolia node.", DEFAULT_NETWORK.rpcUrl)}
      {field("verificationRpcUrl", "Independent verification RPC", "Corroborates deployment bytecode and confirmed EntryPoint events. Keep it operated separately from the primary RPC.", DEFAULT_NETWORK.verificationRpcUrl)}
      {field("bundlerUrl", "Bundler endpoint", "Submits account operations. Defaults to Pimlico's public keyless bundler.", DEFAULT_NETWORK.bundlerUrl)}
      {field("explorerUrl", "Block explorer", "Builds transaction links.", DEFAULT_NETWORK.explorerUrl)}
      {field("relayUrl", "Optional sponsor service", "Authenticated paymaster authorization and private activation endpoint. Leave empty for self-funded onboarding.", "http://localhost:8787")}
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
