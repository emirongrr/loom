// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {GranularSessionValidator} from "../src/validators/GranularSessionValidator.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../src/libraries/ValidationDataLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockTarget} from "./mocks/MockTarget.sol";

interface Vm {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract GranularSessionValidatorTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SESSION_KEY = 0xB0B;

    GranularSessionValidator internal validator;
    LoomAccount internal account;
    MockERC20 internal token;
    address internal signer;
    address internal recipient = address(0xBEEF);

    function setUp() public {
        validator = new GranularSessionValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        token = new MockERC20();
        signer = vm.addr(SESSION_KEY);
    }

    function testGranularTokenPermissionBindsEveryDimension() public {
        bytes32 permissionId = keccak256("token-permission");
        _grant(permissionId, _tokenPermission(address(0), 60, 100, 2, 3));

        bytes memory allowed = _singleTokenCall(recipient, 60);
        require(_validate(permissionId, allowed, address(0), 0) != ValidationDataLib.SIG_VALIDATION_FAILED);

        require(
            _validate(permissionId, _singleTokenCall(address(0xCAFE), 1), address(0), 0)
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "counterparty bypassed"
        );
        require(
            _validate(permissionId, _singleTokenCall(recipient, 61), address(0), 0)
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "per-call amount bypassed"
        );

        MockERC20 otherToken = new MockERC20();
        ExecutionLib.Execution memory wrongToken =
            ExecutionLib.Execution(address(otherToken), 0, abi.encodeCall(MockERC20.transfer, (recipient, 1)));
        require(
            _validate(permissionId, _single(wrongToken), address(0), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "token or target bypassed"
        );

        ExecutionLib.Execution memory wrongSelector =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.approve, (recipient, 1)));
        require(
            _validate(permissionId, _single(wrongSelector), address(0), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "selector bypassed"
        );
        require(
            _validate(permissionId, allowed, address(0xCAFE), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "paymaster bypassed"
        );
        require(
            _validate(permissionId, allowed, address(0), 3) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "use limit bypassed"
        );
    }

    function testGranularBatchEnforcesCallAndAggregateLimits() public {
        bytes32 permissionId = keccak256("batch-permission");
        _grant(permissionId, _tokenPermission(address(0xA11CE), 60, 100, 2, 10));

        ExecutionLib.Execution[] memory allowed = new ExecutionLib.Execution[](2);
        allowed[0] = _tokenExecution(recipient, 60);
        allowed[1] = _tokenExecution(recipient, 40);
        require(
            _validate(permissionId, _batch(allowed), address(0xA11CE), 0) != ValidationDataLib.SIG_VALIDATION_FAILED,
            "bounded batch rejected"
        );

        allowed[1] = _tokenExecution(recipient, 41);
        require(
            _validate(permissionId, _batch(allowed), address(0xA11CE), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "aggregate amount bypassed"
        );

        ExecutionLib.Execution[] memory tooMany = new ExecutionLib.Execution[](3);
        tooMany[0] = _tokenExecution(recipient, 1);
        tooMany[1] = _tokenExecution(recipient, 1);
        tooMany[2] = _tokenExecution(recipient, 1);
        require(
            _validate(permissionId, _batch(tooMany), address(0xA11CE), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "batch call count bypassed"
        );

        ExecutionLib.Execution[] memory mixedTarget = new ExecutionLib.Execution[](2);
        mixedTarget[0] = _tokenExecution(recipient, 1);
        mixedTarget[1] =
            ExecutionLib.Execution(address(new MockERC20()), 0, abi.encodeCall(MockERC20.transfer, (recipient, 1)));
        require(
            _validate(permissionId, _batch(mixedTarget), address(0xA11CE), 0)
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "mixed target batch accepted"
        );
    }

    function testNativePermissionAndImmediateRevoke() public {
        MockTarget target = new MockTarget();
        bytes32 permissionId = keccak256("native-permission");
        GranularSessionValidator.Permission memory permission = GranularSessionValidator.Permission({
            signer: signer,
            target: address(target),
            token: address(0),
            counterparty: address(0),
            allowedPaymaster: address(0),
            selector: MockTarget.setValue.selector,
            maxAmountPerCall: 1 ether,
            maxAmountPerUserOp: 1 ether,
            validAfter: 1,
            validUntil: type(uint48).max,
            maxUses: 5,
            maxCallsPerUserOp: 1
        });
        _grant(permissionId, permission);

        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 1 ether, abi.encodeCall(MockTarget.setValue, (7)));
        bytes memory accountCall = _single(execution);
        require(_validate(permissionId, accountCall, address(0), 0) != ValidationDataLib.SIG_VALIDATION_FAILED);

        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(
                    address(validator), 0, abi.encodeCall(GranularSessionValidator.revokePermission, (permissionId))
                )
            )
        );
        require(_validate(permissionId, accountCall, address(0), 0) == ValidationDataLib.SIG_VALIDATION_FAILED);
        require(validator.permissionCount(address(account)) == 1, "permission not enumerable");
        require(validator.permissionIdAt(address(account), 0) == permissionId, "wrong permission id");
    }

    function testPermissionGrantRequiresTimelockAndRejectsInvalidShape() public {
        bytes32 permissionId = keccak256("permission");
        GranularSessionValidator.Permission memory permission = _tokenPermission(address(0), 60, 100, 2, 3);
        (bool direct,) = address(validator)
            .call(abi.encodeCall(GranularSessionValidator.grantPermission, (permissionId, permission)));
        require(!direct, "direct grant accepted");

        permission.token = address(0xCAFE);
        bytes memory grant = abi.encodeCall(GranularSessionValidator.grantPermission, (permissionId, permission));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(validator), 0, grant, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool invalid,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, grant)));
        require(!invalid, "mismatched token and target accepted");
    }

    function testBatchGrantPermissionsRequiresTimelockAndIsAtomic() public {
        bytes32[] memory permissionIds = new bytes32[](2);
        permissionIds[0] = keccak256("batch-grant-a");
        permissionIds[1] = keccak256("batch-grant-b");

        GranularSessionValidator.Permission[] memory permissions = new GranularSessionValidator.Permission[](2);
        permissions[0] = _tokenPermission(address(0), 60, 100, 2, 3);
        permissions[1] = _tokenPermission(address(0xA11CE), 25, 50, 2, 4);

        bytes memory grant = abi.encodeCall(GranularSessionValidator.grantPermissions, (permissionIds, permissions));
        (bool direct,) = address(validator).call(grant);
        require(!direct, "direct batch grant accepted");

        uint64 versionBefore = account.configVersion();
        _scheduleAndExecute(grant);
        require(account.configVersion() == versionBefore + 1, "batch grant did not advance config once");
        require(validator.permissionCount(address(account)) == 2, "batch permissions not enumerable");
        require(validator.permissionIdAt(address(account), 0) == permissionIds[0], "wrong first permission id");
        require(validator.permissionIdAt(address(account), 1) == permissionIds[1], "wrong second permission id");

        require(
            _validate(permissionIds[0], _singleTokenCall(recipient, 60), address(0), 0)
                != ValidationDataLib.SIG_VALIDATION_FAILED,
            "first permission rejected"
        );
        require(
            _validate(permissionIds[1], _singleTokenCall(recipient, 25), address(0xA11CE), 0)
                != ValidationDataLib.SIG_VALIDATION_FAILED,
            "second permission rejected"
        );

        bytes32[] memory duplicateIds = new bytes32[](2);
        duplicateIds[0] = keccak256("duplicate");
        duplicateIds[1] = duplicateIds[0];
        GranularSessionValidator.Permission[] memory duplicatePermissions = new GranularSessionValidator.Permission[](2);
        duplicatePermissions[0] = permissions[0];
        duplicatePermissions[1] = permissions[1];
        bytes memory duplicateGrant =
            abi.encodeCall(GranularSessionValidator.grantPermissions, (duplicateIds, duplicatePermissions));
        _schedule(duplicateGrant);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool duplicateAccepted,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, duplicateGrant)));
        require(!duplicateAccepted, "duplicate batch permission id accepted");
        require(validator.permissionCount(address(account)) == 2, "duplicate grant mutated permissions");

        bytes32[] memory invalidIds = new bytes32[](2);
        invalidIds[0] = keccak256("invalid-a");
        invalidIds[1] = keccak256("invalid-b");
        GranularSessionValidator.Permission[] memory invalidPermissions = new GranularSessionValidator.Permission[](2);
        invalidPermissions[0] = permissions[0];
        invalidPermissions[1] = permissions[1];
        invalidPermissions[1].token = address(0xCAFE);
        bytes memory invalidGrant =
            abi.encodeCall(GranularSessionValidator.grantPermissions, (invalidIds, invalidPermissions));
        _schedule(invalidGrant);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool invalidAccepted,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, invalidGrant)));
        require(!invalidAccepted, "invalid batch permission accepted");
        require(validator.permissionCount(address(account)) == 2, "invalid grant partially mutated permissions");
        require(
            _validate(invalidIds[0], _singleTokenCall(recipient, 1), address(0), 0)
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "invalid batch granted first permission"
        );
    }

    function testMalformedAndUnsupportedCallsFailClosed() public {
        bytes32 permissionId = keccak256("malformed-permission");
        _grant(permissionId, _tokenPermission(address(0), 60, 100, 2, 3));

        ExecutionLib.Execution memory malformed =
            ExecutionLib.Execution(address(token), 0, abi.encodePacked(MockERC20.transfer.selector));
        require(
            _validate(permissionId, _single(malformed), address(0), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "malformed token call accepted"
        );
        require(
            _validate(permissionId, abi.encodeCall(LoomAccount.unfreeze, ()), address(0), 0)
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "non-execute account call accepted"
        );

        ExecutionLib.Execution[] memory empty = new ExecutionLib.Execution[](0);
        require(
            _validate(permissionId, _batch(empty), address(0), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "empty batch accepted"
        );
    }

    function testFuzzTokenAmountBound(uint128 amount) public {
        bytes32 permissionId = keccak256("fuzz-permission");
        _grant(permissionId, _tokenPermission(address(0), 100, 100, 1, 3));
        uint256 result = _validate(permissionId, _singleTokenCall(recipient, amount), address(0), 0);
        require((result != ValidationDataLib.SIG_VALIDATION_FAILED) == (amount <= 100), "amount boundary mismatch");
    }

    function _tokenPermission(address paymaster, uint128 perCall, uint128 perOp, uint16 calls, uint32 uses)
        internal
        view
        returns (GranularSessionValidator.Permission memory)
    {
        return GranularSessionValidator.Permission({
            signer: signer,
            target: address(token),
            token: address(token),
            counterparty: recipient,
            allowedPaymaster: paymaster,
            selector: MockERC20.transfer.selector,
            maxAmountPerCall: perCall,
            maxAmountPerUserOp: perOp,
            validAfter: 1,
            validUntil: type(uint48).max,
            maxUses: uses,
            maxCallsPerUserOp: calls
        });
    }

    function _grant(bytes32 permissionId, GranularSessionValidator.Permission memory permission) internal {
        bytes memory grant = abi.encodeCall(GranularSessionValidator.grantPermission, (permissionId, permission));
        _scheduleAndExecute(grant);
    }

    function _scheduleAndExecute(bytes memory grant) internal {
        _schedule(grant);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(validator), 0, grant);
    }

    function _schedule(bytes memory grant) internal {
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(validator), 0, grant, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
    }

    function _validate(bytes32 permissionId, bytes memory accountCall, address paymaster, uint64 sequence)
        internal
        returns (uint256)
    {
        bytes32 userOpHash = keccak256(abi.encode(permissionId, accountCall, paymaster, sequence));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, userOpHash);
        bytes memory signature = abi.encode(permissionId, abi.encodePacked(r, s, v));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 nonce = uint256(uint192(bytes24(permissionId))) << 64 | sequence;
        return validator.validateUserOp(address(account), userOpHash, nonce, signature, accountCall, paymaster);
    }

    function _singleTokenCall(address to, uint256 amount) internal view returns (bytes memory) {
        return _single(_tokenExecution(to, amount));
    }

    function _tokenExecution(address to, uint256 amount) internal view returns (ExecutionLib.Execution memory) {
        return ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (to, amount)));
    }

    function _single(ExecutionLib.Execution memory execution) internal pure returns (bytes memory) {
        return abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution)));
    }

    function _batch(ExecutionLib.Execution[] memory executions) internal pure returns (bytes memory) {
        return abi.encodeCall(LoomAccount.execute, (bytes32(uint256(1) << 248), abi.encode(executions)));
    }
}
