import { createContext, useContext, useMemo, type PropsWithChildren } from "react";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { createBrowserAccountStore, type AccountStore } from "../storage/accountStore";
import { createBrowserGuardianVault, type GuardianVault } from "../storage/guardianVault";
import { createEncryptedLinkTransport, createFileInvitationTransport, createMemoryInvitationTransport, createQrInvitationTransport, type InvitationTransport } from "../transports/invitations";
import { createMemoryMailbox, createEncryptedRecoveryRoom, type RecoveryRoom } from "../transports/recoveryRoom";

export interface AppServices {
  readonly accounts: AccountStore;
  readonly guardianVault: GuardianVault;
  readonly invitations: {
    readonly file: InvitationTransport<GuardianInviteV1>;
    readonly link: InvitationTransport<GuardianInviteV1>;
    readonly qr: InvitationTransport<GuardianInviteV1>;
    readonly memory: InvitationTransport<GuardianInviteV1>;
  };
  readonly recoveryRoom: RecoveryRoom<unknown>;
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
  const link = createEncryptedLinkTransport<GuardianInviteV1>({ origin: window.location.origin });
  return Object.freeze({
    accounts: createBrowserAccountStore(),
    guardianVault: createBrowserGuardianVault(),
    invitations: {
      file: createFileInvitationTransport<GuardianInviteV1>(),
      link,
      qr: createQrInvitationTransport(link),
      memory: createMemoryInvitationTransport<GuardianInviteV1>()
    },
    recoveryRoom: createEncryptedRecoveryRoom(createMemoryMailbox()),
    now: () => Date.now()
  });
}
