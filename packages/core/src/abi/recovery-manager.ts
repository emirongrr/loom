// Generated from out/RecoveryManager.sol/RecoveryManager.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const RecoveryManagerAbi = [
  {
    "type": "function",
    "name": "CANCEL_TYPEHASH",
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
    "name": "PROPOSE_TYPEHASH",
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
    "name": "RECOVERY_DELAY",
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
    "name": "RECOVERY_WINDOW",
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
    "name": "cancelDigest",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recoveryId",
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
    "name": "cancelRecovery",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelRecoveryWithAccountAndGuardians",
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
    "name": "cancelRecoveryWithGuardians",
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
    "name": "executeRecovery",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "oldValidators",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "outputs": [],
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
    "name": "pendingRecoveries",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "oldValidatorsHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "newValidator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initDataHash",
        "type": "bytes32",
        "internalType": "bytes32"
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
    "name": "proposalDigest",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "oldValidatorsHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "newValidator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initDataHash",
        "type": "bytes32",
        "internalType": "bytes32"
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
    "name": "proposeRecovery",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
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
        "name": "initDataHash",
        "type": "bytes32",
        "internalType": "bytes32"
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
    "outputs": [
      {
        "name": "recoveryId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "recoveryIdFor",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "pending",
        "type": "tuple",
        "internalType": "struct RecoveryManager.PendingRecovery",
        "components": [
          {
            "name": "oldValidatorsHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "newValidator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "initDataHash",
            "type": "bytes32",
            "internalType": "bytes32"
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
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "recoveryNonces",
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
    "type": "event",
    "name": "RecoveryCancelled",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recoveryId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RecoveryExecuted",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recoveryId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "newValidator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RecoveryProposed",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recoveryId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "newValidator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "oldValidatorsHash",
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
    "name": "InvalidRecovery",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecoveryAlreadyPending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecoveryExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecoveryNotReady",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnauthorizedCancellation",
    "inputs": []
  }
] as const;
