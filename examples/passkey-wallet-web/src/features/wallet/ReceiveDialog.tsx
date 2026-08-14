import { useMemo, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { AdvancedDetails } from "../../components/StatusPanel";
import { createQrGeometry } from "../../components/qrCode";
import { createReceiveTarget } from "./receiveTarget";

/**
 * One interaction from the home screen to a scannable code and a copy action.
 *
 * The address is rendered in full and checksummed rather than truncated: a
 * sender comparing what they pasted needs every character, and truncation is
 * exactly what address-poisoning relies on.
 */
export function ReceiveDialog({ address, chainId, deployed, onClose }: {
  readonly address: string;
  readonly chainId: number;
  readonly deployed: boolean;
  readonly onClose: () => void;
}) {
  const [status, setStatus] = useState("");
  const target = useMemo(() => {
    try { return createReceiveTarget({ address, chainId, deployed }); }
    catch { return null; }
  }, [address, chainId, deployed]);
  const qr = useMemo(() => (target ? createQrGeometry(target.qrPayload) : null), [target]);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  if (!target) {
    return <Dialog label="Receive" onClose={onClose}>
      <div className="sheet-handle" aria-hidden="true" />
      <h2>Receive</h2>
      <p className="callout warning">This wallet has no usable receive address on this network.</p>
      <div className="sheet-actions"><span /><button className="secondary" onClick={onClose}>Close</button></div>
    </Dialog>;
  }

  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setStatus(`${label} copied.`); }
    catch { setStatus("Clipboard access is unavailable. Select the address and copy it manually."); }
  };

  const share = async () => {
    try { await navigator.share({ title: "My Loom address", text: target.address }); }
    catch { /* A dismissed share sheet is an ordinary outcome, not an error. */ }
  };

  return <Dialog label="Receive" onClose={onClose}>
    <div className="sheet-handle" aria-hidden="true" />
    <div className="section-heading"><div><p className="eyebrow">{target.chainLabel} · chain {target.chainId}</p><h2>Receive</h2></div></div>

    <div className="receive-qr">
      {qr
        ? <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`QR code for ${target.address}`} shapeRendering="crispEdges">
            <rect width={qr.size} height={qr.size} fill="#ffffff" />
            <path d={qr.path} fill="#000000" />
          </svg>
        : <p className="form-note">A QR code could not be drawn. Use the address below.</p>}
    </div>

    <p className="receive-address breakable" data-testid="receive-address">{target.address}</p>

    <div className="guardian-actions">
      <button className="primary" onClick={() => void copy(target.address, "Address")}>Copy address</button>
      {canShare && <button className="secondary" onClick={() => void share()}>Share</button>}
    </div>

    <p className="callout warning">
      <strong>Only send on {target.chainLabel}.</strong> This address exists on every EVM network, so a transfer sent
      on a different one will not appear here and generally cannot be recovered.
    </p>

    {!deployed && <p className="form-note">
      This account has not been created on chain yet. Funds sent here are safe at this address, but the account is
      created by its first operation before it can send anything out.
    </p>}

    <div aria-live="polite">{status && <p className="form-note" role="status">{status}</p>}</div>

    <AdvancedDetails>
      <p className="form-note">
        A chain-bound EIP-681 link. Some wallets accept it and will preselect the network; others cannot parse it,
        which is why the code above encodes the plain address instead.
      </p>
      <p className="breakable"><code>{target.uri}</code></p>
      <button className="secondary" onClick={() => void copy(target.uri, "Payment link")}>Copy payment link</button>
    </AdvancedDetails>

    <div className="sheet-actions"><span /><button className="secondary" onClick={onClose}>Done</button></div>
  </Dialog>;
}
