// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

enum P256VerifierMode {
    NativePrecompile,
    FallbackContract
}

struct P256VerifierSelection {
    address verifier;
    P256VerifierMode mode;
    bytes32 codehash;
    bool nativePrecompileSupported;
    bool fallbackVerifierWasDeployed;
    bool fallbackVerifierWasProvided;
}

library P256VerifierConfig {
    error FallbackVerifierHasNoCode();
    error FallbackVerifierCodehashRequired();
    error WrongFallbackVerifierCodehash(bytes32 actual, bytes32 expected);
    error P256VerifierUnavailable();

    // RIP-7212-style P-256 precompile address used by chains that support the
    // protocol-level verifier. Do not add a chain below until the exact fork,
    // address, and verification evidence are documented for that chain.
    address internal constant RIP7212_P256_PRECOMPILE = address(0x100);

    function p256PrecompileForChain(uint256 chainId) internal pure returns (address precompile, bool supported) {
        // Ethereum mainnet and Sepolia intentionally remain unsupported here
        // until this repository records reviewed evidence that their active fork
        // exposes the canonical P-256 precompile at RIP7212_P256_PRECOMPILE.
        if (chainId == 1 || chainId == 11155111) return (address(0), false);

        return (address(0), false);
    }

    function select(uint256 chainId, address configuredFallback, bytes32 expectedFallbackCodehash)
        internal
        view
        returns (P256VerifierSelection memory selection)
    {
        (address nativeVerifier, bool nativeSupported) = p256PrecompileForChain(chainId);
        return selectWithNative(nativeVerifier, nativeSupported, configuredFallback, expectedFallbackCodehash);
    }

    function selectWithNative(
        address nativeVerifier,
        bool nativeSupported,
        address configuredFallback,
        bytes32 expectedFallbackCodehash
    ) internal view returns (P256VerifierSelection memory selection) {
        if (nativeSupported) {
            return P256VerifierSelection({
                verifier: nativeVerifier,
                mode: P256VerifierMode.NativePrecompile,
                codehash: bytes32(0),
                nativePrecompileSupported: true,
                fallbackVerifierWasDeployed: false,
                fallbackVerifierWasProvided: false
            });
        }

        if (configuredFallback == address(0)) revert P256VerifierUnavailable();
        if (configuredFallback.code.length == 0) revert FallbackVerifierHasNoCode();
        if (expectedFallbackCodehash == bytes32(0)) revert FallbackVerifierCodehashRequired();

        bytes32 actualCodehash = configuredFallback.codehash;
        if (actualCodehash != expectedFallbackCodehash) {
            revert WrongFallbackVerifierCodehash(actualCodehash, expectedFallbackCodehash);
        }

        return P256VerifierSelection({
            verifier: configuredFallback,
            mode: P256VerifierMode.FallbackContract,
            codehash: actualCodehash,
            nativePrecompileSupported: false,
            fallbackVerifierWasDeployed: false,
            fallbackVerifierWasProvided: true
        });
    }
}
