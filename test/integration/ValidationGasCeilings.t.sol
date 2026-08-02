// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {ILoomAccount} from "../../src/interfaces/ILoomAccount.sol";
import {IGuardianVerifier} from "../../src/interfaces/IGuardianVerifier.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidatorSetLib} from "../../src/libraries/ValidatorSetLib.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {P256Validator} from "../../src/validators/P256Validator.sol";
import {MockP256Verifier} from "../mocks/MockP256Verifier.sol";
import {MockPolicyHook} from "../mocks/MockPolicyHook.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {P256TestKeys} from "../helpers/P256TestKeys.sol";

interface VmGasCeilings {
    function etch(address target, bytes calldata code) external;
}

contract GuardianApprovalGasHarness {
    uint256 public constant MAX_SIGNATURES = GuardianVerificationLib.MAX_SIGNATURES;
    uint256 public constant MAX_PROOF_LENGTH = GuardianVerificationLib.MAX_PROOF_LENGTH;

    function approved(
        bytes32 root,
        uint256 threshold,
        bytes32 digest,
        GuardianVerificationLib.Approval[] calldata approvals
    ) external view returns (bool) {
        return GuardianVerificationLib.approved(root, threshold, digest, approvals);
    }
}

contract ValidatorSetGasHarness {
    uint256 public constant MAX_VALIDATORS = ValidatorSetLib.MAX_VALIDATORS;

    function isValidNewSet(ILoomAccount account, ILoomAccount.RecoveryModuleInit[] calldata validators)
        external
        view
        returns (bool)
    {
        return ValidatorSetLib.isValidNewSet(account, validators);
    }
}

contract ValidationGasCeilingsTest {
    VmGasCeilings internal constant vm = VmGasCeilings(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Fixed address and hand-written runtime for the always-valid guardian
    /// verifier used by the guardian gas ceilings.
    ///
    /// A guardian leaf binds `verifier.codehash`, which is a production security
    /// property and must not change. But when the verifier was a Solidity contract
    /// declared in this file, its code -- and therefore its codehash -- carried
    /// solc's metadata hash, which covers every source in the compilation unit.
    /// Editing an unrelated imported file, even by adding a comment, changed the
    /// codehash, which changed the leaves, which changed their sorted order, which
    /// changed the Merkle proof shapes and so the gas these tests consume. That made
    /// the gas snapshot gate report drift on changes that could not possibly affect
    /// guardian verification.
    ///
    /// Etching a fixed 10-byte runtime removes the compilation unit from the
    /// picture entirely: both the address and the codehash are now constants. The
    /// runtime ignores its calldata and returns a 32-byte word of 1, which is what
    /// `IGuardianVerifier.verify` returning `true` looks like on the wire:
    ///   PUSH1 0x01, PUSH1 0x00, MSTORE, PUSH1 0x20, PUSH1 0x00, RETURN
    address internal constant ALWAYS_VALID_VERIFIER = address(uint160(uint256(keccak256("loom.test.always-valid"))));
    bytes internal constant ALWAYS_VALID_VERIFIER_RUNTIME = hex"600160005260206000f3";

    uint256 internal constant MAX_WEBAUTHN_VALIDATION_GAS = 1_500_000;
    uint256 internal constant MAX_GUARDIAN_APPROVAL_GAS = 1_500_000;
    uint256 internal constant MAX_GUARDIAN_PROOF_GAS = 400_000;
    uint256 internal constant MAX_VALIDATOR_SET_GAS = 600_000;

    function testMaximumWebAuthnInputStaysUnderGasCeiling() public {
        MockP256Verifier verifier = new MockP256Verifier();
        P256Validator validator = new P256Validator(address(verifier));
        MockPolicyHook hook = new MockPolicyHook();
        bytes32 hash = keccak256("maximum-webauthn-input");
        bytes memory origin = _filledBytes(validator.MAX_ORIGIN_LENGTH(), "o");
        bytes memory clientDataJSON = _maximumClientDataJSON(hash, origin, validator.MAX_CLIENT_DATA_JSON_LENGTH());
        bytes memory authenticatorData = new bytes(validator.MAX_AUTHENTICATOR_DATA_LENGTH());
        bytes32 rpIdHash = keccak256("wallet.example");
        assembly ("memory-safe") {
            mstore(add(authenticatorData, 32), rpIdHash)
        }
        authenticatorData[32] = bytes1(uint8(0x05));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (P256TestKeys.x(1), P256TestKeys.y(1), rpIdHash, keccak256(origin), address(hook))
            )
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        P256Validator.WebAuthnSignature memory signature = P256Validator.WebAuthnSignature({
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON,
            origin: origin,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(1))
        });

        uint256 gasBefore = gasleft();
        uint256 result = validator.validateUserOp(address(account), hash, 0, abi.encode(signature), "", address(0));
        uint256 gasUsed = gasBefore - gasleft();

        require(result != ValidationDataLib.SIG_VALIDATION_FAILED, "maximum WebAuthn input rejected");
        require(gasUsed <= MAX_WEBAUTHN_VALIDATION_GAS, "maximum WebAuthn input exceeded gas ceiling");
    }

    function testMaximumGuardianApprovalsStayUnderGasCeiling() public {
        address verifier = _alwaysValidVerifier();
        GuardianApprovalGasHarness harness = new GuardianApprovalGasHarness();
        uint256 count = harness.MAX_SIGNATURES();
        (bytes32 root, GuardianVerificationLib.Approval[] memory approvals) = _guardianTreeApprovals(verifier, count);

        uint256 gasBefore = gasleft();
        bool valid = harness.approved(root, count, keccak256("guardian-approval-ceiling"), approvals);
        uint256 gasUsed = gasBefore - gasleft();

        require(valid, "maximum guardian approvals rejected");
        require(gasUsed <= MAX_GUARDIAN_APPROVAL_GAS, "maximum guardian approvals exceeded gas ceiling");
    }

    function testMaximumGuardianProofStaysUnderGasCeiling() public {
        address verifier = _alwaysValidVerifier();
        GuardianApprovalGasHarness harness = new GuardianApprovalGasHarness();
        bytes32 keyCommitment = bytes32(uint256(1));
        bytes32 salt = keccak256("maximum-proof");
        bytes32 leaf = keccak256(abi.encode(address(verifier), address(verifier).codehash, keyCommitment, salt));
        bytes32[] memory proof = new bytes32[](harness.MAX_PROOF_LENGTH());
        bytes32 root = leaf;
        for (uint256 i; i < proof.length; ++i) {
            proof[i] = keccak256(abi.encode("proof-sibling", i));
            root = _hashPair(root, proof[i]);
        }
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval({
            verifier: address(verifier), keyCommitment: keyCommitment, salt: salt, signature: "", proof: proof
        });

        uint256 gasBefore = gasleft();
        bool valid = harness.approved(root, 1, keccak256("guardian-proof-ceiling"), approvals);
        uint256 gasUsed = gasBefore - gasleft();

        require(valid, "maximum guardian proof rejected");
        require(gasUsed <= MAX_GUARDIAN_PROOF_GAS, "maximum guardian proof exceeded gas ceiling");
    }

    function testMaximumValidatorSetStaysUnderGasCeiling() public {
        ValidatorSetGasHarness harness = new ValidatorSetGasHarness();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        uint256 count = harness.MAX_VALIDATORS();
        ILoomAccount.RecoveryModuleInit[] memory validators = new ILoomAccount.RecoveryModuleInit[](count);
        for (uint256 i; i < count; ++i) {
            validators[i] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        }
        _sortValidators(validators);

        uint256 gasBefore = gasleft();
        bool valid = harness.isValidNewSet(account, validators);
        uint256 gasUsed = gasBefore - gasleft();

        require(valid, "maximum validator set rejected");
        require(gasUsed <= MAX_VALIDATOR_SET_GAS, "maximum validator set exceeded gas ceiling");
    }

    function _maximumClientDataJSON(bytes32 hash, bytes memory origin, uint256 maximumLength)
        internal
        pure
        returns (bytes memory clientDataJSON)
    {
        bytes memory prefix = bytes.concat(
            bytes('{"type":"webauthn.get","challenge":"'),
            _base64Url(hash),
            bytes('","origin":"'),
            origin,
            bytes('","padding":"')
        );
        bytes memory suffix = bytes('"}');
        require(prefix.length + suffix.length <= maximumLength, "maximum client data is too short");
        clientDataJSON = bytes.concat(prefix, _filledBytes(maximumLength - prefix.length - suffix.length, "p"), suffix);
        require(clientDataJSON.length == maximumLength, "client data did not reach maximum");
    }

    function _alwaysValidVerifier() internal returns (address) {
        vm.etch(ALWAYS_VALID_VERIFIER, ALWAYS_VALID_VERIFIER_RUNTIME);
        return ALWAYS_VALID_VERIFIER;
    }

    function _guardianTreeApprovals(address verifier, uint256 count)
        internal
        view
        returns (bytes32 root, GuardianVerificationLib.Approval[] memory approvals)
    {
        bytes32[] memory leaves = new bytes32[](count);
        bytes32[] memory commitments = new bytes32[](count);
        bytes32[] memory salts = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            commitments[i] = bytes32(i + 1);
            salts[i] = keccak256(abi.encode("guardian-salt", i));
            leaves[i] = keccak256(abi.encode(address(verifier), address(verifier).codehash, commitments[i], salts[i]));
        }
        _sortGuardianInputs(leaves, commitments, salts);
        root = _merkleRoot(leaves);
        approvals = new GuardianVerificationLib.Approval[](count);
        for (uint256 i; i < count; ++i) {
            approvals[i] = GuardianVerificationLib.Approval({
                verifier: address(verifier),
                keyCommitment: commitments[i],
                salt: salts[i],
                signature: "",
                proof: _merkleProof(leaves, i)
            });
        }
    }

    function _sortGuardianInputs(bytes32[] memory leaves, bytes32[] memory commitments, bytes32[] memory salts)
        internal
        pure
    {
        for (uint256 i = 1; i < leaves.length; ++i) {
            uint256 j = i;
            while (j > 0 && leaves[j] < leaves[j - 1]) {
                (leaves[j], leaves[j - 1]) = (leaves[j - 1], leaves[j]);
                (commitments[j], commitments[j - 1]) = (commitments[j - 1], commitments[j]);
                (salts[j], salts[j - 1]) = (salts[j - 1], salts[j]);
                --j;
            }
        }
    }

    function _sortValidators(ILoomAccount.RecoveryModuleInit[] memory validators) internal pure {
        for (uint256 i = 1; i < validators.length; ++i) {
            uint256 j = i;
            while (j > 0 && validators[j].module < validators[j - 1].module) {
                (validators[j], validators[j - 1]) = (validators[j - 1], validators[j]);
                --j;
            }
        }
    }

    function _merkleRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            bytes32[] memory next = new bytes32[](level.length / 2);
            for (uint256 i; i < next.length; ++i) {
                next[i] = _hashPair(level[i * 2], level[i * 2 + 1]);
            }
            level = next;
        }
        return level[0];
    }

    function _merkleProof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory proof) {
        uint256 depth;
        for (uint256 width = leaves.length; width > 1; width /= 2) {
            ++depth;
        }
        proof = new bytes32[](depth);
        bytes32[] memory level = leaves;
        for (uint256 d; d < depth; ++d) {
            proof[d] = level[index ^ 1];
            bytes32[] memory next = new bytes32[](level.length / 2);
            for (uint256 i; i < next.length; ++i) {
                next[i] = _hashPair(level[i * 2], level[i * 2 + 1]);
            }
            level = next;
            index /= 2;
        }
    }

    function _hashPair(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return left <= right ? keccak256(abi.encodePacked(left, right)) : keccak256(abi.encodePacked(right, left));
    }

    function _filledBytes(uint256 length, bytes1 value) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; ++i) {
            out[i] = value;
        }
    }

    function _base64Url(bytes32 input) internal pure returns (bytes memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory out = new bytes(43);
        uint256 buffer;
        uint256 bits;
        uint256 outputIndex;
        for (uint256 i; i < 32; ++i) {
            buffer = (buffer << 8) | uint8(input[i]);
            bits += 8;
            while (bits >= 6) {
                bits -= 6;
                out[outputIndex++] = table[(buffer >> bits) & 0x3f];
            }
        }
        if (bits > 0) out[outputIndex] = table[(buffer << (6 - bits)) & 0x3f];
        return out;
    }
}
