import type { LoomClient } from "@loom/sdk";

import type { SessionPermissionDraft } from "../types/wallet";

export function prepareSessionGrant(input: {
  client: LoomClient;
  permission: SessionPermissionDraft;
  origin: string;
  label: string;
}) {
  return input.client.grantSession({
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
  });
}

