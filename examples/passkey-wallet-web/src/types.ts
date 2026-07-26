import type { Address, Hex } from "@loom/core";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";

export type NavigationArea = "home" | "activity" | "apps" | "security" | "guardian" | "developer";

export type AccountHandle =
  | {
      readonly version: 1;
      readonly kind: "derived";
      readonly id: string;
      readonly label: string;
      readonly account: Address;
      readonly chainId: number;
      readonly credentialId: Hex;
      readonly publicKey: { readonly x: Hex; readonly y: Hex };
      readonly rpId: string;
      readonly origin: string;
      readonly salt: Hex;
      readonly creation: { readonly guardianRoot: Hex; readonly guardianThreshold: number; readonly recoveryModule?: Address };
    }
  | {
      readonly version: 1;
      readonly kind: "recovered";
      readonly id: string;
      readonly label: string;
      readonly account: Address;
      readonly chainId: number;
      readonly credentialId: Hex;
      readonly publicKey: { readonly x: Hex; readonly y: Hex };
      readonly rpId: string;
      readonly origin: string;
      readonly validator: Address;
    };

export type TransactionLifecycle =
  | { readonly status: "idle" }
  | { readonly status: "reviewing"; readonly review: TransactionReviewModel }
  | { readonly status: "simulating"; readonly review: TransactionReviewModel }
  | { readonly status: "awaiting-authentication"; readonly review: TransactionReviewModel }
  | { readonly status: "submitting"; readonly review: TransactionReviewModel }
  | { readonly status: "included"; readonly review: TransactionReviewModel; readonly hash: Hex }
  | { readonly status: "finalized"; readonly review: TransactionReviewModel; readonly hash: Hex }
  | { readonly status: "failed"; readonly review?: TransactionReviewModel; readonly error: WalletDomainError };

export type GuardianOnboardingState =
  | { readonly status: "draft" }
  | { readonly status: "invite-created"; readonly invite: GuardianInviteV1 }
  | { readonly status: "invite-delivered"; readonly invite: GuardianInviteV1; readonly receipt: string }
  | { readonly status: "accepted"; readonly invite: GuardianInviteV1 }
  | { readonly status: "ready-to-activate"; readonly accepted: number; readonly threshold: number }
  | { readonly status: "activation-pending"; readonly readyAt: bigint }
  | { readonly status: "active" }
  | { readonly status: "stale" }
  | { readonly status: "removal-pending"; readonly readyAt: bigint }
  | { readonly status: "removed" }
  | { readonly status: "error"; readonly error: WalletDomainError };

export type RecoveryFlowState =
  | { readonly status: "idle" }
  | { readonly status: "loading-account" }
  | { readonly status: "creating-passkey" }
  | { readonly status: "collecting-approvals"; readonly have: number; readonly need: number; readonly authenticationCode: string }
  | { readonly status: "ready-to-propose"; readonly authenticationCode: string }
  | { readonly status: "proposal-pending" }
  | { readonly status: "delay-active"; readonly readyAt: bigint; readonly expiresAt: bigint }
  | { readonly status: "ready-to-execute"; readonly expiresAt: bigint }
  | { readonly status: "executing" }
  | { readonly status: "complete"; readonly account: Address }
  | { readonly status: "cancelled" }
  | { readonly status: "expired" }
  | { readonly status: "error"; readonly error: WalletDomainError };

export interface TransactionReviewModel {
  readonly title: string;
  readonly account: Address;
  readonly network: string;
  readonly destination?: Address;
  readonly effects: readonly string[];
  readonly approvals: readonly string[];
  readonly permissions: readonly string[];
  readonly securityConsequences: readonly string[];
  readonly gasPayer: "account" | "sponsor" | "submitter";
  readonly estimatedFee?: string;
  readonly route: string;
  readonly delay?: string;
  readonly cancellation?: string;
  readonly simulation: SimulationResult;
  readonly warnings: readonly string[];
}

export type SimulationResult =
  | { readonly status: "not-run" }
  | { readonly status: "verified"; readonly summary: string; readonly blockNumber?: bigint }
  | { readonly status: "failed"; readonly summary: string }
  | { readonly status: "unavailable"; readonly summary: string };

export interface WalletDomainError {
  readonly code: string;
  readonly message: string;
  readonly action: string;
  readonly detail?: unknown;
}

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
