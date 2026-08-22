import { useEffect, useState } from "react";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import { createBrowserGuardianRoster } from "../../storage/guardianRoster";
import { createActiveGuardianInvitation } from "../security/guardianInvitation";
import { createAccountGuardianClient } from "../security/guardianClient";
import { loadWalletDeployment } from "../onboarding/accountLifecycle";
import type { Address, Hex } from "@loom/core";

/**
 * Invitations for the guardians of an account being recovered.
 *
 * Wallet setup writes a guardian set on chain but never had a step that sent
 * each guardian their invitation, so accounts exist whose guardians hold
 * nothing. Those guardians cannot approve a recovery: an approval carries the
 * verifier, key commitment, salt and Merkle proof that only their own
 * capability supplies, and none of that is derivable from the root.
 *
 * Issuing one costs nothing and grants nothing. It is built from the roster
 * this device already holds, needs no signature and no transaction, and gives a
 * guardian only their own proof -- never the set. The signature still comes
 * from the guardian's key on the guardian's device, which is the only thing
 * that authorises anything.
 *
 * It is offered here because the recovering device has already proved it holds
 * the matching roster: the request could not have been created otherwise.
 */
export function GuardianInviteLinks({ account, chainId, requestLink }: {
  readonly account: Address;
  readonly chainId: number;
  /** The request itself, so one message carries everything a guardian needs. */
  readonly requestLink?: () => Promise<string>;
}) {
  const { config } = useNetwork();
  const services = useAppServices();
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "unavailable"; readonly reason: string }
    | { readonly kind: "ready"; readonly guardians: readonly { readonly id: string; readonly label: string }[] }
  >({ kind: "loading" });
  const [links, setLinks] = useState<Readonly<Record<string, string>>>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await createBrowserGuardianRoster().read(`${chainId}:${account.toLowerCase()}`);
        if (stored.entries.length === 0) {
          if (!cancelled) setState({ kind: "unavailable", reason: "This device does not hold the guardian list for this account, so it cannot issue invitations. The list is private and never published, so it can only come from its own encrypted backup." });
          return;
        }
        if (!cancelled) setState({ kind: "ready", guardians: stored.entries.map(entry => ({ id: entry.id, label: entry.label })) });
      } catch {
        if (!cancelled) setState({ kind: "unavailable", reason: "The encrypted guardian list on this device could not be read." });
      }
    })();
    return () => { cancelled = true; };
  }, [account, chainId]);

  const issue = async (guardianId: string) => {
    setMessage("");
    try {
      const deployment = await loadWalletDeployment();
      await services.runtime.verify(config, deployment);
      if (!deployment.recoveryModule) throw new Error("This deployment has no recovery manager.");
      const client = createAccountGuardianClient({
        config, chainId: deployment.chainId, account, recoveryManager: deployment.recoveryModule,
        publicClients: services.publicClients,
        recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner,
        policyHook: deployment.policyHook
      });
      // Read live rather than trusting the state the page opened with: an
      // invitation binds to the guardian root and configuration version, and
      // one issued against a stale pair would be rejected on arrival.
      const live = await client.inspectAccount();
      const stored = await createBrowserGuardianRoster().read(`${chainId}:${account.toLowerCase()}`);
      const expiresAt = Math.floor(services.now() / 1_000) + 7 * 86_400;
      const invite = createActiveGuardianInvitation({
        entries: stored.entries,
        guardianId,
        setVersion: stored.version,
        onChain: {
          root: live.guardianRoot,
          threshold: live.guardianThreshold,
          recoveryConfigured: live.recoveryConfigured,
          configVersion: live.configVersion
        },
        chainId: deployment.chainId,
        account,
        capabilityId: randomBytes32(),
        expiresAt
      });
      const delivered = await services.invitationLinks.deliver(invite, { expiresAt });
      setLinks(current => Object.freeze({ ...current, [guardianId]: delivered.value }));
      setMessage("Invitation ready. Send it to that guardian privately: it carries their own proof, so anyone holding the link can present themselves as that guardian's invitation and read which account it is for.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The invitation could not be created.");
    }
  };

  const copy = async (guardianId: string) => {
    const link = links[guardianId];
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setMessage("Invitation copied."); }
    catch { setMessage("The browser would not copy it. Select the link below and copy it manually."); }
  };

  /**
   * Both links in one message.
   *
   * A guardian needs two things: the capability that lets them approve, and the
   * request to approve. Sending them separately is two deliveries per person
   * for no reason -- and paying to announce the request only avoids the second
   * delivery, which is not worth a transaction when the first one is happening
   * anyway.
   */
  const copyBoth = async (guardianId: string) => {
    const invitation = links[guardianId];
    if (!invitation || !requestLink) return;
    try {
      const request = await requestLink();
      await navigator.clipboard.writeText(
        `Your guardian invitation:
${invitation}

The recovery to review:
${request}

`
        + "Open the invitation first -- it is what lets your approval count."
      );
      setMessage("Invitation and request copied together. Send both to that guardian over a channel you trust.");
    } catch { setMessage("The browser would not copy it."); }
  };

  if (state.kind === "loading") return <p className="form-note">Reading the guardian list on this device…</p>;
  if (state.kind === "unavailable") return <p className="callout warning">{state.reason}</p>;

  return <div className="callout">
    <strong>Guardians who hold nothing yet</strong>
    <p>
      A guardian can only approve with the capability their invitation carries, and setting up this account
      never sent them one. Issuing an invitation needs no signature and no transaction, and gives each guardian
      their own proof only. They accept it on their device, then review the request above.
    </p>
    {message && <p className="form-note" role="status">{message}</p>}
    <div className="wallet-list">
      {state.guardians.map(guardian => <div key={guardian.id} className="recovery-request">
        <header>
          <strong>{guardian.label}</strong>
          {links[guardian.id] && <span className="pill included">Ready</span>}
        </header>
        {links[guardian.id] && <p className="breakable form-note">{links[guardian.id]}</p>}
        <div className="guardian-actions">
          <button className="secondary" onClick={() => void issue(guardian.id)}>
            {links[guardian.id] ? "Issue a new invitation" : "Create invitation"}
          </button>
          {links[guardian.id] && requestLink && <button className="primary" onClick={() => void copyBoth(guardian.id)}>Copy invitation + request</button>}
          {links[guardian.id] && <button className="secondary" onClick={() => void copy(guardian.id)}>Copy invitation only</button>}
        </div>
      </div>)}
    </div>
  </div>;
}

/** A fresh capability id, so two invitations for one guardian never collide. */
function randomBytes32(): Hex {
  const value = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
