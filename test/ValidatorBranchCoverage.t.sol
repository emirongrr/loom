// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../src/libraries/ValidationDataLib.sol";
import {ECDSAValidator} from "../src/validators/ECDSAValidator.sol";
import {P256Validator} from "../src/validators/P256Validator.sol";
import {MockP256Verifier} from "./mocks/MockP256Verifier.sol";
import {MockPolicyHook} from "./mocks/MockPolicyHook.sol";
import {DenyPolicyHook} from "./mocks/DenyPolicyHook.sol";

interface VmValidatorCoverage {
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract ValidatorBranchCoverageTest {
    VmValidatorCoverage internal constant vm =
        VmValidatorCoverage(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;

    function testECDSAValidatorRejectsInvalidInitializationAndPolicyHookChanges() public {
        ECDSAValidator validator = new ECDSAValidator();
        MockPolicyHook hook = new MockPolicyHook();
        LoomAccount account = _ecdsaAccount(validator, address(hook));

        (bool initializedAgain,) =
            address(account).call(abi.encodeCall(ECDSAValidator.initialize, (vm.addr(OWNER_KEY), address(hook))));
        require(!initializedAgain, "validator initialized twice");

        bytes memory zeroOwner = abi.encodeCall(ECDSAValidator.setOwner, (address(0)));
        _schedule(account, address(validator), zeroOwner);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool ownerChanged,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, zeroOwner)));
        require(!ownerChanged, "zero owner accepted");

        bytes memory uninstalledHook = abi.encodeCall(ECDSAValidator.setPolicyHook, (address(new MockPolicyHook())));
        _schedule(account, address(validator), uninstalledHook);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool hookChanged,) = address(account)
            .call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, uninstalledHook)));
        require(!hookChanged, "uninstalled hook accepted");

        bytes32 digest = keccak256("invalid-signature");
        require(
            validator.validateUserOp(address(account), digest, 0, hex"deadbeef", bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "malformed signature accepted"
        );
    }

    function testECDSAValidatorValidationSkipsPolicyButRejectsRemovedHook() public {
        ECDSAValidator deniedValidator = new ECDSAValidator();
        DenyPolicyHook deniedHook = new DenyPolicyHook();
        LoomAccount deniedAccount = _ecdsaAccount(deniedValidator, address(deniedHook));
        bytes32 digest = keccak256("denied");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        require(
            deniedValidator.validateUserOp(address(deniedAccount), digest, 0, signature, bytes("call"), address(0))
                == 0,
            "validation read denied policy"
        );
        require(
            !deniedValidator.validateDirectExecution(address(deniedAccount), digest, signature, bytes("call")),
            "denied direct policy accepted"
        );

        ECDSAValidator validator = new ECDSAValidator();
        MockPolicyHook hook = new MockPolicyHook();
        LoomAccount account = _ecdsaAccount(validator, address(hook));
        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, address(hook), bytes("")));
        _schedule(account, address(account), uninstall);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, uninstall);

        require(
            validator.validateUserOp(address(account), digest, 0, signature, bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "removed hook accepted"
        );
        require(
            !validator.validateDirectExecution(address(account), digest, signature, bytes("call")),
            "removed hook accepted for direct execution"
        );
    }

    function testP256ValidatorRejectsInvalidInitializationAndPolicyHookChanges() public {
        P256Validator validator = new P256Validator(address(new MockP256Verifier()));
        MockPolicyHook hook = new MockPolicyHook();
        bytes memory origin = bytes("https://wallet.example");
        LoomAccount account = _p256Account(validator, address(hook), origin);

        (bool initializedAgain,) = address(account)
            .call(
                abi.encodeCall(
                    P256Validator.initialize,
                    (
                        bytes32(uint256(1)),
                        bytes32(uint256(2)),
                        keccak256("wallet.example"),
                        keccak256(origin),
                        address(hook)
                    )
                )
            );
        require(!initializedAgain, "P-256 validator initialized twice");

        bytes memory invalidKey = abi.encodeCall(
            P256Validator.setKey, (bytes32(0), bytes32(uint256(2)), keccak256("wallet.example"), keccak256(origin))
        );
        _schedule(account, address(validator), invalidKey);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool keyChanged,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, invalidKey)));
        require(!keyChanged, "invalid P-256 key accepted");

        bytes memory zeroHook = abi.encodeCall(P256Validator.setPolicyHook, (address(0)));
        _schedule(account, address(validator), zeroHook);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool hookChanged,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, zeroHook)));
        require(!hookChanged, "zero policy hook accepted");
    }

    function _ecdsaAccount(ECDSAValidator validator, address hook) internal returns (LoomAccount) {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, hook, "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (vm.addr(OWNER_KEY), hook))
        );
        return new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function _p256Account(P256Validator validator, address hook, bytes memory origin) internal returns (LoomAccount) {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, hook, "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (bytes32(uint256(1)), bytes32(uint256(2)), keccak256("wallet.example"), keccak256(origin), hook)
            )
        );
        return new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function _schedule(LoomAccount account, address target, bytes memory data) internal {
        bytes memory schedule = abi.encodeCall(LoomAccount.scheduleCall, (target, 0, data, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
    }
}
