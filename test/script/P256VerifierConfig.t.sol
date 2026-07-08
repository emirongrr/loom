// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {P256VerifierConfig, P256VerifierMode, P256VerifierSelection} from "../../script/P256VerifierConfig.sol";

contract P256VerifierConfigHarness {
    function select(uint256 chainId, address configuredFallback, bytes32 expectedFallbackCodehash)
        external
        view
        returns (P256VerifierSelection memory)
    {
        return P256VerifierConfig.select(chainId, configuredFallback, expectedFallbackCodehash);
    }

    function selectWithNative(
        address nativeVerifier,
        bool nativeSupported,
        address configuredFallback,
        bytes32 expectedFallbackCodehash
    ) external view returns (P256VerifierSelection memory) {
        return P256VerifierConfig.selectWithNative(
            nativeVerifier, nativeSupported, configuredFallback, expectedFallbackCodehash
        );
    }
}

contract DummyP256FallbackVerifier {}

contract P256VerifierConfigTest {
    P256VerifierConfigHarness internal harness;

    function setUp() public {
        harness = new P256VerifierConfigHarness();
    }

    function testNativePrecompileSupportedDoesNotRequireFallback() public view {
        P256VerifierSelection memory selection = harness.selectWithNative(address(0x100), true, address(0), bytes32(0));

        require(selection.verifier == address(0x100), "wrong native verifier");
        require(selection.mode == P256VerifierMode.NativePrecompile, "wrong verifier mode");
        require(selection.codehash == bytes32(0), "native precompile codehash should be zero");
        require(selection.nativePrecompileSupported, "native support not recorded");
        require(!selection.fallbackVerifierWasProvided, "fallback should not be required");
    }

    function testNativePrecompileSupportedIgnoresInvalidFallback() public view {
        P256VerifierSelection memory selection =
            harness.selectWithNative(address(0x100), true, address(0xBEEF), bytes32(uint256(1)));

        require(selection.verifier == address(0x100), "fallback unexpectedly selected");
        require(selection.mode == P256VerifierMode.NativePrecompile, "wrong verifier mode");
    }

    function testUnsupportedChainWithKnownFallbackSelectsFallbackContract() public {
        DummyP256FallbackVerifier fallbackVerifier = new DummyP256FallbackVerifier();
        bytes32 expectedCodehash = address(fallbackVerifier).codehash;

        P256VerifierSelection memory selection =
            harness.selectWithNative(address(0), false, address(fallbackVerifier), expectedCodehash);

        require(selection.verifier == address(fallbackVerifier), "wrong fallback verifier");
        require(selection.mode == P256VerifierMode.FallbackContract, "wrong verifier mode");
        require(selection.codehash == expectedCodehash, "wrong fallback codehash");
        require(!selection.nativePrecompileSupported, "native support incorrectly recorded");
        require(selection.fallbackVerifierWasProvided, "fallback provenance missing");
        require(!selection.fallbackVerifierWasDeployed, "script should not claim deployment");
    }

    function testUnsupportedChainWithoutFallbackReverts() public view {
        try harness.selectWithNative(address(0), false, address(0), bytes32(0)) {
            revert("missing fallback accepted");
        } catch (bytes memory reason) {
            require(
                keccak256(reason)
                    == keccak256(abi.encodeWithSelector(P256VerifierConfig.P256VerifierUnavailable.selector)),
                "wrong revert"
            );
        }
    }

    function testFallbackAddressWithNoCodeIsRejected() public view {
        try harness.selectWithNative(address(0), false, address(0xBEEF), bytes32(uint256(1))) {
            revert("fallback without code accepted");
        } catch (bytes memory reason) {
            require(
                keccak256(reason)
                    == keccak256(abi.encodeWithSelector(P256VerifierConfig.FallbackVerifierHasNoCode.selector)),
                "wrong revert"
            );
        }
    }

    function testFallbackCodehashIsRequired() public {
        DummyP256FallbackVerifier fallbackVerifier = new DummyP256FallbackVerifier();

        try harness.selectWithNative(address(0), false, address(fallbackVerifier), bytes32(0)) {
            revert("fallback without expected codehash accepted");
        } catch (bytes memory reason) {
            require(
                keccak256(reason)
                    == keccak256(abi.encodeWithSelector(P256VerifierConfig.FallbackVerifierCodehashRequired.selector)),
                "wrong revert"
            );
        }
    }

    function testWrongFallbackCodehashIsRejected() public {
        DummyP256FallbackVerifier fallbackVerifier = new DummyP256FallbackVerifier();
        bytes32 wrongCodehash = bytes32(uint256(1));

        try harness.selectWithNative(address(0), false, address(fallbackVerifier), wrongCodehash) {
            revert("wrong fallback codehash accepted");
        } catch (bytes memory reason) {
            bytes32 actualCodehash = address(fallbackVerifier).codehash;
            require(
                keccak256(reason)
                    == keccak256(
                        abi.encodeWithSelector(
                            P256VerifierConfig.WrongFallbackVerifierCodehash.selector, actualCodehash, wrongCodehash
                        )
                    ),
                "wrong revert"
            );
        }
    }

    function testSepoliaNativePrecompileIsNotClaimedWithoutEvidence() public view {
        try harness.select(11155111, address(0), bytes32(0)) {
            revert("Sepolia native precompile support was guessed");
        } catch (bytes memory reason) {
            require(
                keccak256(reason)
                    == keccak256(abi.encodeWithSelector(P256VerifierConfig.P256VerifierUnavailable.selector)),
                "wrong revert"
            );
        }
    }
}
