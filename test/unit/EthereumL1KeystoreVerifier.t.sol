// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EthereumL1KeystoreVerifier} from "../../src/keystore/EthereumL1KeystoreVerifier.sol";
import {LoomKeystore} from "../../src/keystore/LoomKeystore.sol";
import {ILoomKeystore} from "../../src/interfaces/ILoomKeystore.sol";

contract EthereumL1KeystoreVerifierTest {
    bytes32 internal constant IDENTITY_ID = keccak256("loom.identity.l1");
    bytes32 internal constant VALIDATOR_ROOT = keccak256("validator root");
    bytes32 internal constant GUARDIAN_ROOT = keccak256("guardian root");
    bytes32 internal constant APP_ACCOUNT_ROOT = keccak256("app account root");

    function testDirectL1VerifierAcceptsExactKeystoreConfig() public {
        (LoomKeystore keystore, EthereumL1KeystoreVerifier verifier) = _registeredKeystore();
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);

        require(
            verifier.verifyKeystoreConfig(address(keystore), IDENTITY_ID, config.version, config, ""),
            "exact l1 config rejected"
        );
    }

    function testDirectL1VerifierRejectsMissingIdentityWrongKeystoreAndProofBytes() public {
        (LoomKeystore keystore, EthereumL1KeystoreVerifier verifier) = _registeredKeystore();
        LoomKeystore otherKeystore = new LoomKeystore();
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);

        require(
            !verifier.verifyKeystoreConfig(address(keystore), keccak256("missing"), config.version, config, ""),
            "missing identity accepted"
        );
        require(
            !verifier.verifyKeystoreConfig(address(otherKeystore), IDENTITY_ID, config.version, config, ""),
            "wrong keystore accepted"
        );
        require(
            !verifier.verifyKeystoreConfig(address(keystore), IDENTITY_ID, config.version, config, hex"01"),
            "non-empty proof accepted"
        );
    }

    function testDirectL1VerifierRejectsMismatchedConfigAndVersion() public {
        (LoomKeystore keystore, EthereumL1KeystoreVerifier verifier) = _registeredKeystore();
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);

        ILoomKeystore.KeystoreConfig memory wrongGuardianRoot = config;
        wrongGuardianRoot.guardianRoot = keccak256("wrong guardian root");
        require(
            !verifier.verifyKeystoreConfig(
                address(keystore), IDENTITY_ID, wrongGuardianRoot.version, wrongGuardianRoot, ""
            ),
            "wrong guardian root accepted"
        );

        ILoomKeystore.KeystoreConfig memory wrongThreshold = config;
        wrongThreshold.guardianThreshold = 2;
        require(
            !verifier.verifyKeystoreConfig(address(keystore), IDENTITY_ID, wrongThreshold.version, wrongThreshold, ""),
            "wrong threshold accepted"
        );

        require(
            !verifier.verifyKeystoreConfig(address(keystore), IDENTITY_ID, config.version + 1, config, ""),
            "wrong version accepted"
        );
    }

    function testDirectL1VerifierConstructorRejectsNonContractKeystore() public {
        (bool ok,) = address(this).call(abi.encodeCall(this.deployVerifier, (address(0xBEEF))));
        require(!ok, "non-contract keystore accepted");
    }

    function deployVerifier(address keystore) external returns (EthereumL1KeystoreVerifier) {
        return new EthereumL1KeystoreVerifier(keystore);
    }

    function _registeredKeystore() internal returns (LoomKeystore keystore, EthereumL1KeystoreVerifier verifier) {
        keystore = new LoomKeystore();
        keystore.register(IDENTITY_ID, address(this), VALIDATOR_ROOT, GUARDIAN_ROOT, APP_ACCOUNT_ROOT, 1);
        verifier = new EthereumL1KeystoreVerifier(address(keystore));
    }
}
