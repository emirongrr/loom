// DEPRECATED: the lifecycle builders moved into @loom/sdk (the wallet engine)
// so the SDK exposes one client and one package. This module remains as a
// compatibility re-export for one deprecation cycle — import from "@loom/sdk"
// instead. It will be removed after the cycle announced in the release notes.

export {
  createAccountLifecycleClient,
  createLifecycleCallEncoder,
  InvalidLifecycleRequestError
} from "@loom/sdk";

export type {
  AccountLifecycleClient,
  AccountLifecycleKind,
  GranularPermissionInput,
  Hex,
  LifecycleAuthority,
  LifecycleCallEncoder,
  LifecycleIntent,
  SessionScope
} from "@loom/sdk";
