// Generated from out/ECDSAGuardianVerifier.sol/ECDSAGuardianVerifier.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const ECDSAGuardianVerifierAbi = [
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
    "stateMutability": "pure"
  }
] as const;
