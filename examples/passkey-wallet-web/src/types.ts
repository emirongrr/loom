import type { Address, Hex } from "@loom/core";

export type NavigationArea = "home" | "activity" | "apps" | "security" | "guardian" | "developer";

/** Last WebAuthn backup flags observed in a verified registration/assertion. */
export interface PasskeyBackupObservation {
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly observedAt: number;
  readonly source: "registration" | "assertion";
}

export type AccountHandle =
  | {
      readonly version: 3;
      readonly kind: "derived";
      readonly id: string;
      readonly label: string;
      readonly account: Address;
      readonly chainId: number;
      readonly credentialId: Hex;
      readonly publicKey: { readonly x: Hex; readonly y: Hex };
      readonly rpId: string;
      readonly origin: string;
      readonly passkeyBackup?: PasskeyBackupObservation;
      readonly accountHandle: Hex;
      readonly creation: {
        readonly guardianRoot: Hex;
        readonly guardianThreshold: number;
        readonly recoveryModule?: Address;
        /** Exact optional module bound into this account's CREATE2 configuration. */
        readonly migrationModule: Address | null;
      };
    }
  | {
      readonly version: 3;
      readonly kind: "recovered";
      readonly id: string;
      readonly label: string;
      readonly account: Address;
      readonly chainId: number;
      readonly credentialId: Hex;
      readonly publicKey: { readonly x: Hex; readonly y: Hex };
      readonly rpId: string;
      readonly origin: string;
      readonly passkeyBackup?: PasskeyBackupObservation;
      /** Present for v3 credentials so a synced passkey can locate the account. */
      readonly accountHandle?: Hex;
      readonly validator: Address;
    };

export type ActivityKind = "native" | "token" | "nft" | "call" | "deployment";
export type ActivityDirection = "sent" | "received" | "self";
export type ActivityStatus = "pending" | "included" | "finalized" | "failed";

export interface ActivityItem {
  /** The transaction hash; one entry per transaction. */
  readonly id: string;
  readonly kind: ActivityKind;
  readonly direction: ActivityDirection;
  readonly status: ActivityStatus;
  readonly title: string;
  /** Human-readable value, e.g. "0.25 ETH" or "USDC #7". Absent for bare calls. */
  readonly amount?: string;
  readonly detail: string;
  /** Milliseconds since the epoch. */
  readonly timestamp: number;
  readonly hash: Hex;
}
