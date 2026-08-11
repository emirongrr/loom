import { createContext, useContext, useMemo, type PropsWithChildren } from "react";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { createBrowserAccountStore, type AccountStore } from "../storage/accountStore";
import { createBrowserGuardianVault, type GuardianVault } from "../storage/guardianVault";
import { createEncryptedLinkTransport, type InvitationTransport } from "../transports/invitations";
import { createPublicClientRegistry, type PublicClientRegistry } from "../services/rpc/publicClients";
import { createRuntimeVerifier, type RuntimeVerifier } from "../services/runtime/runtimeVerifier";
import { createBrowserPendingOperationStore, type PendingOperationStore } from "../storage/pendingOperations";

/**
 * The replaceable I/O the wallet depends on, injected in one place so a test — or
 * an integrator — can substitute any of it without touching a component.
 */
export interface AppServices {
  readonly accounts: AccountStore;
  /** Capabilities held for accounts this device protects as a guardian. */
  readonly guardianVault: GuardianVault;
  /** Bearer delivery for guardian invitations; key and ciphertext share the fragment. */
  readonly invitationLinks: InvitationTransport<GuardianInviteV1>;
  /** Cached read-only RPC clients. Components never construct endpoint clients. */
  readonly publicClients: PublicClientRegistry;
  readonly runtime: RuntimeVerifier;
  readonly pendingOperations: PendingOperationStore;
  /** Injectable clock, so expiry handling is testable. */
  readonly now: () => number;
}

const ServicesContext = createContext<AppServices | null>(null);

export function AppServicesProvider({ children, services }: PropsWithChildren<{ services?: AppServices }>) {
  const value = useMemo(() => services ?? createDefaultServices(), [services]);
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useAppServices(): AppServices {
  const value = useContext(ServicesContext);
  if (!value) throw new Error("AppServicesProvider is missing");
  return value;
}

function createDefaultServices(): AppServices {
  const publicClients = createPublicClientRegistry();
  return Object.freeze({
    accounts: createBrowserAccountStore(),
    guardianVault: createBrowserGuardianVault(),
    invitationLinks: createEncryptedLinkTransport<GuardianInviteV1>({ origin: window.location.origin }),
    publicClients,
    runtime: createRuntimeVerifier({ publicClients }),
    pendingOperations: createBrowserPendingOperationStore(),
    now: () => Date.now()
  });
}
