# System Diagrams

These diagrams are code-oriented reading aids. They summarize how the current
contracts fit together and where authority boundaries sit. They are not a
substitute for `src/`, `test/`, or the threat model.

## Component Diagram

```mermaid
flowchart TD
    Client["Wallet client or SDK"]
    Services["Optional infrastructure\nRPC / bundler / paymaster / relayer"]
    EntryPoint["ERC-4337 EntryPoint"]
    Factory["LoomAccountFactory"]
    Proxy["LoomAccountProxy"]
    Account["LoomAccount"]
    Validators["Validators\nP256 / MultiP256 / ECDSA / sessions"]
    Hooks["Hooks\nPolicyHook / VaultHook"]
    Recovery["RecoveryManager"]
    GuardianVerifiers["Guardian verifiers\nECDSA / P256 / ERC1271"]
    Keystore["LoomKeystore"]
    ProofVerifier["Keystore proof verifier"]
    Adapters["ERC-7579 adapters and shims"]
    Targets["Target contracts"]

    Client --> Factory
    Factory --> Proxy
    Proxy --> Account
    Client --> EntryPoint
    Services -. optional transport .-> EntryPoint
    EntryPoint --> Account
    Client --> Account
    Account --> Validators
    Account --> Hooks
    Recovery --> GuardianVerifiers
    Recovery --> Account
    Keystore --> ProofVerifier
    ProofVerifier --> Recovery
    Adapters --> Validators
    Adapters --> Hooks
    Account --> Targets
```

Authority summary:

- `Factory` deploys configured accounts but has no post-deployment authority.
- `Proxy` dispatches to one immutable implementation and has no upgrade admin.
- `Validators` authenticate operations only within their installed profile.
- `Hooks` restrict execution and fail closed.
- `RecoveryManager` can replace validator configuration through the narrow
  recovery entry point; it cannot execute arbitrary account calls.
- Optional infrastructure transports operations but is not a trust root.

## Trust Boundary Diagram

```mermaid
flowchart LR
    subgraph UserBoundary["User-controlled boundary"]
        User["User"]
        Client["Wallet / SDK"]
        Guardians["Guardians"]
    end

    subgraph AccountBoundary["On-chain account boundary"]
        Account["LoomAccount"]
        Validators["Installed validators"]
        Hooks["Installed hooks"]
        Recovery["Recovery module"]
    end

    subgraph OptionalBoundary["Optional services"]
        RPC["RPC"]
        Bundler["Bundler"]
        Paymaster["Paymaster"]
        Relayer["Relayer"]
        PrivacyProvider["Privacy provider"]
    end

    User --> Client
    Guardians --> Recovery
    Client --> Account
    Client --> Bundler
    Bundler --> Account
    Paymaster -. selected per permission .-> Bundler
    RPC -. state transport .-> Client
    Relayer -. convenience .-> Client
    PrivacyProvider -. optional adapter .-> Client
    Account --> Validators
    Account --> Hooks
    Recovery --> Account
```

The optional-service boundary is deliberately outside account authority. A
service can improve liveness or UX, but it must not become a permanent veto,
hidden signer, mandatory recovery provider, or global identity registry.

## ERC-4337 Execution Sequence

```mermaid
sequenceDiagram
    participant Wallet
    participant Bundler
    participant EntryPoint
    participant Account as LoomAccount
    participant Validator
    participant Hook
    participant Target

    Wallet->>Bundler: UserOperation
    Bundler->>EntryPoint: handleOps
    EntryPoint->>Account: validateUserOp
    Account->>Validator: validateUserOp
    Validator-->>Account: validationData
    Account-->>EntryPoint: validationData
    EntryPoint->>Account: execute(mode, calldata)
    Account->>Hook: preCheck
    Hook-->>Account: allow or revert
    Account->>Target: call
    Target-->>Account: result
    Account->>Hook: postCheck
    Account-->>EntryPoint: success or revert
```

Execution policy is enforced at account execution time. Unsupported execution
modes fail closed.

## Recovery Sequence

```mermaid
sequenceDiagram
    participant GuardianSet
    participant Recovery as RecoveryManager
    participant Account as LoomAccount
    participant Verifier as GuardianVerifier

    GuardianSet->>Recovery: proposeRecovery(account, new validator set)
    Recovery->>Verifier: verify guardian leaves and signatures
    Verifier-->>Recovery: valid threshold
    Recovery-->>Recovery: record pending recovery and ready time
    GuardianSet->>Recovery: optional cancellation
    Account->>Recovery: optional account cancellation
    GuardianSet->>Recovery: executeRecovery after delay
    Recovery->>Account: recoverConfigurationSet
    Account-->>Recovery: validators and guardian root replaced
```

Guardians do not gain normal spending authority. Recovery is delayed, visible,
cancelable, expiring, and replaces the full validator set.

## Session And Policy Enforcement

```mermaid
sequenceDiagram
    participant App
    participant Wallet
    participant Account as LoomAccount
    participant Session as SessionValidator
    participant Policy as PolicyHook
    participant Target

    App->>Wallet: request scoped permission
    Wallet->>Account: delayed install or grant
    Account->>Session: validate bounded UserOperation
    Session-->>Account: allowed if scope, time, use, paymaster match
    Account->>Policy: preCheck target and selector
    Policy-->>Account: allow or revert
    Account->>Target: execute scoped call
    Account->>Policy: postCheck accounting
```

Session authority is explicit and revocable. Policy hooks remain a separate
execution guardrail.

## Lifecycle State Diagram

The account lifecycle is not a single linear state machine. This diagram is a
readable projection of the implemented overlays; the authoritative model is
`docs/design/lifecycle.md`.

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Uninitialized
    Uninitialized --> Operational: initialize / configVersion 0 to 1

    Operational --> Frozen: guardian freeze
    Frozen --> Operational: freeze window expires

    Operational --> MigrationPending: scheduleMigration
    MigrationPending --> Operational: cancel or executeMigration

    Operational --> RecoveryPending: proposeRecovery
    RecoveryPending --> Operational: cancel or executeRecovery

    Operational --> ScheduledCallPending: scheduleCall
    ScheduledCallPending --> Operational: cancel or executeScheduled
```

`Frozen`, `MigrationPending`, `RecoveryPending`, and scheduled calls can overlap
in the implementation. `configVersion` invalidates stale authority across those
overlays.

## Keystore Sync Boundary

```mermaid
flowchart TD
    L1["LoomKeystore identity config"]
    Proof["Proof verifier"]
    Sync["KeystoreSyncRecoveryModule"]
    Account["LoomAccount"]
    Guardians["Guardian threshold cancellation"]

    L1 --> Proof
    Proof --> Sync
    Sync --> Account
    Guardians --> Sync
```

The keystore sync module is recovery-scoped. A production network must provide
an independently reviewed verifier and profile evidence before this becomes a
production cross-chain authority claim.
