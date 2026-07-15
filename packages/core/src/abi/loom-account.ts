// Generated from out/LoomAccount.sol/LoomAccount.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const LoomAccountAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "entryPoint_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "guardianRoot_",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "guardianThreshold_",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "configHash_",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "modules",
        "type": "tuple[]",
        "internalType": "struct LoomAccount.ModuleInit[]",
        "components": [
          {
            "name": "moduleTypeId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "module",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "initData",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "receive",
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "BATCH_EXECUTION_MODE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "CANCEL_MIGRATION_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DIRECT_EXECUTION_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "EIP712_DOMAIN_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ERC1155_RECEIVER_INTERFACE_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ERC1271_INVALID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ERC1271_MAGIC_VALUE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ERC165_INTERFACE_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ERC721_RECEIVER_INTERFACE_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "EVICT_HOOK_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "FREEZE_DURATION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "FREEZE_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_GUARDIAN_PROOF_LENGTH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_GUARDIAN_THRESHOLD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_HOOKS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_MIGRATION_WINDOW",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_RECOVERY_MODULES",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_SCHEDULE_DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_VALIDATORS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_CONFIG_DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_EXTERNAL_DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SINGLE_EXECUTION_MODE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "accountId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "cancelMigration",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelMigrationWithGuardians",
    "inputs": [
      {
        "name": "guardianApprovals",
        "type": "tuple[]",
        "internalType": "struct GuardianVerificationLib.Approval[]",
        "components": [
          {
            "name": "verifier",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "keyCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "signature",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "proof",
            "type": "bytes32[]",
            "internalType": "bytes32[]"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelScheduled",
    "inputs": [
      {
        "name": "operationId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "configHash",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "configVersion",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "decodeScheduleCall",
    "inputs": [
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "callData",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "delay",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "decodeSignature",
    "inputs": [
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "validator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "validatorSignature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "directExecutionDigest",
    "inputs": [
      {
        "name": "validator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "mode",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "executionCalldata",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "validUntil",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "directExecutionNonces",
    "inputs": [
      {
        "name": "validator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "entryPoint",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "evictHookDigest",
    "inputs": [
      {
        "name": "hook",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "version",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "evictHookWithGuardians",
    "inputs": [
      {
        "name": "hook",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "guardianApprovals",
        "type": "tuple[]",
        "internalType": "struct GuardianVerificationLib.Approval[]",
        "components": [
          {
            "name": "verifier",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "keyCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "signature",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "proof",
            "type": "bytes32[]",
            "internalType": "bytes32[]"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "execute",
    "inputs": [
      {
        "name": "mode",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "executionCalldata",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "executeDirect",
    "inputs": [
      {
        "name": "validator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "mode",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "executionCalldata",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "validUntil",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "executeFromExecutor",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "executeMigration",
    "inputs": [
      {
        "name": "calls",
        "type": "tuple[]",
        "internalType": "struct ExecutionLib.Execution[]",
        "components": [
          {
            "name": "target",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "value",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "callData",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "executeScheduled",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "freeze",
    "inputs": [
      {
        "name": "verifier",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "keyCommitment",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "proof",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "freezeNonces",
    "inputs": [
      {
        "name": "guardianLeaf",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "frozenUntil",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "guardianLeaf",
    "inputs": [
      {
        "name": "verifier",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "keyCommitment",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "guardianRoot",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "guardianThreshold",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "initialize",
    "inputs": [
      {
        "name": "entryPoint_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "guardianRoot_",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "guardianThreshold_",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "configHash_",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "modules",
        "type": "tuple[]",
        "internalType": "struct LoomAccount.ModuleInit[]",
        "components": [
          {
            "name": "moduleTypeId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "module",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "initData",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "initializeDelegatedAccount",
    "inputs": [
      {
        "name": "entryPoint_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "guardianRoot_",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "guardianThreshold_",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "configHash_",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "modules",
        "type": "tuple[]",
        "internalType": "struct LoomAccount.ModuleInit[]",
        "components": [
          {
            "name": "moduleTypeId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "module",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "initData",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "installModule",
    "inputs": [
      {
        "name": "moduleTypeId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "module",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isExecutingScheduled",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isModuleInstalled",
    "inputs": [
      {
        "name": "moduleTypeId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "module",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isModuleInstalled",
    "inputs": [
      {
        "name": "moduleTypeId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "module",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isValidSignature",
    "inputs": [
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "lastFreezeConfigVersion",
    "inputs": [
      {
        "name": "guardianLeaf",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "migrationCancelDigest",
    "inputs": [
      {
        "name": "migrationId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "version",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "migrationIdFor",
    "inputs": [
      {
        "name": "migration",
        "type": "tuple",
        "internalType": "struct LoomAccount.PendingMigration",
        "components": [
          {
            "name": "destination",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "destinationCodeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "destinationConfigHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "callsHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "readyAt",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "expiresAt",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "configVersion",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "migrationNonce",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "notifyConfigChange",
    "inputs": [
      {
        "name": "changeHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "onERC1155BatchReceived",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "onERC1155Received",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "onERC721Received",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "pendingMigration",
    "inputs": [],
    "outputs": [
      {
        "name": "destination",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "destinationCodeHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "destinationConfigHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "callsHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "readyAt",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "expiresAt",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "configVersion",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "recoverConfiguration",
    "inputs": [
      {
        "name": "oldValidators",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "newValidator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initData",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "newGuardianRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "newGuardianThreshold",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "recoverConfigurationSet",
    "inputs": [
      {
        "name": "oldValidators",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "newValidators",
        "type": "tuple[]",
        "internalType": "struct ILoomAccount.RecoveryModuleInit[]",
        "components": [
          {
            "name": "moduleTypeId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "module",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "initData",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "newGuardianRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "newGuardianThreshold",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "recoveryConfigured",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "revokeTokenAllowance",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "scheduleCall",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "delay",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "outputs": [
      {
        "name": "operationId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "scheduleMigration",
    "inputs": [
      {
        "name": "destination",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "destinationCodeHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "destinationConfigHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "callsHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "delay",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "executionWindow",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "outputs": [
      {
        "name": "migrationId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "scheduledOperations",
    "inputs": [
      {
        "name": "operationId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "readyAt",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setGuardianConfig",
    "inputs": [
      {
        "name": "newRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "newThreshold",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "supportsExecutionMode",
    "inputs": [
      {
        "name": "mode",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "supportsModule",
    "inputs": [
      {
        "name": "moduleTypeId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "unfreeze",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "uninstallModule",
    "inputs": [
      {
        "name": "moduleTypeId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "module",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "deInitData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "validateUserOp",
    "inputs": [
      {
        "name": "userOp",
        "type": "tuple",
        "internalType": "struct PackedUserOperation",
        "components": [
          {
            "name": "sender",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "initCode",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "callData",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "accountGasLimits",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "preVerificationGas",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasFees",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "paymasterAndData",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "signature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "userOpHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "missingAccountFunds",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "validationData",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "validatorAt",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "validatorCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "AllowanceRevoked",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "spender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ConfigUpdated",
    "inputs": [
      {
        "name": "configHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "configVersion",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DirectExecution",
    "inputs": [
      {
        "name": "validator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "executionHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Frozen",
    "inputs": [
      {
        "name": "frozenUntil",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GuardianConfigUpdated",
    "inputs": [
      {
        "name": "guardianRoot",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "guardianThreshold",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MigrationCancelled",
    "inputs": [
      {
        "name": "migrationId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MigrationExecuted",
    "inputs": [
      {
        "name": "migrationId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "destination",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MigrationScheduled",
    "inputs": [
      {
        "name": "migrationId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "destination",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "destinationCodeHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "destinationConfigHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "callsHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "readyAt",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      },
      {
        "name": "expiresAt",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ModuleInstalled",
    "inputs": [
      {
        "name": "moduleTypeId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "module",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ModuleUninstalled",
    "inputs": [
      {
        "name": "moduleTypeId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "module",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OperationCancelled",
    "inputs": [
      {
        "name": "operationId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OperationExecuted",
    "inputs": [
      {
        "name": "operationId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OperationScheduled",
    "inputs": [
      {
        "name": "operationId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "readyAt",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccountFrozen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CallFailed",
    "inputs": [
      {
        "name": "returnData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ]
  },
  {
    "type": "error",
    "name": "EmptyBatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FreezeActive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidDelay",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidDirectExecution",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidGuardianConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidInitialization",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidMigration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidModule",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidTokenAllowance",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MigrationAlreadyPending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MigrationNotPending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ModuleLimitReached",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyEntryPoint",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlySelf",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OperationAlreadyScheduled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OperationNotReady",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OperationNotScheduled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentrancy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnsupportedExecutionMode",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnsupportedModuleType",
    "inputs": []
  }
] as const;
