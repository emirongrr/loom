// Generated from out/P256RecoveryValidatorFactory.sol/P256RecoveryValidatorFactory.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const P256RecoveryValidatorFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "fallbackVerifier_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "RECOVERY_VALIDATOR_SALT_DOMAIN",
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
    "name": "deploy",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recoveryNonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "x",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "y",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "rpIdHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "originHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "policyHook",
        "type": "address",
        "internalType": "address"
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
    "outputs": [
      {
        "name": "validator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deploymentSalt",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recoveryNonce",
        "type": "uint64",
        "internalType": "uint64"
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
    "name": "fallbackVerifier",
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
    "name": "getAddress",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recoveryNonce",
        "type": "uint64",
        "internalType": "uint64"
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
    "name": "initDataHashFor",
    "inputs": [
      {
        "name": "x",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "y",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "rpIdHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "originHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "policyHook",
        "type": "address",
        "internalType": "address"
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
    "name": "validatorInitCodeHash",
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
    "type": "event",
    "name": "RecoveryValidatorDeployed",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recoveryNonce",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "initDataHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "validator",
        "type": "address",
        "indexed": false,
        "internalType": "address"
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
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "InvalidFallbackVerifier",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRecoveryValidatorInput",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnexpectedValidatorAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnexpectedValidatorReservation",
    "inputs": []
  }
] as const;
