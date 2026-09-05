// Generated from out/MigrationModule.sol/MigrationModule.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const MigrationModuleAbi = [
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
    "name": "MIN_MIGRATION_DELAY",
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
        "name": "account",
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
    "name": "consumeMigration",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
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
    "outputs": [
      {
        "name": "migrationId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "destination",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isModuleType",
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
    "name": "migrationCancelDigest",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "migrationId",
        "type": "bytes32",
        "internalType": "bytes32"
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
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "migration",
        "type": "tuple",
        "internalType": "struct MigrationModule.PendingMigration",
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
    "name": "migrationNonces",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
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
    "name": "pendingMigrations",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "type": "event",
    "name": "MigrationCancelled",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
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
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
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
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
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
        "indexed": false,
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
    "type": "error",
    "name": "InvalidMigration",
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
    "name": "OperationNotReady",
    "inputs": []
  }
] as const;
