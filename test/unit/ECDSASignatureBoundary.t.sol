// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {MockPolicyHook} from "../mocks/MockPolicyHook.sol";

interface VmECDSABoundary {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract ECDSASignatureBoundaryTest {
    VmECDSABoundary internal constant vm = VmECDSABoundary(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    ECDSAValidator internal validator;
    MockPolicyHook internal hook;
    LoomAccount internal account;

    function setUp() public {
        validator = new ECDSAValidator();
        hook = new MockPolicyHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (vm.addr(OWNER_KEY), address(hook)))
        );
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function testCanonical65ByteSignaturesAcceptBothVEncodings() public {
        bytes32 digest = keccak256("canonical-signature");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);

        require(_validate(digest, abi.encodePacked(r, s, v)) == 0, "canonical 27/28 signature rejected");
        require(_validate(digest, abi.encodePacked(r, s, v - 27)) == 0, "normalized 0/1 signature rejected");
        require(
            _validate(keccak256("wrong-digest"), abi.encodePacked(r, s, v)) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "signature accepted for wrong digest"
        );
    }

    function testCompactHighSInvalidVAndZeroComponentsFailClosed() public {
        bytes32 digest = keccak256("signature-boundaries");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        bytes32 compactS = bytes32(uint256(s) | uint256(v - 27) << 255);
        bytes32 highS = bytes32(SECP256K1_ORDER - uint256(s));
        uint8 alternateV = v == 27 ? 28 : 27;

        require(_validate(digest, abi.encodePacked(r, compactS)) == ValidationDataLib.SIG_VALIDATION_FAILED);
        require(_validate(digest, abi.encodePacked(r, highS, alternateV)) == ValidationDataLib.SIG_VALIDATION_FAILED);
        require(_validate(digest, abi.encodePacked(r, s, uint8(2))) == ValidationDataLib.SIG_VALIDATION_FAILED);
        require(_validate(digest, abi.encodePacked(r, s, uint8(29))) == ValidationDataLib.SIG_VALIDATION_FAILED);
        require(
            _validate(digest, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)))
                == ValidationDataLib.SIG_VALIDATION_FAILED
        );
        require(_validate(digest, bytes("")) == ValidationDataLib.SIG_VALIDATION_FAILED);
        require(
            _validate(digest, bytes.concat(abi.encodePacked(r, s, v), hex"00"))
                == ValidationDataLib.SIG_VALIDATION_FAILED
        );
    }

    function testMalformedAccountEnvelopeAndErc1271FailClosed() public {
        bytes32 digest = keccak256("account-envelope");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        bytes memory validatorSignature = abi.encodePacked(r, s, v);
        PackedUserOperation memory userOp = _emptyUserOp(address(account));

        userOp.signature = abi.encode(address(validator), validatorSignature);
        require(account.validateUserOp(userOp, digest, 0) == 0, "valid account envelope rejected");

        userOp.signature = hex"deadbeef";
        require(
            account.validateUserOp(userOp, digest, 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "malformed account envelope accepted"
        );

        bytes memory validEnvelope = abi.encode(address(validator), validatorSignature);
        require(account.isValidSignature(digest, validEnvelope) == account.ERC1271_INVALID());
        require(account.isValidSignature(digest, hex"deadbeef") == account.ERC1271_INVALID());
        require(
            account.isValidSignature(digest, abi.encode(address(0xBEEF), validatorSignature))
                == account.ERC1271_INVALID()
        );
    }

    function testZeroOwnerInitializationRevertsWithInvalidOwner() public {
        ECDSAValidator zeroOwnerValidator = new ECDSAValidator();
        (bool initialized, bytes memory reason) =
            address(zeroOwnerValidator).call(abi.encodeCall(ECDSAValidator.initialize, (address(0), address(hook))));
        require(!initialized, "zero owner initialized");
        require(reason.length >= 4, "zero-owner revert data malformed");
        // Safe after checking that the revert data contains a complete selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(reason);
        require(selector == ECDSAValidator.InvalidOwner.selector, "zero owner failed for an unexpected reason");
    }

    function _validate(bytes32 digest, bytes memory signature) internal view returns (uint256) {
        return validator.validateUserOp(address(account), digest, 0, signature, bytes("call"), address(0));
    }

    function _emptyUserOp(address sender) internal pure returns (PackedUserOperation memory userOp) {
        userOp.sender = sender;
        userOp.accountGasLimits = bytes32((uint256(10_000_000) << 128) | uint256(2_000_000));
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(1 gwei));
    }
}
