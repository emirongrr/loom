# Trusted Computing Base

Loom aims to leave no permanent account authority with the project or an
operator. That claim is meaningful only when the dependencies and compromise
conditions are explicit. This inventory is derived from the current code and
default build profile; an account's exact boundary remains configuration
dependent.

The document separates four different boundaries:

- **On-chain authorization TCB:** code or state whose compromise can authorize
  account execution or replace account authority.
- **Authorization constraints:** code and state that narrow an already valid
  authorization. Their failure can enlarge authority but does not necessarily
  create a signature or guardian quorum by itself.
- **User-side authorization boundary:** software and hardware that present,
  encode, and sign an intent before it reaches the account.
- **Availability TCB:** dependencies whose failure can prevent authorized use
  without granting a third party authority.

Entries in these categories are not all unilateral takeover paths. The tables
state when multiple compromises must be composed. Accounts can share deployed
implementations, EntryPoints, modules, and verifiers while retaining separate
account storage, validator configuration, guardian roots, nonces, and balances.

## On-chain authorization TCB

| Component | Authority and compromise condition | Selected or changed by |
| --- | --- | --- |
| `LoomAccount` runtime and linked libraries | Defines every authorization and execution path. A defect can bypass all higher-level controls. | Immutable implementation chosen at deployment; migration requires an explicit account action. |
| `LoomAccountProxy` | Stores the implementation as immutable proxy code. A defect in delegation or initialization can redirect account behavior. | Fixed at deployment; there is no proxy admin or upgrade selector. |
| Configured EntryPoint | May call the account's ERC-4337 execution path after EntryPoint validation. A compromised configured EntryPoint can abuse that caller privilege. | Written once during account initialization. |
| Installed validators | A validator can authorize the operations allowed by its interface and account configuration. A primary validator can authorize general UserOperations; scoped validators remain constrained by their validation logic and hooks. | Installed or removed through the account's delayed module-management path, or replaced by recovery. |
| Installed recovery module | Can replace the validator configuration and guardian root through the account's recovery entry points. | At most one; installed or removed through the delayed module-management path. |
| Guardian threshold and leaves, collectively | A valid threshold can authorize recovery. Compromise requires enough accepted guardian leaves to meet the configured threshold, not merely one guardian when the threshold is greater than one. | Guardian configuration changes use the account's delayed path; recovery can install a new configuration. |
| Guardian verifier contracts, conditionally | A verifier defines validity for leaves that name it. A compromised verifier forges only those leaves; takeover additionally requires enough affected leaves to satisfy the threshold. | Verifier address, code hash, key commitment, and salt are bound into each leaf. |
| P-256 verifier configured by a P-256 validator | Decides whether the asserted P-256 signature is valid. Compromise can forge authorizations accepted by each validator that trusts it. | Fixed by the validator's initialization and configuration rules. |
| EVM and chain consensus | Define code execution, storage, transaction ordering, and finality. A consensus failure can violate every account invariant. | Base-layer protocol and validator set. |

### Guardian verifier code-hash caveat

A guardian leaf commits to the verifier address and its `extcodehash`, in
addition to the key commitment and salt. This detects ordinary code
replacement at that address. It does not make an upgradeable proxy's delegated
implementation immutable: the proxy code hash can remain constant while its
implementation changes. Deployment profiles therefore must restrict guardian
verifiers to reviewed, non-upgradeable implementations or explicitly account
for the proxy's upgrade authority. See [Guardians](../design/guardians.md).

## Authorization constraints

These mechanisms restrict other authority. Compromise can remove a restriction
or cause denial of service, but the listed component alone does not necessarily
produce the validator signature, EntryPoint authorization, or guardian quorum
needed to execute.

| Component | Security role | Composition required for takeover |
| --- | --- | --- |
| Policy hook used by a validator | Decides whether a validator's direct-execution request is within policy. | An overly permissive hook still needs an authorization accepted by that validator. A reverting hook can deny affected execution. |
| Other installed hooks | Run account execution checks and may reject calls. | A permissive hook does not forge validator authorization; a reverting hook can block affected calls until removed. |
| Delays, nonces, request hashes, and configuration versions | Prevent replay, stale recovery, and immediate high-impact configuration changes. | Bypass must be combined with an authorization path capable of submitting the affected operation. |

## User-side authorization boundary

These components do not retain on-chain authority merely by existing, but they
are trusted while the user interprets and signs an operation. A compromised
client can present one intent and request a valid signature over another, so it
is not accurate to place wallet software outside every authorization boundary.

| Component | Why it matters | Independent checks or limits |
| --- | --- | --- |
| Signing device and credential storage | Protect the private key or passkey and perform the signature. | Hardware/platform isolation and user verification depend on the chosen authenticator. |
| Wallet UI and intent encoder | Select destination, value, calldata, chain, account, validator, and operation type shown to the user. | Users and integrators should decode final calldata and bind displays to the exact signed digest. The SDK is replaceable, not harmless during signing. |
| Browser, OS, and WebAuthn implementation | Mediate origin, RP ID, credential selection, user presence, and signature bytes. | Origin/RP checks and authenticator flags must be validated by the wallet and verifier profile. |
| RPC, indexer, and explorer used by the client | Supply chain state, receipts, balances, and deployment data that influence user decisions. | Cross-check chain ID, bytecode commitments, transaction hashes, receipt provenance, and final state through independent providers when stakes warrant it. |
| Deployment tooling and manifest producer | Choose constructor inputs, EntryPoint, implementation, module addresses, and published bytecode commitments. | Reproducible builds, independently verified bytecode, and signed deployment evidence reduce this setup-time trust. |

## Availability TCB

| Component | Failure effect | Mitigation or boundary |
| --- | --- | --- |
| Configured EntryPoint and bundler access | Blocks ERC-4337 submission. | Direct execution is a fallback only when an installed validator implements and permits the direct-validation path. Accounts with only EntryPoint-dependent validators remain dependent on EntryPoint/bundler availability. |
| Installed hooks | A reverting or exhausting check can block affected execution. | Guardian-threshold eviction can remove one hook immediately; scheduled removal remains available after its delay. |
| Passkey/P-256 verifier | Failure blocks validators that depend on it. | Recovery can replace validator configuration if a working recovery path and guardian threshold remain available. |
| Recovery module and guardian infrastructure | Failure can block recovery without affecting a still-working primary validator. | Maintain independent guardians and test the complete recovery path before relying on it. |
| Paymaster or sponsor | Refusal blocks sponsored submission. | Use account-funded gas or another allowed payment path where the validator policy permits it. |
| Keystore proof verifier, when installed | A broken verifier blocks the opt-in synchronization path. | Ordinary execution and other recovery paths are unaffected unless account configuration makes sync indispensable. |
| Chain liveness and gas market | No transaction executes or affordable inclusion disappears. | This is a base-layer dependency; Loom has no independent bypass. |

## Components without retained post-deployment authority

The following components do not, by themselves, retain authority over an
already deployed account. They can still affect setup, signing-time safety, or
availability as described above.

| Component | Boundary |
| --- | --- |
| Loom project and maintainers | No account admin key, proxy upgrade selector, privileged factory operation, or project-controlled recovery path. |
| `LoomAccountFactory` | Deploys and initializes accounts but retains no authority over deployed instances. A malicious factory can still create a different account than the user intended, so deployment verification remains necessary. |
| Relayer or transaction publisher | Can deliver or withhold an already authorized direct operation but cannot change the call bound by the authorization. |
| `AppAccountRegistry` | Provides discovery metadata and grants no account authority. |
| Registry of approved modules | None exists in the core account; module installation is an account-authorized decision. |

## Keystore synchronization, when enabled

Installing `KeystoreSyncRecoveryModule` adds a new recovery authority path: a
newer accepted L1 configuration can replace the local validator set.

| Component | Added trust |
| --- | --- |
| `LoomKeystore` identity controller | Can publish newer configurations for every account that intentionally follows that identity. |
| Configured proof verifier | Determines whether the claimed L1 storage value and version are proven. A sound failure should reject rather than authorize. |
| OP Stack `L1Block` predeploy and its update mechanism | The verifier binds the supplied RLP header to `L1Block.hash()`, then extracts the state root used for the storage proof. Incorrect predeploy data can block or misdirect proof verification according to the rollup trust model. |

Accounts that do not install the synchronization module do not add this path.

## Build and deployment TCB

Source review is not enough if deployed bytecode cannot be tied to it. The
current repository build paths pin Solidity `0.8.35`: Foundry configuration,
the npm `solc` dependency, Certora setup, and Kontrol setup must remain aligned.
Changing the compiler, optimizer, EVM target, linked libraries, constructor
arguments, or deployment manifest changes the produced authority-bearing code
and requires fresh evidence.

The deployment boundary therefore includes:

- compiler binaries and build flags;
- dependency lockfiles and linked library bytecode;
- factory, implementation, EntryPoint, verifier, and module addresses;
- constructor and initialization calldata;
- chain identity, runtime code hashes, and independently reproducible
  deployment manifests.

## Residual limits

This inventory does not claim that every trusted component is correct. Loom is
pre-audit, documented assumptions remain, and formal verification covers
selected properties rather than whole-system correctness. Configuration can
also add modules or verifier implementations with different boundaries. The
inventory must therefore be reviewed against the exact deployed account and
manifest, not used as a universal allowlist.

## Related material

- [Threat model](threat-model.md)
- [Assumptions and residual risks](assumptions-and-risks.md)
- [Audit scope](audit-scope.md)
- [Production readiness](production-readiness.md)
- [Formal verification](formal-verification.md)
- [Architecture](../design/architecture.md)
- [Guardians](../design/guardians.md)
- [Deployment and verification](../operations/deployment.md)
