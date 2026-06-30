// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {OPStackL2KeystoreVerifier} from "../src/keystore/OPStackL2KeystoreVerifier.sol";
import {LoomKeystore} from "../src/keystore/LoomKeystore.sol";
import {ILoomKeystore} from "../src/interfaces/ILoomKeystore.sol";

interface VmOPStack {
    function load(address target, bytes32 slot) external view returns (bytes32);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes32(string calldata json, string calldata key) external view returns (bytes32);
    function parseJsonBytesArray(string calldata json, string calldata key) external view returns (bytes[] memory);
    function parseJsonAddress(string calldata json, string calldata key) external view returns (address);
    function parseJsonUint(string calldata json, string calldata key) external view returns (uint256);
}

/// @notice Returns a settable Ethereum L1 state root, standing in for the OP Stack
/// `L1Block` predeploy.
contract MockL1Block {
    bytes32 public stateRoot;

    function set(bytes32 root) external {
        stateRoot = root;
    }
}

contract OPStackL2KeystoreVerifierTest {
    VmOPStack internal constant vm = VmOPStack(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant IDENTITY_ID = keccak256("loom.identity.op");
    bytes32 internal constant VALIDATOR_ROOT = keccak256("validator root");
    bytes32 internal constant GUARDIAN_ROOT = keccak256("guardian root");
    bytes32 internal constant APP_ACCOUNT_ROOT = keccak256("app account root");
    uint8 internal constant THRESHOLD = 3;
    bytes32 internal constant NON_ZERO_ROOT = keccak256("state root");

    address internal constant L1_KEYSTORE = address(uint160(uint256(keccak256("loom.l1.keystore"))));

    function _config() internal pure returns (ILoomKeystore.KeystoreConfig memory) {
        return ILoomKeystore.KeystoreConfig({
            validatorRoot: VALIDATOR_ROOT,
            guardianRoot: GUARDIAN_ROOT,
            appAccountRoot: APP_ACCOUNT_ROOT,
            guardianThreshold: THRESHOLD,
            version: 1
        });
    }

    function _deploy() internal returns (OPStackL2KeystoreVerifier verifier, MockL1Block l1Block) {
        l1Block = new MockL1Block();
        l1Block.set(NON_ZERO_ROOT);
        verifier = new OPStackL2KeystoreVerifier(L1_KEYSTORE, address(l1Block));
    }

    // --- constructor ---

    function testConstructorRejectsZeroKeystore() public {
        MockL1Block l1Block = new MockL1Block();
        (bool ok,) = address(this).call(abi.encodeCall(this.deployVerifier, (address(0), address(l1Block))));
        require(!ok, "zero keystore accepted");
    }

    function testConstructorRejectsNonContractL1Block() public {
        (bool ok,) = address(this).call(abi.encodeCall(this.deployVerifier, (L1_KEYSTORE, address(0xBEEF))));
        require(!ok, "non-contract l1Block accepted");
    }

    function deployVerifier(address keystore, address l1Block) external returns (OPStackL2KeystoreVerifier) {
        return new OPStackL2KeystoreVerifier(keystore, l1Block);
    }

    // --- input validation (short-circuits before any trie work) ---

    function testRejectsInvalidInputs() public {
        (OPStackL2KeystoreVerifier verifier,) = _deploy();
        ILoomKeystore.KeystoreConfig memory config = _config();
        bytes memory proof = hex"01"; // non-empty; never reached for these cases

        require(
            !verifier.verifyKeystoreConfig(address(0xDEAD), IDENTITY_ID, 1, config, proof), "wrong keystore accepted"
        );
        require(!verifier.verifyKeystoreConfig(L1_KEYSTORE, bytes32(0), 1, config, proof), "zero identity accepted");
        require(!verifier.verifyKeystoreConfig(L1_KEYSTORE, IDENTITY_ID, 0, config, proof), "zero version accepted");

        ILoomKeystore.KeystoreConfig memory mismatched = config;
        mismatched.version = 2;
        require(
            !verifier.verifyKeystoreConfig(L1_KEYSTORE, IDENTITY_ID, 1, mismatched, proof),
            "config version mismatch accepted"
        );

        require(!verifier.verifyKeystoreConfig(L1_KEYSTORE, IDENTITY_ID, 1, config, ""), "empty proof accepted");
    }

    // --- proof body fails closed to false ---

    function testRejectsZeroStateRoot() public {
        (OPStackL2KeystoreVerifier verifier, MockL1Block l1Block) = _deploy();
        l1Block.set(bytes32(0));
        require(
            !verifier.verifyKeystoreConfig(L1_KEYSTORE, IDENTITY_ID, 1, _config(), hex"01"), "zero state root accepted"
        );
    }

    function testRejectsMalformedProofBytes() public {
        (OPStackL2KeystoreVerifier verifier,) = _deploy();
        // Non-empty but not a valid abi-encoded KeystoreProof: decode reverts, caught as false.
        require(
            !verifier.verifyKeystoreConfig(L1_KEYSTORE, IDENTITY_ID, 1, _config(), hex"01020304"),
            "malformed proof accepted"
        );
    }

    function testVerifyProvenConfigRejectsExternalCaller() public {
        (OPStackL2KeystoreVerifier verifier,) = _deploy();
        (bool ok,) =
            address(verifier).call(abi.encodeCall(verifier.verifyProvenConfig, (IDENTITY_ID, 1, _config(), hex"01")));
        require(!ok, "external caller of verifyProvenConfig accepted");
    }

    // --- storage layout pin: the verifier's slot derivation and packing must match
    //     LoomKeystore's real storage layout, or proofs would target the wrong slots. ---

    function testStorageLayoutPinMatchesVerifierAssumptions() public {
        LoomKeystore keystore = new LoomKeystore();
        keystore.register(IDENTITY_ID, address(this), VALIDATOR_ROOT, GUARDIAN_ROOT, APP_ACCOUNT_ROOT, THRESHOLD);
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);

        // controllerOf is mapping slot 0.
        bytes32 controllerSlot = keccak256(abi.encode(IDENTITY_ID, uint256(0)));
        require(
            address(uint160(uint256(vm.load(address(keystore), controllerSlot)))) == address(this),
            "controllerOf not at slot 0"
        );

        // _configs is mapping slot 1; the verifier uses base = keccak256(abi.encode(id, 1)).
        uint256 base = uint256(keccak256(abi.encode(IDENTITY_ID, uint256(1))));
        require(vm.load(address(keystore), bytes32(base)) == VALIDATOR_ROOT, "validatorRoot slot mismatch");
        require(vm.load(address(keystore), bytes32(base + 1)) == GUARDIAN_ROOT, "guardianRoot slot mismatch");
        require(vm.load(address(keystore), bytes32(base + 2)) == APP_ACCOUNT_ROOT, "appAccountRoot slot mismatch");

        uint256 packed = uint256(vm.load(address(keystore), bytes32(base + 3)));
        // Truncation is intended: this mirrors the verifier's packed-slot decoding.
        // forge-lint: disable-next-line(unsafe-typecast)
        require(uint8(packed) == THRESHOLD, "guardianThreshold packing mismatch");
        // forge-lint: disable-next-line(unsafe-typecast)
        require(uint64(packed >> 8) == config.version, "version packing mismatch");
        require(config.version == 1, "unexpected initial version");
    }

    // --- fixture-backed EIP-1186 proof verification ---
    //     Fixture generated by tools/keystore/generate-op-stack-fixture.mjs.

    string internal constant FIXTURE = "test/fixtures/op-stack-keystore-proof.json";

    struct Loaded {
        OPStackL2KeystoreVerifier verifier;
        MockL1Block l1Block;
        address keystore;
        bytes32 identityId;
        uint64 version;
        ILoomKeystore.KeystoreConfig config;
        bytes proof;
    }

    function _load() internal returns (Loaded memory loaded) {
        string memory json = vm.readFile(FIXTURE);
        loaded.keystore = vm.parseJsonAddress(json, ".keystore");
        loaded.identityId = vm.parseJsonBytes32(json, ".identityId");
        loaded.version = uint64(vm.parseJsonUint(json, ".version"));
        loaded.config = ILoomKeystore.KeystoreConfig({
            validatorRoot: vm.parseJsonBytes32(json, ".config.validatorRoot"),
            guardianRoot: vm.parseJsonBytes32(json, ".config.guardianRoot"),
            appAccountRoot: vm.parseJsonBytes32(json, ".config.appAccountRoot"),
            guardianThreshold: uint8(vm.parseJsonUint(json, ".config.guardianThreshold")),
            version: uint64(vm.parseJsonUint(json, ".config.version"))
        });

        OPStackL2KeystoreVerifier.KeystoreProof memory p;
        p.accountProof = vm.parseJsonBytesArray(json, ".accountProof");
        p.validatorRootProof = vm.parseJsonBytesArray(json, ".validatorRootProof");
        p.guardianRootProof = vm.parseJsonBytesArray(json, ".guardianRootProof");
        p.appAccountRootProof = vm.parseJsonBytesArray(json, ".appAccountRootProof");
        p.packedProof = vm.parseJsonBytesArray(json, ".packedProof");
        loaded.proof = abi.encode(p);

        loaded.l1Block = new MockL1Block();
        loaded.l1Block.set(vm.parseJsonBytes32(json, ".stateRoot"));
        loaded.verifier = new OPStackL2KeystoreVerifier(loaded.keystore, address(loaded.l1Block));
    }

    function _verify(Loaded memory l, ILoomKeystore.KeystoreConfig memory config, uint64 version)
        internal
        view
        returns (bool)
    {
        return l.verifier.verifyKeystoreConfig(l.keystore, l.identityId, version, config, l.proof);
    }

    function testAcceptsValidProof() public {
        Loaded memory l = _load();
        require(_verify(l, l.config, l.version), "valid proof rejected");
    }

    function testRejectsStaleStateRoot() public {
        Loaded memory l = _load();
        l.l1Block.set(keccak256("some other state root"));
        require(!_verify(l, l.config, l.version), "stale state root accepted");
    }

    function testRejectsMismatchedValidatorRoot() public {
        Loaded memory l = _load();
        ILoomKeystore.KeystoreConfig memory wrong = l.config;
        wrong.validatorRoot = keccak256("wrong validator root");
        require(!_verify(l, wrong, l.version), "wrong validatorRoot accepted");
    }

    function testRejectsMismatchedGuardianRoot() public {
        Loaded memory l = _load();
        ILoomKeystore.KeystoreConfig memory wrong = l.config;
        wrong.guardianRoot = keccak256("wrong guardian root");
        require(!_verify(l, wrong, l.version), "wrong guardianRoot accepted");
    }

    function testRejectsMismatchedAppAccountRoot() public {
        Loaded memory l = _load();
        ILoomKeystore.KeystoreConfig memory wrong = l.config;
        wrong.appAccountRoot = keccak256("wrong app account root");
        require(!_verify(l, wrong, l.version), "wrong appAccountRoot accepted");
    }

    function testRejectsMismatchedThreshold() public {
        Loaded memory l = _load();
        ILoomKeystore.KeystoreConfig memory wrong = l.config;
        wrong.guardianThreshold = l.config.guardianThreshold + 1;
        require(!_verify(l, wrong, l.version), "wrong threshold accepted");
    }

    function testRejectsMismatchedProvenVersion() public {
        Loaded memory l = _load();
        // config.version must equal the version argument to pass input validation;
        // the proven (fixture) version is 1, so a consistent (2,2) request must still
        // be rejected by the packed-slot version check.
        ILoomKeystore.KeystoreConfig memory wrong = l.config;
        wrong.version = l.version + 1;
        require(!_verify(l, wrong, l.version + 1), "wrong proven version accepted");
    }

    function testRejectsWrongIdentity() public {
        Loaded memory l = _load();
        // A different identity derives different storage slots, so the supplied
        // proofs no longer prove inclusion: trie verification reverts, caught as false.
        require(
            !l.verifier.verifyKeystoreConfig(l.keystore, keccak256("other identity"), l.version, l.config, l.proof),
            "wrong identity accepted"
        );
    }

    function testRejectsTamperedAccountProof() public {
        Loaded memory l = _load();
        string memory json = vm.readFile(FIXTURE);
        OPStackL2KeystoreVerifier.KeystoreProof memory p;
        p.accountProof = vm.parseJsonBytesArray(json, ".accountProof");
        p.validatorRootProof = vm.parseJsonBytesArray(json, ".validatorRootProof");
        p.guardianRootProof = vm.parseJsonBytesArray(json, ".guardianRootProof");
        p.appAccountRootProof = vm.parseJsonBytesArray(json, ".appAccountRootProof");
        p.packedProof = vm.parseJsonBytesArray(json, ".packedProof");
        // Flip one byte of the account node: the root hash no longer matches.
        p.accountProof[0][0] = bytes1(uint8(p.accountProof[0][0]) ^ 0xFF);
        bytes memory tampered = abi.encode(p);
        require(
            !l.verifier.verifyKeystoreConfig(l.keystore, l.identityId, l.version, l.config, tampered),
            "tampered account proof accepted"
        );
    }
}
