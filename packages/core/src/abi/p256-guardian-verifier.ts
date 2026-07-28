// Generated from out/P256GuardianVerifier.sol/P256GuardianVerifier.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const P256GuardianVerifierAbi = [
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
    "name": "verify",
    "inputs": [
      {
        "name": "keyCommitment",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "digest",
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
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  }
] as const;
