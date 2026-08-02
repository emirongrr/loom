// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {GranularSessionValidator} from "../../src/validators/GranularSessionValidator.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {MockPolicyHook} from "../mocks/MockPolicyHook.sol";

interface Vm {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/// @notice A granular session permission bounds target, selector, and amount,
/// but deliberately leaves the remaining calldata arguments free. That is the
/// intended capability range for a third-party target the granter chose. It is
/// not acceptable for the account itself or for an installed module, where the
/// arguments of a single permitted selector *are* the authority: `scheduleCall`
/// takes the call to queue, `scheduleMigration` takes the destination,
/// `cancelRecovery` takes the recovery to discard. Reaching those through a
/// session key would give a bounded spending credential unbounded account
/// authority.
contract SessionAdministrativeTargetsTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SESSION_KEY = 0xB0B;

    GranularSessionValidator internal validator;
    LoomAccount internal account;
    address internal signer;

    function setUp() public {
        validator = new GranularSessionValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        signer = vm.addr(SESSION_KEY);
    }

    /// @dev The account's own `onlySelf` surface is reached by an ordinary
    /// `execute` item whose target is the account, because the inner call
    /// arrives with `msg.sender == address(this)`. A session key must not be
    /// able to construct one, so the grant is refused at the door rather than
    /// filtered per call.
    function testSessionPermissionCannotTargetTheAccountItself() public {
        bytes32 permissionId = keccak256("self-target");
        GranularSessionValidator.Permission memory permission =
            _permission(address(account), LoomAccount.scheduleMigration.selector);

        bytes memory grant = abi.encodeCall(GranularSessionValidator.grantPermission, (permissionId, permission));
        _schedule(address(validator), grant);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool accepted,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, grant)));

        require(!accepted, "session permission targeting the account was granted");
        require(validator.permissionCount(address(account)) == 0, "rejected grant mutated enumeration");
    }

    /// @dev The module check runs against the current module set rather than
    /// the set observed at grant time, so an address that becomes a module
    /// after the grant is denied from that point on without needing the
    /// permission to be revoked.
    function testSessionPermissionStopsWorkingOnceItsTargetBecomesAModule() public {
        MockPolicyHook hook = new MockPolicyHook();
        bytes32 permissionId = keccak256("module-target");

        bytes memory grant = abi.encodeCall(
            GranularSessionValidator.grantPermission,
            (permissionId, _permission(address(hook), MockPolicyHook.isLowRisk.selector))
        );
        _schedule(address(validator), grant);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(validator), 0, grant);

        bytes memory accountCall = _single(
            ExecutionLib.Execution(address(hook), 0, abi.encodeCall(MockPolicyHook.isLowRisk, (address(account), "")))
        );
        require(
            _validate(permissionId, accountCall) != ValidationDataLib.SIG_VALIDATION_FAILED,
            "ordinary target rejected before installation"
        );

        bytes memory install = abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(hook), ""));
        _schedule(address(account), install);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, install);
        require(account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook not installed");

        require(
            _validate(permissionId, accountCall) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "session still reaches its target after it became an installed module"
        );
        require(!validator.revoked(address(account), permissionId), "test relied on revocation rather than the gate");
    }

    function _permission(address target, bytes4 selector)
        internal
        view
        returns (GranularSessionValidator.Permission memory)
    {
        return GranularSessionValidator.Permission({
            signer: signer,
            target: target,
            token: address(0),
            counterparty: address(0),
            allowedPaymaster: address(0),
            selector: selector,
            maxAmountPerCall: 1 ether,
            maxAmountPerUserOp: 1 ether,
            validAfter: 1,
            validUntil: type(uint48).max,
            maxUses: 5,
            maxCallsPerUserOp: 1
        });
    }

    function _schedule(address target, bytes memory callData) internal {
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (target, 0, callData, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
    }

    function _validate(bytes32 permissionId, bytes memory accountCall) internal returns (uint256) {
        bytes32 userOpHash = keccak256(abi.encode(permissionId, accountCall));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, userOpHash);
        bytes memory signature = abi.encode(permissionId, abi.encodePacked(r, s, v));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 nonce = uint256(uint192(bytes24(permissionId))) << 64;
        return validator.validateUserOp(address(account), userOpHash, nonce, signature, accountCall, address(0));
    }

    function _single(ExecutionLib.Execution memory execution) internal pure returns (bytes memory) {
        return abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution)));
    }
}
