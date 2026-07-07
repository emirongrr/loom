# ERC-7579 Limited Profile Conformance

Loom intentionally implements a constrained subset and does not claim full
ERC-7579 conformance.

| Surface | Loom result |
|---|---|
| Validator modules | Supported through the Loom validator runtime interface |
| Hook modules | Supported through the Loom hook runtime interface |
| Standard lifecycle callbacks | Supported through `ERC7579ModuleAdapter` |
| Executor modules | Unsupported; installation and execution revert |
| Fallback modules | Unsupported; installation reverts |
| Delegatecall execution | Unsupported |
| Try execution | Unsupported |
| `executeFromExecutor` | Always reverts |
| Single execution encoding | Loom-specific `abi.encode(Execution)` |
| Atomic batch encoding | `abi.encode(Execution[])` |
| Recovery module type `5` | Loom extension, not an ERC-7579 standard type |

`test/integration/ERC7579LimitedProfile.t.sol` is the executable acceptance matrix. Any
future expansion of this profile requires a threat-model update and dedicated
conformance tests before the capability may be reported by a wallet client.
