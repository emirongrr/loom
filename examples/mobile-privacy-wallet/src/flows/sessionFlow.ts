import type { LoomClient } from "@loom/sdk";

import { blockedGate } from "../platform/errors";
import type { FlowResult, ReleaseGate, SessionPermissionDraft } from "../types/wallet";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type SessionGrantPreparation = ReturnType<LoomClient["grantSession"]>;

export function prepareSessionGrant(input: {
  client: LoomClient;
  permission: SessionPermissionDraft;
  origin: string;
  label: string;
  now?: bigint;
}): FlowResult<SessionGrantPreparation> {
  const gates: ReleaseGate[] = [];
  const invalid = (id: string, summary: string): void => {
    gates.push(blockedGate({ id, title: "Session permission rejected", summary }));
  };

  if (input.origin.trim().length === 0) {
    invalid("session.origin.missing", "A session grant must name the requesting origin.");
  }
  if (!ADDRESS_PATTERN.test(input.permission.sessionKey) || input.permission.sessionKey === ZERO_ADDRESS) {
    invalid("session.key.invalid", "Session key must be a non-zero address.");
  }
  if (!ADDRESS_PATTERN.test(input.permission.target) || input.permission.target === ZERO_ADDRESS) {
    invalid("session.target.invalid", "Session target must be a non-zero contract address.");
  }
  if (!SELECTOR_PATTERN.test(input.permission.selector)) {
    invalid("session.selector.invalid", "Session selector must be a 4-byte function selector.");
  }
  if (!ADDRESS_PATTERN.test(input.permission.token)) {
    invalid("session.token.invalid", "Session token must be an address (zero address for the native asset).");
  }
  if (input.permission.maxAmount <= 0n) {
    invalid("session.max-amount.invalid", "Session grants must carry an explicit positive spending limit.");
  }
  if (!Number.isSafeInteger(input.permission.maxUses) || input.permission.maxUses <= 0) {
    invalid("session.max-uses.invalid", "Session grants must carry an explicit positive use limit.");
  }

  const now = input.now ?? BigInt(Math.floor(Date.now() / 1000));
  if (input.permission.validUntil <= now) {
    invalid("session.expiry.invalid", "Session grants must expire in the future; an unbounded or past expiry is rejected.");
  }

  if (gates.length > 0) {
    return { status: "blocked", gates };
  }

  return {
    status: "ready",
    value: input.client.grantSession({
      origin: input.origin,
      label: input.label,
      chainId: input.client.chainId,
      account: input.client.account,
      sessionKey: input.permission.sessionKey,
      target: input.permission.target,
      selector: input.permission.selector,
      token: input.permission.token,
      maxAmount: input.permission.maxAmount,
      validUntil: input.permission.validUntil,
      maxUses: input.permission.maxUses
    })
  };
}
