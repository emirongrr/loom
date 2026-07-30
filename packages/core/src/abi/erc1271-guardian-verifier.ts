// Generated from out/ERC1271GuardianVerifier.sol/ERC1271GuardianVerifier.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const ERC1271GuardianVerifierAbi = [
  {
    "type": "function",
    "name": "MAGIC_VALUE",
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
