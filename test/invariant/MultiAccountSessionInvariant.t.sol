// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {ExactCallSessionValidator} from "../../src/validators/ExactCallSessionValidator.sol";
import {StdInvariant} from "../../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

interface VmMultiAccountSessionInvariant {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
}

contract MultiAccountSessionCounter {
    uint256 public value;

    function increment() external {
        ++value;
    }
}

contract MultiAccountSessionHandler {
    VmMultiAccountSessionInvariant internal constant vm =
        VmMultiAccountSessionInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ALICE_OWNER_KEY = 0xA11CE;
    uint256 internal constant BOB_OWNER_KEY = 0xB0B;
    uint256 internal constant ALICE_SESSION_KEY = 0xA11CE55;
    uint256 internal constant BOB_SESSION_KEY = 0xB0B55;
    uint256 internal constant INITIAL_DEPOSIT = 100 ether;
    address internal constant BUNDLER = address(0xB0B0);
    bytes32 public constant PERMISSION_ID = keccak256("shared-multi-account-session-permission");

    EntryPoint public immutable entryPoint;
    ECDSAValidator public immutable ownerValidator;
    ExactCallSessionValidator public immutable sessionValidator;
    PolicyHook public immutable policyHook;
    LoomAccount public immutable alice;
    LoomAccount public immutable bob;
    MultiAccountSessionCounter public immutable aliceCounter;
    MultiAccountSessionCounter public immutable bobCounter;
    address public immutable aliceOwner;
    address public immutable bobOwner;
    address public immutable aliceSessionSigner;
    address public immutable bobSessionSigner;

    bool public violated;
    uint256 public successfulSessionOperations;
    uint256 public successfulRevocations;
    uint256 public successfulRegrants;
    uint256 public rejectedSessionOperations;

    struct AccountSnapshot {
        uint256 counterValue;
        uint256 deposit;
        uint256 sessionNonce;
        uint256 directNonce;
        bool revoked;
        ExactCallSessionValidator.Permission permission;
        address owner;
        bytes32 configHash;
        bytes32 guardianRoot;
        uint64 configVersion;
        uint8 guardianThreshold;
        uint256 validatorCount;
    }

    struct SystemSnapshot {
        AccountSnapshot aliceState;
        AccountSnapshot bobState;
        uint256 entryPointBalance;
        uint256 beneficiaryBalance;
    }

    constructor() {
        entryPoint = new EntryPoint();
        ownerValidator = new ECDSAValidator();
        sessionValidator = new ExactCallSessionValidator();
        policyHook = new PolicyHook();
        aliceCounter = new MultiAccountSessionCounter();
        bobCounter = new MultiAccountSessionCounter();
        aliceOwner = vm.addr(ALICE_OWNER_KEY);
        bobOwner = vm.addr(BOB_OWNER_KEY);
        aliceSessionSigner = vm.addr(ALICE_SESSION_KEY);
        bobSessionSigner = vm.addr(BOB_SESSION_KEY);

        alice = new LoomAccount(
            address(entryPoint),
            keccak256("multi-account-session-alice-guardians"),
            1,
            keccak256("multi-account-session-alice-config"),
            _modules(aliceOwner)
        );
        bob = new LoomAccount(
            address(entryPoint),
            keccak256("multi-account-session-bob-guardians"),
            1,
            keccak256("multi-account-session-bob-config"),
            _modules(bobOwner)
        );

        vm.deal(address(this), 2 * INITIAL_DEPOSIT);
        entryPoint.depositTo{value: INITIAL_DEPOSIT}(address(alice));
        entryPoint.depositTo{value: INITIAL_DEPOSIT}(address(bob));
        _regrant(alice, bob, aliceCounter, ALICE_OWNER_KEY, ALICE_SESSION_KEY);
        _regrant(bob, alice, bobCounter, BOB_OWNER_KEY, BOB_SESSION_KEY);
        violated = false;
    }

    function useAliceSession() external {
        _useSession(alice, bob, aliceCounter, bobCounter, ALICE_SESSION_KEY);
    }

    function useBobSession() external {
        _useSession(bob, alice, bobCounter, aliceCounter, BOB_SESSION_KEY);
    }

    function useMixedSessions() external {
        if (_revoked(alice) || _revoked(bob)) return;
        AccountSnapshot memory aliceBefore = _snapshot(alice, aliceCounter);
        AccountSnapshot memory bobBefore = _snapshot(bob, bobCounter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _sessionOperation(alice, aliceCounter, ALICE_SESSION_KEY);
        ops[1] = _sessionOperation(bob, bobCounter, BOB_SESSION_KEY);
        (bool ok,) = _handleOps(ops);

        AccountSnapshot memory aliceAfter = _snapshot(alice, aliceCounter);
        AccountSnapshot memory bobAfter = _snapshot(bob, bobCounter);
        if (!ok || aliceAfter.counterValue != aliceBefore.counterValue + 1) violated = true;
        if (!ok || bobAfter.counterValue != bobBefore.counterValue + 1) violated = true;
        if (aliceAfter.sessionNonce != aliceBefore.sessionNonce + 1) violated = true;
        if (bobAfter.sessionNonce != bobBefore.sessionNonce + 1) violated = true;
        if (!_sameSessionAuthority(aliceBefore, aliceAfter) || !_sameSessionAuthority(bobBefore, bobAfter)) {
            violated = true;
        }
        if (ok) successfulSessionOperations += 2;
    }

    function revokeAliceSession() external {
        _revoke(alice, bob, aliceCounter, bobCounter, ALICE_OWNER_KEY);
    }

    function revokeBobSession() external {
        _revoke(bob, alice, bobCounter, aliceCounter, BOB_OWNER_KEY);
    }

    function regrantAliceSession() external {
        if (!_revoked(alice)) return;
        _regrant(alice, bob, aliceCounter, ALICE_OWNER_KEY, ALICE_SESSION_KEY);
    }

    function regrantBobSession() external {
        if (!_revoked(bob)) return;
        _regrant(bob, alice, bobCounter, BOB_OWNER_KEY, BOB_SESSION_KEY);
    }

    function rejectAliceSignerForBob() external {
        if (_revoked(alice) || _revoked(bob)) return;
        SystemSnapshot memory beforeState = _systemSnapshot();
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _sessionOperation(alice, aliceCounter, ALICE_SESSION_KEY);
        ops[1] = _sessionOperation(bob, bobCounter, ALICE_SESSION_KEY);
        _expectSignatureFailure(ops, 1, beforeState);
    }

    function rejectAliceCallForBob() external {
        if (_revoked(alice) || _revoked(bob)) return;
        SystemSnapshot memory beforeState = _systemSnapshot();
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _sessionOperation(alice, aliceCounter, ALICE_SESSION_KEY);
        ops[1] = _sessionOperation(bob, aliceCounter, BOB_SESSION_KEY);
        _expectSignatureFailure(ops, 1, beforeState);
    }

    function rejectRevokedAliceSession() external {
        if (!_revoked(alice)) return;
        SystemSnapshot memory beforeState = _systemSnapshot();
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sessionOperation(alice, aliceCounter, ALICE_SESSION_KEY);
        _expectSignatureFailure(ops, 0, beforeState);
    }

    function rejectRevokedBobSession() external {
        if (!_revoked(bob)) return;
        SystemSnapshot memory beforeState = _systemSnapshot();
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sessionOperation(bob, bobCounter, BOB_SESSION_KEY);
        _expectSignatureFailure(ops, 0, beforeState);
    }

    function _useSession(
        LoomAccount account,
        LoomAccount other,
        MultiAccountSessionCounter counter,
        MultiAccountSessionCounter otherCounter,
        uint256 sessionKey
    ) internal {
        if (_revoked(account)) return;
        AccountSnapshot memory accountBefore = _snapshot(account, counter);
        AccountSnapshot memory otherBefore = _snapshot(other, otherCounter);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sessionOperation(account, counter, sessionKey);
        (bool ok,) = _handleOps(ops);

        AccountSnapshot memory accountAfter = _snapshot(account, counter);
        if (!ok || accountAfter.counterValue != accountBefore.counterValue + 1) violated = true;
        if (accountAfter.sessionNonce != accountBefore.sessionNonce + 1) violated = true;
        if (!_sameSessionAuthority(accountBefore, accountAfter)) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other, otherCounter))) violated = true;
        if (ok) ++successfulSessionOperations;
    }

    function _revoke(
        LoomAccount account,
        LoomAccount other,
        MultiAccountSessionCounter counter,
        MultiAccountSessionCounter otherCounter,
        uint256 ownerKey
    ) internal {
        if (_revoked(account)) return;
        AccountSnapshot memory accountBefore = _snapshot(account, counter);
        AccountSnapshot memory otherBefore = _snapshot(other, otherCounter);
        bytes memory revokeData = abi.encodeCall(ExactCallSessionValidator.revokePermission, (PERMISSION_ID));
        _directExecute(account, ownerKey, ExecutionLib.Execution(address(sessionValidator), 0, revokeData));

        AccountSnapshot memory accountAfter = _snapshot(account, counter);
        if (!accountAfter.revoked || accountAfter.directNonce != accountBefore.directNonce + 1) violated = true;
        if (
            accountAfter.configHash != accountBefore.configHash
                || accountAfter.configVersion != accountBefore.configVersion
        ) {
            violated = true;
        }
        if (accountAfter.counterValue != accountBefore.counterValue || accountAfter.deposit != accountBefore.deposit) {
            violated = true;
        }
        if (accountAfter.sessionNonce != accountBefore.sessionNonce) violated = true;
        if (!_samePermission(accountAfter.permission, accountBefore.permission)) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other, otherCounter))) violated = true;
        ++successfulRevocations;
    }

    function _regrant(
        LoomAccount account,
        LoomAccount other,
        MultiAccountSessionCounter counter,
        uint256 ownerKey,
        uint256 sessionKey
    ) internal {
        MultiAccountSessionCounter otherCounter = address(account) == address(alice) ? bobCounter : aliceCounter;
        AccountSnapshot memory accountBefore = _snapshot(account, counter);
        AccountSnapshot memory otherBefore = _snapshot(other, otherCounter);
        ExactCallSessionValidator.Permission memory permission = _expectedPermission(counter, sessionKey);
        bytes memory grantData = abi.encodeCall(ExactCallSessionValidator.grantPermission, (PERMISSION_ID, permission));
        bytes memory scheduleData = abi.encodeCall(
            LoomAccount.scheduleCall, (address(sessionValidator), 0, grantData, account.MIN_CONFIG_DELAY())
        );
        _directExecute(account, ownerKey, ExecutionLib.Execution(address(account), 0, scheduleData));

        bytes32 operationId =
            keccak256(abi.encode(address(sessionValidator), uint256(0), grantData, account.configVersion()));
        uint48 readyAt = account.scheduledOperations(operationId);
        if (readyAt == 0) {
            violated = true;
            return;
        }
        vm.warp(readyAt);
        account.executeScheduled(address(sessionValidator), 0, grantData);

        AccountSnapshot memory accountAfter = _snapshot(account, counter);
        bytes32 permissionChange = keccak256(abi.encode("SESSION_PERMISSION", PERMISSION_ID, permission));
        if (accountAfter.revoked || !_samePermission(accountAfter.permission, permission)) violated = true;
        if (accountAfter.directNonce != accountBefore.directNonce + 1) violated = true;
        if (accountAfter.configVersion != accountBefore.configVersion + 1) violated = true;
        if (accountAfter.configHash != keccak256(abi.encode(accountBefore.configHash, permissionChange))) {
            violated = true;
        }
        if (accountAfter.counterValue != accountBefore.counterValue || accountAfter.deposit != accountBefore.deposit) {
            violated = true;
        }
        if (accountAfter.sessionNonce != accountBefore.sessionNonce) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other, otherCounter))) violated = true;
        ++successfulRegrants;
    }

    function _directExecute(LoomAccount account, uint256 ownerKey, ExecutionLib.Execution memory execution) internal {
        bytes memory executionCalldata = abi.encode(execution);
        uint48 validUntil = type(uint48).max;
        uint256 nonce = account.directExecutionNonces(address(ownerValidator));
        bytes32 digest = account.directExecutionDigest(
            address(ownerValidator), ExecutionLib.SINGLE_EXECUTION_MODE, executionCalldata, nonce, validUntil
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        account.executeDirect(
            address(ownerValidator),
            ExecutionLib.SINGLE_EXECUTION_MODE,
            executionCalldata,
            validUntil,
            abi.encodePacked(r, s, v)
        );
    }

    function _sessionOperation(LoomAccount account, MultiAccountSessionCounter operationCounter, uint256 signingKey)
        internal
        returns (PackedUserOperation memory op)
    {
        bytes memory accountCall = _sessionAccountCall(operationCounter);
        uint192 nonceKey = sessionValidator.nonceKeyFor(PERMISSION_ID);
        op = PackedUserOperation({
            sender: address(account),
            nonce: entryPoint.getNonce(address(account), nonceKey),
            initCode: "",
            callData: accountCall,
            accountGasLimits: bytes32((uint256(3_000_000) << 128) | uint256(1_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1) << 128) | uint256(1)),
            paymasterAndData: "",
            signature: ""
        });
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingKey, userOpHash);
        bytes memory validatorSignature = abi.encode(PERMISSION_ID, abi.encodePacked(r, s, v), keccak256(accountCall));
        op.signature = abi.encode(address(sessionValidator), validatorSignature);
    }

    function _expectSignatureFailure(
        PackedUserOperation[] memory ops,
        uint256 failedIndex,
        SystemSnapshot memory beforeState
    ) internal {
        (bool ok, bytes memory revertData) = _handleOps(ops);
        bytes memory expected =
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, failedIndex, "AA24 signature error");
        if (ok || keccak256(revertData) != keccak256(expected)) violated = true;
        if (!_sameSystemState(beforeState, _systemSnapshot())) violated = true;
        if (!ok) ++rejectedSessionOperations;
    }

    function _handleOps(PackedUserOperation[] memory ops) internal returns (bool ok, bytes memory result) {
        vm.startPrank(BUNDLER, BUNDLER);
        (ok, result) = address(entryPoint).call(abi.encodeCall(IEntryPoint.handleOps, (ops, payable(address(this)))));
        vm.stopPrank();
    }

    function _modules(address owner) internal view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(policyHook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(ownerValidator),
            abi.encodeCall(ECDSAValidator.initialize, (owner, address(policyHook)))
        );
        modules[2] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(sessionValidator), "");
    }

    function _expectedPermission(MultiAccountSessionCounter counter, uint256 sessionKey)
        internal
        returns (ExactCallSessionValidator.Permission memory)
    {
        return ExactCallSessionValidator.Permission({
            signer: vm.addr(sessionKey),
            validAfter: 0,
            validUntil: type(uint48).max,
            callHash: keccak256(_sessionAccountCall(counter)),
            maxUses: type(uint32).max,
            allowedPaymaster: address(0)
        });
    }

    function _sessionAccountCall(MultiAccountSessionCounter counter) internal pure returns (bytes memory) {
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(counter), 0, abi.encodeCall(MultiAccountSessionCounter.increment, ()));
        return abi.encodeCall(LoomAccount.execute, (ExecutionLib.SINGLE_EXECUTION_MODE, abi.encode(execution)));
    }

    function _snapshot(LoomAccount account, MultiAccountSessionCounter counter)
        internal
        view
        returns (AccountSnapshot memory state)
    {
        state = AccountSnapshot({
            counterValue: counter.value(),
            deposit: entryPoint.balanceOf(address(account)),
            sessionNonce: entryPoint.getNonce(address(account), sessionValidator.nonceKeyFor(PERMISSION_ID)),
            directNonce: account.directExecutionNonces(address(ownerValidator)),
            revoked: _revoked(account),
            permission: _permission(account),
            owner: ownerValidator.owners(address(account)),
            configHash: account.configHash(),
            guardianRoot: account.guardianRoot(),
            configVersion: account.configVersion(),
            guardianThreshold: account.guardianThreshold(),
            validatorCount: account.validatorCount()
        });
    }

    function _systemSnapshot() internal view returns (SystemSnapshot memory state) {
        state = SystemSnapshot({
            aliceState: _snapshot(alice, aliceCounter),
            bobState: _snapshot(bob, bobCounter),
            entryPointBalance: address(entryPoint).balance,
            beneficiaryBalance: address(this).balance
        });
    }

    function _permission(LoomAccount account)
        internal
        view
        returns (ExactCallSessionValidator.Permission memory permission)
    {
        (
            permission.signer,
            permission.validAfter,
            permission.validUntil,
            permission.callHash,
            permission.maxUses,
            permission.allowedPaymaster
        ) = sessionValidator.permissions(address(account), PERMISSION_ID);
    }

    function _revoked(LoomAccount account) internal view returns (bool) {
        return sessionValidator.revoked(address(account), PERMISSION_ID);
    }

    function _sameSessionAuthority(AccountSnapshot memory left, AccountSnapshot memory right)
        internal
        pure
        returns (bool)
    {
        return left.directNonce == right.directNonce && left.revoked == right.revoked
            && _samePermission(left.permission, right.permission) && left.owner == right.owner
            && left.configHash == right.configHash && left.guardianRoot == right.guardianRoot
            && left.configVersion == right.configVersion && left.guardianThreshold == right.guardianThreshold
            && left.validatorCount == right.validatorCount;
    }

    function _samePermission(
        ExactCallSessionValidator.Permission memory left,
        ExactCallSessionValidator.Permission memory right
    ) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    function _sameAccountState(AccountSnapshot memory left, AccountSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    function _sameSystemState(SystemSnapshot memory left, SystemSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    receive() external payable {}
}

contract MultiAccountSessionInvariantTest is StdInvariant {
    MultiAccountSessionHandler internal handler;

    function setUp() public {
        handler = new MultiAccountSessionHandler();

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = MultiAccountSessionHandler.useAliceSession.selector;
        selectors[1] = MultiAccountSessionHandler.useBobSession.selector;
        selectors[2] = MultiAccountSessionHandler.useMixedSessions.selector;
        selectors[3] = MultiAccountSessionHandler.revokeAliceSession.selector;
        selectors[4] = MultiAccountSessionHandler.revokeBobSession.selector;
        selectors[5] = MultiAccountSessionHandler.regrantAliceSession.selector;
        selectors[6] = MultiAccountSessionHandler.regrantBobSession.selector;
        selectors[7] = MultiAccountSessionHandler.rejectAliceSignerForBob.selector;
        selectors[8] = MultiAccountSessionHandler.rejectAliceCallForBob.selector;
        selectors[9] = MultiAccountSessionHandler.rejectRevokedAliceSession.selector;
        selectors[10] = MultiAccountSessionHandler.rejectRevokedBobSession.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantSessionAuthorityRemainsAccountScoped() public view {
        require(!handler.violated(), "multi-account session handler observed an invariant violation");
        require(address(handler.alice()) != address(handler.bob()), "session account identities collided");
        require(
            handler.ownerValidator().owners(address(handler.alice())) == handler.aliceOwner(), "Alice owner changed"
        );
        require(handler.ownerValidator().owners(address(handler.bob())) == handler.bobOwner(), "Bob owner changed");
        require(handler.alice().validatorCount() == 2 && handler.bob().validatorCount() == 2, "validator set changed");

        ExactCallSessionValidator.Permission memory alicePermission = _permission(handler.alice());
        ExactCallSessionValidator.Permission memory bobPermission = _permission(handler.bob());
        require(alicePermission.signer == handler.aliceSessionSigner(), "Alice session signer crossed accounts");
        require(bobPermission.signer == handler.bobSessionSigner(), "Bob session signer crossed accounts");
        require(alicePermission.callHash != bobPermission.callHash, "session calls lost account-specific targets");
    }

    function invariantSessionNonceKeyRemainsAccountScoped() public view {
        uint192 key = handler.sessionValidator().nonceKeyFor(handler.PERMISSION_ID());
        uint256 aliceNonce = handler.entryPoint().getNonce(address(handler.alice()), key);
        uint256 bobNonce = handler.entryPoint().getNonce(address(handler.bob()), key);
        require(aliceNonce >> 64 == uint256(key), "Alice session nonce escaped its key");
        require(bobNonce >> 64 == uint256(key), "Bob session nonce escaped its key");
    }

    function invariantSessionDepositsRemainFullyBacked() public view {
        uint256 accounted = handler.entryPoint().balanceOf(address(handler.alice()))
            + handler.entryPoint().balanceOf(address(handler.bob()));
        require(address(handler.entryPoint()).balance == accounted, "session deposits are not fully backed");
        require(
            address(handler.entryPoint()).balance + address(handler).balance == 2 * 100 ether,
            "session gas settlement broke conservation"
        );
    }

    function _permission(LoomAccount account)
        internal
        view
        returns (ExactCallSessionValidator.Permission memory permission)
    {
        (
            permission.signer,
            permission.validAfter,
            permission.validUntil,
            permission.callHash,
            permission.maxUses,
            permission.allowedPaymaster
        ) = handler.sessionValidator().permissions(address(account), handler.PERMISSION_ID());
    }
}
