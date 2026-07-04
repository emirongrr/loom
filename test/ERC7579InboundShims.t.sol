// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {ERC7579ValidatorShim} from "../src/adapters/ERC7579ValidatorShim.sol";
import {ERC7579HookShim} from "../src/adapters/ERC7579HookShim.sol";
import {IERC7579Validator} from "../src/interfaces/IERC7579Validator.sol";
import {IERC7579Hook} from "../src/interfaces/IERC7579Hook.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MockERC7579Validator} from "./mocks/MockERC7579Validator.sol";
import {MockERC7579Hook} from "./mocks/MockERC7579Hook.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockTarget} from "./mocks/MockTarget.sol";

interface Vm {
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract ERC7579InboundShimsTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xB0B;

    LoomAccount internal account;
    MockValidator internal primary;
    address internal owner;

    function setUp() public {
        primary = new MockValidator();
        owner = vm.addr(OWNER_KEY);
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(primary), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function testForeignValidatorRunsThroughShimAndReconstructsAccountAsSender() public {
        MockERC7579Validator target = new MockERC7579Validator();
        ERC7579ValidatorShim shim = new ERC7579ValidatorShim(address(account), IERC7579Validator(address(target)));
        _installModule(
            ModuleType.VALIDATOR, address(shim), abi.encodeCall(IERC7579Validator.onInstall, (abi.encode(owner)))
        );

        require(target.owners(address(shim)) == owner, "onInstall not forwarded with shim identity");
        require(shim.isInitialized(address(account)), "shim not reported initialized");

        bytes32 userOpHash = keccak256("user-op");
        uint256 validationData = _validateThroughAccount(shim, userOpHash, _sign(OWNER_KEY, userOpHash));
        require(validationData == 0, "valid foreign signature rejected");
        require(target.lastObservedSender() == address(account), "shim did not reconstruct account as userOp.sender");

        // Wrong signer fails closed through the account's try/catch mapping.
        uint256 badData = _validateThroughAccount(shim, userOpHash, _sign(0xBAD, userOpHash));
        require(badData == 1, "invalid foreign signature accepted");

        // ERC-1271 path maps the target magic value to Loom's bool contract.
        bytes32 msgHash = keccak256("erc1271");
        bytes4 magic = account.isValidSignature(msgHash, abi.encode(address(shim), _sign(OWNER_KEY, msgHash)));
        require(magic == bytes4(0x1626ba7e), "foreign ERC-1271 signature not accepted");
        bytes4 invalid = account.isValidSignature(msgHash, abi.encode(address(shim), _sign(0xBAD, msgHash)));
        require(invalid == bytes4(0xffffffff), "foreign ERC-1271 forgery accepted");
    }

    function testForeignValidatorUninstallForwardsAndClearsState() public {
        MockERC7579Validator target = new MockERC7579Validator();
        ERC7579ValidatorShim shim = new ERC7579ValidatorShim(address(account), IERC7579Validator(address(target)));
        // A second validator is required so the account never drops to zero validators.
        MockValidator keepAlive = new MockValidator();
        _installModule(ModuleType.VALIDATOR, address(keepAlive), "");
        _installModule(
            ModuleType.VALIDATOR, address(shim), abi.encodeCall(IERC7579Validator.onInstall, (abi.encode(owner)))
        );

        _uninstallModule(
            ModuleType.VALIDATOR, address(shim), abi.encodeCall(IERC7579Validator.onUninstall, (bytes("")))
        );
        require(target.owners(address(shim)) == address(0), "onUninstall not forwarded");
        require(!shim.isInitialized(address(account)), "shim still initialized after uninstall");
    }

    function testForeignHookRunsThroughShimOnEveryExecution() public {
        MockERC7579Hook target = new MockERC7579Hook();
        ERC7579HookShim shim = new ERC7579HookShim(address(account), IERC7579Hook(address(target)));
        _installModule(ModuleType.HOOK, address(shim), abi.encodeCall(IERC7579Hook.onInstall, (bytes(""))));
        require(target.installed(address(shim)), "hook onInstall not forwarded");

        MockTarget mock = new MockTarget();
        bytes memory call = abi.encodeCall(MockTarget.setValue, (7));
        bytes memory accountCall = abi.encodeCall(
            LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(mock), 0, call)))
        );
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(mock), 0, call)));

        require(mock.value() == 7, "execution did not run under hook");
        require(target.preChecks() == 1 && target.postChecks() == 1, "hook pre/post not invoked exactly once");
        require(target.lastMsgSender() == address(this), "hook did not observe the caller as msgSender");
        require(target.lastMsgValue() == 0, "hook msgValue not zeroed at the documented boundary");
        require(target.lastMsgDataHash() == keccak256(accountCall), "hook did not observe the account call as msgData");
    }

    function testShimRejectsForeignAndMismatchedCallers() public {
        MockERC7579Validator target = new MockERC7579Validator();
        ERC7579ValidatorShim shim = new ERC7579ValidatorShim(address(account), IERC7579Validator(address(target)));

        // onInstall is only callable by the bound account, never directly.
        (bool directInstall,) = address(shim).call(abi.encodeCall(IERC7579Validator.onInstall, (abi.encode(owner))));
        require(!directInstall, "foreign caller ran shim onInstall");

        _installModule(
            ModuleType.VALIDATOR, address(shim), abi.encodeCall(IERC7579Validator.onInstall, (abi.encode(owner)))
        );

        // validateUserOp for a different account is refused.
        (bool wrongAccount,) = address(shim)
            .call(
                abi.encodeCall(
                    ERC7579ValidatorShim.validateUserOp,
                    (address(0xBEEF), keccak256("h"), 0, _sign(OWNER_KEY, keccak256("h")), bytes(""), address(0))
                )
            );
        require(!wrongAccount, "shim served an unbound account");
        require(!shim.isInitialized(address(0xBEEF)), "shim initialized for an unbound account");

        // Even with the correct bound account named, a caller other than the
        // account itself cannot drive the (possibly stateful) foreign target.
        (bool foreignDriver,) = address(shim)
            .call(
                abi.encodeCall(
                    ERC7579ValidatorShim.validateUserOp,
                    (address(account), keccak256("h"), 0, _sign(OWNER_KEY, keccak256("h")), bytes(""), address(0))
                )
            );
        require(!foreignDriver, "non-account caller drove the foreign validator through the shim");
        require(target.lastObservedSender() == address(0), "foreign caller mutated target state via shim");
    }

    function testShimConstructorRejectsWrongModuleTypeAndZeroAccount() public {
        MockERC7579Hook hook = new MockERC7579Hook();
        (bool wrongType,) = address(this)
            .call(abi.encodeWithSelector(this.deployValidatorShim.selector, address(account), address(hook)));
        require(!wrongType, "validator shim accepted a hook target");

        MockERC7579Validator validator = new MockERC7579Validator();
        (bool zeroAccount,) = address(this)
            .call(abi.encodeWithSelector(this.deployValidatorShim.selector, address(0), address(validator)));
        require(!zeroAccount, "validator shim accepted a zero account");
    }

    function deployValidatorShim(address account_, address target_) external returns (address) {
        return address(new ERC7579ValidatorShim(account_, IERC7579Validator(target_)));
    }

    function _validateThroughAccount(ERC7579ValidatorShim shim, bytes32 userOpHash, bytes memory ownerSig)
        internal
        returns (uint256)
    {
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: address(account),
            nonce: 0,
            initCode: "",
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), bytes(""))),
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: "",
            signature: abi.encode(address(shim), ownerSig)
        });
        return account.validateUserOp(userOp, userOpHash, 0);
    }

    function _installModule(uint256 moduleTypeId, address module, bytes memory lifecycle) internal {
        bytes memory install = abi.encodeCall(LoomAccount.installModule, (moduleTypeId, module, lifecycle));
        _scheduleAndExecute(install);
    }

    function _uninstallModule(uint256 moduleTypeId, address module, bytes memory lifecycle) internal {
        bytes memory uninstall = abi.encodeCall(LoomAccount.uninstallModule, (moduleTypeId, module, lifecycle));
        _scheduleAndExecute(uninstall);
    }

    function _scheduleAndExecute(bytes memory data) internal {
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, data, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, data);
    }

    function _sign(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
