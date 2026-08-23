// Generated from out/RecoveryIntentBoard.sol/RecoveryIntentBoard.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const RecoveryIntentBoardAbi = [
  {
    "type": "function",
    "name": "MAX_SIGNATURE_BYTES",
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
    "name": "announce",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recoveryManager",
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
        "name": "expiresAt",
        "type": "uint48",
        "internalType": "uint48"
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
    "name": "publishApproval",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recoveryManager",
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
        "name": "approvals",
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
    "name": "publishCancellation",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recoveryManager",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "approvals",
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
    "type": "event",
    "name": "RecoveryAnnounced",
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
        "name": "recoveryManager",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "oldValidatorsHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "newValidator",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "initDataHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "newGuardianRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "newGuardianThreshold",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "configVersion",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
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
    "name": "RecoveryApprovalPublished",
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
        "name": "guardianLeaf",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "recoveryManager",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "verifier",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "keyCommitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "signature",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "proof",
        "type": "bytes32[]",
        "indexed": false,
        "internalType": "bytes32[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RecoveryCancellationPublished",
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
        "name": "guardianLeaf",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "recoveryManager",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "verifier",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "keyCommitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "signature",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "proof",
        "type": "bytes32[]",
        "indexed": false,
        "internalType": "bytes32[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "InvalidApproval",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPendingRecovery",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SignatureTooLarge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SingleApprovalRequired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownRecoveryManager",
    "inputs": []
  }
] as const;
