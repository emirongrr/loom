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
import {MockTarget} from "../mocks/MockTarget.sol";
import {StdInvariant} from "../../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

interface VmMultiAccountInvariant {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
}

contract EntryPointMultiAccountHandler {
    VmMultiAccountInvariant internal constant vm =
        VmMultiAccountInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ALICE_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;
    uint256 internal constant WRONG_KEY = 0xBAD;
    address internal constant BUNDLER = address(0xB0B0);
    uint192 internal constant NONCE_KEY_COUNT = 3;
    uint256 internal constant INITIAL_DEPOSIT = 10 ether;

    EntryPoint public immutable entryPoint;
    ECDSAValidator public immutable validator;
    PolicyHook public immutable hook;
    LoomAccount public immutable alice;
    LoomAccount public immutable bob;
    MockTarget public immutable aliceTarget;
    MockTarget public immutable bobTarget;
    address public immutable aliceOwner;
    address public immutable bobOwner;

    bytes32 public immutable aliceConfigHash;
    bytes32 public immutable bobConfigHash;
    bytes32 public immutable aliceGuardianRoot;
    bytes32 public immutable bobGuardianRoot;

    bool public violated;
    uint256 public successfulOperations;
    uint256 public revertedExecutions;
    uint256 public rejectedBundles;

    struct AccountSnapshot {
        uint256 targetValue;
        uint256 deposit;
        uint256 nonce0;
        uint256 nonce1;
        uint256 nonce2;
        uint256 nativeBalance;
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
        validator = new ECDSAValidator();
        hook = new PolicyHook();
        aliceTarget = new MockTarget();
        bobTarget = new MockTarget();

        aliceConfigHash = keccak256("multi-account-alice-config");
        bobConfigHash = keccak256("multi-account-bob-config");
        aliceGuardianRoot = keccak256("multi-account-alice-guardians");
        bobGuardianRoot = keccak256("multi-account-bob-guardians");
        aliceOwner = vm.addr(ALICE_KEY);
        bobOwner = vm.addr(BOB_KEY);

        alice = new LoomAccount(address(entryPoint), aliceGuardianRoot, 1, aliceConfigHash, _modules(aliceOwner));
        bob = new LoomAccount(address(entryPoint), bobGuardianRoot, 1, bobConfigHash, _modules(bobOwner));

        vm.deal(address(this), 2 * INITIAL_DEPOSIT);
        entryPoint.depositTo{value: INITIAL_DEPOSIT}(address(alice));
        entryPoint.depositTo{value: INITIAL_DEPOSIT}(address(bob));
    }

    function executeAlice(uint256 value, uint8 keySeed) external {
        AccountSnapshot memory bobBefore = _snapshot(bob, bobTarget);
        uint192 nonceKey = _nonceKey(keySeed);
        uint256 nonceBefore = entryPoint.getNonce(address(alice), nonceKey);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _signedOperation(alice, aliceTarget, value, nonceKey, ALICE_KEY, false);
        (bool ok,) = _handleOps(ops);

        if (!ok || aliceTarget.value() != value) violated = true;
        if (entryPoint.getNonce(address(alice), nonceKey) != nonceBefore + 1) violated = true;
        if (!_sameAccountState(bobBefore, _snapshot(bob, bobTarget))) violated = true;
        if (ok) ++successfulOperations;
    }

    function executeBob(uint256 value, uint8 keySeed) external {
        AccountSnapshot memory aliceBefore = _snapshot(alice, aliceTarget);
        uint192 nonceKey = _nonceKey(keySeed);
        uint256 nonceBefore = entryPoint.getNonce(address(bob), nonceKey);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _signedOperation(bob, bobTarget, value, nonceKey, BOB_KEY, false);
        (bool ok,) = _handleOps(ops);

        if (!ok || bobTarget.value() != value) violated = true;
        if (entryPoint.getNonce(address(bob), nonceKey) != nonceBefore + 1) violated = true;
        if (!_sameAccountState(aliceBefore, _snapshot(alice, aliceTarget))) violated = true;
        if (ok) ++successfulOperations;
    }

    function executeMixedBundle(uint256 aliceValue, uint256 bobValue, uint8 aliceKeySeed, uint8 bobKeySeed) external {
        uint192 aliceNonceKey = _nonceKey(aliceKeySeed);
        uint192 bobNonceKey = _nonceKey(bobKeySeed);
        uint256 aliceNonceBefore = entryPoint.getNonce(address(alice), aliceNonceKey);
        uint256 bobNonceBefore = entryPoint.getNonce(address(bob), bobNonceKey);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedOperation(alice, aliceTarget, aliceValue, aliceNonceKey, ALICE_KEY, false);
        ops[1] = _signedOperation(bob, bobTarget, bobValue, bobNonceKey, BOB_KEY, false);
        (bool ok,) = _handleOps(ops);

        if (!ok || aliceTarget.value() != aliceValue || bobTarget.value() != bobValue) violated = true;
        if (entryPoint.getNonce(address(alice), aliceNonceKey) != aliceNonceBefore + 1) violated = true;
        if (entryPoint.getNonce(address(bob), bobNonceKey) != bobNonceBefore + 1) violated = true;
        if (ok) successfulOperations += 2;
    }

    function executeRevertingAliceThenBob(uint256 bobValue, uint8 aliceKeySeed, uint8 bobKeySeed) external {
        uint192 aliceNonceKey = _nonceKey(aliceKeySeed);
        uint192 bobNonceKey = _nonceKey(bobKeySeed);
        uint256 aliceNonceBefore = entryPoint.getNonce(address(alice), aliceNonceKey);
        uint256 bobNonceBefore = entryPoint.getNonce(address(bob), bobNonceKey);
        uint256 aliceTargetBefore = aliceTarget.value();

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedOperation(alice, aliceTarget, 0, aliceNonceKey, ALICE_KEY, true);
        ops[1] = _signedOperation(bob, bobTarget, bobValue, bobNonceKey, BOB_KEY, false);
        (bool ok,) = _handleOps(ops);

        if (!ok || aliceTarget.value() != aliceTargetBefore || bobTarget.value() != bobValue) violated = true;
        if (entryPoint.getNonce(address(alice), aliceNonceKey) != aliceNonceBefore + 1) violated = true;
        if (entryPoint.getNonce(address(bob), bobNonceKey) != bobNonceBefore + 1) violated = true;
        if (ok) {
            ++revertedExecutions;
            ++successfulOperations;
        }
    }

    function rejectInvalidSignatureBundle(
        uint256 aliceValue,
        uint256 bobValue,
        uint8 aliceKeySeed,
        uint8 bobKeySeed,
        bool invalidFirst
    ) external {
        SystemSnapshot memory beforeState = _systemSnapshot();
        uint192 aliceNonceKey = _nonceKey(aliceKeySeed);
        uint192 bobNonceKey = _nonceKey(bobKeySeed);

        PackedUserOperation memory invalidAlice =
            _signedOperation(alice, aliceTarget, aliceValue, aliceNonceKey, WRONG_KEY, false);
        PackedUserOperation memory invalidBob =
            _signedOperation(bob, bobTarget, bobValue, bobNonceKey, WRONG_KEY, false);
        PackedUserOperation memory validAlice =
            _signedOperation(alice, aliceTarget, aliceValue, aliceNonceKey, ALICE_KEY, false);
        PackedUserOperation memory validBob = _signedOperation(bob, bobTarget, bobValue, bobNonceKey, BOB_KEY, false);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        if (invalidFirst) {
            ops[0] = invalidAlice;
            ops[1] = validBob;
        } else {
            ops[0] = validAlice;
            ops[1] = invalidBob;
        }

        (bool ok, bytes memory revertData) = _handleOps(ops);
        uint256 failedIndex = invalidFirst ? 0 : 1;
        bytes memory expected =
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, failedIndex, "AA24 signature error");
        if (ok || keccak256(revertData) != keccak256(expected)) violated = true;
        if (!_sameSystemState(beforeState, _systemSnapshot())) violated = true;
        if (!ok) ++rejectedBundles;
    }

    function _signedOperation(
        LoomAccount account,
        MockTarget operationTarget,
        uint256 value,
        uint192 nonceKey,
        uint256 signingKey,
        bool shouldRevert
    ) internal returns (PackedUserOperation memory op) {
        bytes memory targetCall = shouldRevert
            ? abi.encodeCall(MockTarget.fail, ())
            : abi.encodeCall(MockTarget.setValue, (value));
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(address(operationTarget), 0, targetCall);

        op = PackedUserOperation({
            sender: address(account),
            nonce: entryPoint.getNonce(address(account), nonceKey),
            initCode: "",
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(3_000_000) << 128) | uint256(1_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1) << 128) | uint256(1)),
            paymasterAndData: "",
            signature: ""
        });
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingKey, userOpHash);
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
    }

    function _handleOps(PackedUserOperation[] memory ops) internal returns (bool ok, bytes memory result) {
        vm.startPrank(BUNDLER, BUNDLER);
        (ok, result) = address(entryPoint).call(abi.encodeCall(IEntryPoint.handleOps, (ops, payable(address(this)))));
        vm.stopPrank();
    }

    function _modules(address owner) internal view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
    }

    function _nonceKey(uint8 seed) internal pure returns (uint192) {
        return uint192(seed) % NONCE_KEY_COUNT;
    }

    function _snapshot(LoomAccount account, MockTarget operationTarget)
        internal
        view
        returns (AccountSnapshot memory state)
    {
        state = AccountSnapshot({
            targetValue: operationTarget.value(),
            deposit: entryPoint.balanceOf(address(account)),
            nonce0: entryPoint.getNonce(address(account), 0),
            nonce1: entryPoint.getNonce(address(account), 1),
            nonce2: entryPoint.getNonce(address(account), 2),
            nativeBalance: address(account).balance,
            owner: validator.owners(address(account)),
            configHash: account.configHash(),
            guardianRoot: account.guardianRoot(),
            configVersion: account.configVersion(),
            guardianThreshold: account.guardianThreshold(),
            validatorCount: account.validatorCount()
        });
    }

    function _systemSnapshot() internal view returns (SystemSnapshot memory state) {
        state = SystemSnapshot({
            aliceState: _snapshot(alice, aliceTarget),
            bobState: _snapshot(bob, bobTarget),
            entryPointBalance: address(entryPoint).balance,
            beneficiaryBalance: address(this).balance
        });
    }

    function _sameAccountState(AccountSnapshot memory left, AccountSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    function _sameSystemState(SystemSnapshot memory left, SystemSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    receive() external payable {}
}

contract EntryPointMultiAccountInvariantTest is StdInvariant {
    EntryPointMultiAccountHandler internal handler;

    function setUp() public {
        handler = new EntryPointMultiAccountHandler();

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = EntryPointMultiAccountHandler.executeAlice.selector;
        selectors[1] = EntryPointMultiAccountHandler.executeBob.selector;
        selectors[2] = EntryPointMultiAccountHandler.executeMixedBundle.selector;
        selectors[3] = EntryPointMultiAccountHandler.executeRevertingAliceThenBob.selector;
        selectors[4] = EntryPointMultiAccountHandler.rejectInvalidSignatureBundle.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantAccountsRetainIndependentAuthority() public view {
        LoomAccount alice = handler.alice();
        LoomAccount bob = handler.bob();
        ECDSAValidator validator = handler.validator();

        require(!handler.violated(), "multi-account handler observed an invariant violation");
        require(address(alice) != address(bob), "account identities collided");
        require(validator.owners(address(alice)) == handler.aliceOwner(), "Alice authority changed");
        require(validator.owners(address(bob)) == handler.bobOwner(), "Bob authority changed");
        require(alice.configHash() == handler.aliceConfigHash(), "Alice config changed");
        require(bob.configHash() == handler.bobConfigHash(), "Bob config changed");
        require(alice.guardianRoot() == handler.aliceGuardianRoot(), "Alice guardians changed");
        require(bob.guardianRoot() == handler.bobGuardianRoot(), "Bob guardians changed");
        require(alice.validatorCount() == 1 && bob.validatorCount() == 1, "validator set changed");
    }

    function invariantNonceKeysRemainAccountScoped() public view {
        EntryPoint entryPoint = handler.entryPoint();
        address alice = address(handler.alice());
        address bob = address(handler.bob());

        for (uint192 key; key < 3; ++key) {
            uint256 aliceNonce = entryPoint.getNonce(alice, key);
            uint256 bobNonce = entryPoint.getNonce(bob, key);
            require(aliceNonce >> 64 == uint256(key), "Alice nonce escaped its key");
            require(bobNonce >> 64 == uint256(key), "Bob nonce escaped its key");
        }
    }

    function invariantDepositsRemainFullyBacked() public view {
        EntryPoint entryPoint = handler.entryPoint();
        uint256 accounted =
            entryPoint.balanceOf(address(handler.alice())) + entryPoint.balanceOf(address(handler.bob()));
        require(address(entryPoint).balance == accounted, "EntryPoint balance diverged from account deposits");
    }
}
