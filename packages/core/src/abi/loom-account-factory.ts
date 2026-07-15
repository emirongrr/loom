// Generated from out/LoomAccountFactory.sol/LoomAccountFactory.json — do not edit.
// Regenerate with `forge build && npm run abi:generate`.
export const LoomAccountFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "entryPoint_",
        "type": "address",
        "internalType": "contract IEntryPoint"
      },
      {
        "name": "accountImplementation_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "accountImplementation",
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
    "name": "createAccount",
    "inputs": [
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "guardianRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "guardianThreshold",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "configHash",
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
    "outputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "contract LoomAccount"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "entryPoint",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IEntryPoint"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getAddress",
    "inputs": [
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "guardianRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "guardianThreshold",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "configHash",
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
    "name": "registry",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract AppAccountRegistry"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "LoomAccountCreated",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "InvalidFactory",
    "inputs": []
  }
] as const;
