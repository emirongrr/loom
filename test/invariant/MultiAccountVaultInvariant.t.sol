// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {VaultHook} from "../../src/hooks/VaultHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {StdInvariant} from "../../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

interface VmMultiAccountVaultInvariant {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
}

contract MultiAccountVaultHandler {
    VmMultiAccountVaultInvariant internal constant vm =
        VmMultiAccountVaultInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ALICE_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;
    uint256 internal constant INITIAL_DEPOSIT = 100 ether;
    uint256 internal constant INITIAL_TOKEN_BALANCE = 1_000;
    uint128 internal constant DAILY_LIMIT = 100;
    uint48 internal constant PERIOD = 1 days;
    uint48 internal constant WITHDRAWAL_DELAY = 2 days;
    address internal constant BUNDLER = address(0xB0B0);
    address public constant ALICE_RECIPIENT = address(0xA11CE01);
    address public constant BOB_RECIPIENT = address(0xB0B01);

    EntryPoint public immutable entryPoint;
    ECDSAValidator public immutable validator;
    VaultHook public immutable vault;
    MockERC20 public immutable token;
    LoomAccount public immutable alice;
    LoomAccount public immutable bob;
    address public immutable aliceOwner;
    address public immutable bobOwner;
    bytes32 public immutable aliceConfigHash;
    bytes32 public immutable bobConfigHash;
    bytes32 public immutable aliceGuardianRoot;
    bytes32 public immutable bobGuardianRoot;

    bool public violated;
    uint256 public successfulSpends;
    uint256 public isolatedLimitFailures;
    uint256 public periodAdvances;

    struct AccountSnapshot {
        uint256 tokenBalance;
        uint256 recipientBalance;
        uint256 deposit;
        uint256 nonce;
        uint128 spent;
        uint48 periodStart;
        address owner;
        bytes32 configHash;
        bytes32 guardianRoot;
        uint64 configVersion;
        uint8 guardianThreshold;
        uint256 validatorCount;
    }

    constructor() {
        entryPoint = new EntryPoint();
        validator = new ECDSAValidator();
        vault = new VaultHook();
        token = new MockERC20();
        aliceOwner = vm.addr(ALICE_KEY);
        bobOwner = vm.addr(BOB_KEY);
        aliceConfigHash = keccak256("multi-account-vault-alice-config");
        bobConfigHash = keccak256("multi-account-vault-bob-config");
        aliceGuardianRoot = keccak256("multi-account-vault-alice-guardians");
        bobGuardianRoot = keccak256("multi-account-vault-bob-guardians");

        alice = new LoomAccount(address(entryPoint), aliceGuardianRoot, 1, aliceConfigHash, _modules(aliceOwner));
        bob = new LoomAccount(address(entryPoint), bobGuardianRoot, 1, bobConfigHash, _modules(bobOwner));

        vm.deal(address(this), 2 * INITIAL_DEPOSIT);
        entryPoint.depositTo{value: INITIAL_DEPOSIT}(address(alice));
        entryPoint.depositTo{value: INITIAL_DEPOSIT}(address(bob));
        token.mint(address(alice), INITIAL_TOKEN_BALANCE);
        token.mint(address(bob), INITIAL_TOKEN_BALANCE);
        _configureVault(alice, ALICE_KEY);
        _configureVault(bob, BOB_KEY);
        violated = false;
    }

    function spendAlice(uint128 seed) external {
        _spend(alice, bob, ALICE_RECIPIENT, BOB_RECIPIENT, ALICE_KEY, seed);
    }

    function spendBob(uint128 seed) external {
        _spend(bob, alice, BOB_RECIPIENT, ALICE_RECIPIENT, BOB_KEY, seed);
    }

    function spendMixedBundle(uint128 aliceSeed, uint128 bobSeed) external {
        uint256 aliceAmount = _boundedSpend(alice, aliceSeed);
        uint256 bobAmount = _boundedSpend(bob, bobSeed);
        if (aliceAmount == 0 || bobAmount == 0) return;

        AccountSnapshot memory aliceBefore = _snapshot(alice, ALICE_RECIPIENT);
        AccountSnapshot memory bobBefore = _snapshot(bob, BOB_RECIPIENT);
        uint256 beneficiaryBefore = address(this).balance;

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _transferOperation(alice, ALICE_RECIPIENT, aliceAmount, ALICE_KEY);
        ops[1] = _transferOperation(bob, BOB_RECIPIENT, bobAmount, BOB_KEY);
        (bool ok,) = _handleOps(ops);

        AccountSnapshot memory aliceAfter = _snapshot(alice, ALICE_RECIPIENT);
        AccountSnapshot memory bobAfter = _snapshot(bob, BOB_RECIPIENT);
        if (!ok || !_successfulSpend(aliceBefore, aliceAfter, aliceAmount)) violated = true;
        if (!ok || !_successfulSpend(bobBefore, bobAfter, bobAmount)) violated = true;
        if (
            aliceAfter.deposit + bobAfter.deposit + address(this).balance - beneficiaryBefore
                != aliceBefore.deposit + bobBefore.deposit
        ) violated = true;
        if (ok) successfulSpends += 2;
    }

    function isolateAliceLimitFailureFromBob(uint128 bobSeed) external {
        _isolateLimitFailure(alice, bob, ALICE_RECIPIENT, BOB_RECIPIENT, ALICE_KEY, BOB_KEY, bobSeed);
    }

    function isolateBobLimitFailureFromAlice(uint128 aliceSeed) external {
        _isolateLimitFailure(bob, alice, BOB_RECIPIENT, ALICE_RECIPIENT, BOB_KEY, ALICE_KEY, aliceSeed);
    }

    function advanceVaultPeriod(uint48 extra) external {
        vm.warp(block.timestamp + PERIOD + uint256(extra % PERIOD));
        ++periodAdvances;
    }

    function _spend(
        LoomAccount account,
        LoomAccount other,
        address recipient,
        address otherRecipient,
        uint256 signingKey,
        uint128 seed
    ) internal {
        uint256 amount = _boundedSpend(account, seed);
        if (amount == 0) return;
        AccountSnapshot memory beforeState = _snapshot(account, recipient);
        AccountSnapshot memory otherBefore = _snapshot(other, otherRecipient);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _transferOperation(account, recipient, amount, signingKey);
        (bool ok,) = _handleOps(ops);
        AccountSnapshot memory afterState = _snapshot(account, recipient);

        if (!ok || !_successfulSpend(beforeState, afterState, amount)) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other, otherRecipient))) violated = true;
        if (ok) ++successfulSpends;
    }

    function _isolateLimitFailure(
        LoomAccount failing,
        LoomAccount succeeding,
        address failingRecipient,
        address succeedingRecipient,
        uint256 failingKey,
        uint256 succeedingKey,
        uint128 succeedingSeed
    ) internal {
        uint256 succeedingAmount = _boundedSpend(succeeding, succeedingSeed);
        if (succeedingAmount == 0) return;
        uint256 failingAmount = _remaining(failing) + 1;
        AccountSnapshot memory failingBefore = _snapshot(failing, failingRecipient);
        AccountSnapshot memory succeedingBefore = _snapshot(succeeding, succeedingRecipient);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _transferOperation(failing, failingRecipient, failingAmount, failingKey);
        ops[1] = _transferOperation(succeeding, succeedingRecipient, succeedingAmount, succeedingKey);
        (bool ok,) = _handleOps(ops);

        AccountSnapshot memory failingAfter = _snapshot(failing, failingRecipient);
        AccountSnapshot memory succeedingAfter = _snapshot(succeeding, succeedingRecipient);
        if (!ok || !_failedExecutionRolledBack(failingBefore, failingAfter)) violated = true;
        if (!ok || !_successfulSpend(succeedingBefore, succeedingAfter, succeedingAmount)) violated = true;
        if (ok) {
            ++isolatedLimitFailures;
            ++successfulSpends;
        }
    }

    function _configureVault(LoomAccount account, uint256 signingKey) internal {
        VaultHook.VaultPolicy memory policy = VaultHook.VaultPolicy(DAILY_LIMIT, PERIOD, WITHDRAWAL_DELAY, true);
        bytes memory policyCall = abi.encodeCall(VaultHook.setVaultPolicy, (address(token), policy));
        bytes memory scheduleSelfCall =
            abi.encodeCall(LoomAccount.scheduleCall, (address(vault), 0, policyCall, account.MIN_CONFIG_DELAY()));
        ExecutionLib.Execution memory scheduleExecution = ExecutionLib.Execution(address(account), 0, scheduleSelfCall);
        bytes memory scheduleCall =
            abi.encodeCall(LoomAccount.execute, (ExecutionLib.SINGLE_EXECUTION_MODE, abi.encode(scheduleExecution)));
        require(_submit(account, signingKey, scheduleCall), "vault policy schedule failed");
        bytes32 operationId = keccak256(abi.encode(address(vault), uint256(0), policyCall, account.configVersion()));
        (uint48 pendingReadyAt1,,) = account.scheduledOperations(operationId);
        require(pendingReadyAt1 != 0, "vault policy schedule missing");
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        bytes memory executeCall = abi.encodeCall(LoomAccount.executeScheduled, (address(vault), 0, policyCall));
        require(_submit(account, signingKey, executeCall), "vault policy execution failed");
        (uint128 limit, uint48 period, uint48 delay, bool enabled) = vault.policies(address(account), address(token));
        require(
            enabled && limit == DAILY_LIMIT && period == PERIOD && delay == WITHDRAWAL_DELAY,
            "vault policy post-state mismatch"
        );
    }

    function _submit(LoomAccount account, uint256 signingKey, bytes memory accountCall) internal returns (bool ok) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _signedOperation(account, signingKey, accountCall);
        (ok,) = _handleOps(ops);
    }

    function _transferOperation(LoomAccount account, address recipient, uint256 amount, uint256 signingKey)
        internal
        returns (PackedUserOperation memory)
    {
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (recipient, amount)));
        return _signedOperation(
            account,
            signingKey,
            abi.encodeCall(LoomAccount.execute, (ExecutionLib.SINGLE_EXECUTION_MODE, abi.encode(execution)))
        );
    }

    function _signedOperation(LoomAccount account, uint256 signingKey, bytes memory accountCall)
        internal
        returns (PackedUserOperation memory op)
    {
        op = PackedUserOperation({
            sender: address(account),
            nonce: entryPoint.getNonce(address(account), 0),
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
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
    }

    function _handleOps(PackedUserOperation[] memory ops) internal returns (bool ok, bytes memory result) {
        vm.startPrank(BUNDLER, BUNDLER);
        (ok, result) = address(entryPoint).call(abi.encodeCall(IEntryPoint.handleOps, (ops, payable(address(this)))));
        vm.stopPrank();
    }

    function _modules(address owner) internal view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(vault), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(vault)))
        );
    }

    function _boundedSpend(LoomAccount account, uint128 seed) internal view returns (uint256) {
        uint256 remaining = _remaining(account);
        return remaining == 0 ? 0 : (uint256(seed) % remaining) + 1;
    }

    function _remaining(LoomAccount account) internal view returns (uint256) {
        (uint128 amount, uint48 periodStart) = vault.spending(address(account), address(token));
        // Mirrors VaultHook's period rollover rule in the invariant model.
        // forge-lint: disable-next-line(block-timestamp)
        if (periodStart == 0 || block.timestamp >= uint256(periodStart) + PERIOD) return DAILY_LIMIT;
        return DAILY_LIMIT - amount;
    }

    function _snapshot(LoomAccount account, address recipient) internal view returns (AccountSnapshot memory state) {
        (uint128 spent, uint48 periodStart) = vault.spending(address(account), address(token));
        state = AccountSnapshot({
            tokenBalance: token.balanceOf(address(account)),
            recipientBalance: token.balanceOf(recipient),
            deposit: entryPoint.balanceOf(address(account)),
            nonce: entryPoint.getNonce(address(account), 0),
            spent: spent,
            periodStart: periodStart,
            owner: validator.owners(address(account)),
            configHash: account.configHash(),
            guardianRoot: account.guardianRoot(),
            configVersion: account.configVersion(),
            guardianThreshold: account.guardianThreshold(),
            validatorCount: account.validatorCount()
        });
    }

    function _successfulSpend(AccountSnapshot memory beforeState, AccountSnapshot memory afterState, uint256 amount)
        internal
        view
        returns (bool)
    {
        // Mirrors VaultHook's period rollover rule in the invariant model.
        // forge-lint: disable-next-line(block-timestamp)
        bool periodRolledOver = block.timestamp >= uint256(beforeState.periodStart) + PERIOD;
        uint256 expectedSpent = periodRolledOver ? amount : uint256(beforeState.spent) + amount;
        return afterState.tokenBalance + amount == beforeState.tokenBalance
            && afterState.recipientBalance == beforeState.recipientBalance + amount
            && afterState.nonce == beforeState.nonce + 1 && afterState.spent == expectedSpent
            && afterState.deposit < beforeState.deposit && _sameAuthority(beforeState, afterState);
    }

    function _failedExecutionRolledBack(AccountSnapshot memory beforeState, AccountSnapshot memory afterState)
        internal
        pure
        returns (bool)
    {
        return afterState.tokenBalance == beforeState.tokenBalance
            && afterState.recipientBalance == beforeState.recipientBalance && afterState.nonce == beforeState.nonce + 1
            && afterState.spent == beforeState.spent && afterState.periodStart == beforeState.periodStart
            && afterState.deposit < beforeState.deposit && _sameAuthority(beforeState, afterState);
    }

    function _sameAuthority(AccountSnapshot memory left, AccountSnapshot memory right) internal pure returns (bool) {
        return left.owner == right.owner && left.configHash == right.configHash
            && left.guardianRoot == right.guardianRoot && left.configVersion == right.configVersion
            && left.guardianThreshold == right.guardianThreshold && left.validatorCount == right.validatorCount;
    }

    function _sameAccountState(AccountSnapshot memory left, AccountSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    receive() external payable {}
}

contract MultiAccountVaultInvariantTest is StdInvariant {
    MultiAccountVaultHandler internal handler;

    function setUp() public {
        handler = new MultiAccountVaultHandler();
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = MultiAccountVaultHandler.spendAlice.selector;
        selectors[1] = MultiAccountVaultHandler.spendBob.selector;
        selectors[2] = MultiAccountVaultHandler.spendMixedBundle.selector;
        selectors[3] = MultiAccountVaultHandler.isolateAliceLimitFailureFromBob.selector;
        selectors[4] = MultiAccountVaultHandler.isolateBobLimitFailureFromAlice.selector;
        selectors[5] = MultiAccountVaultHandler.advanceVaultPeriod.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantVaultAuthorityAndPoliciesRemainAccountScoped() public view {
        require(!handler.violated(), "multi-account vault handler observed an invariant violation");
        require(handler.validator().owners(address(handler.alice())) == handler.aliceOwner(), "Alice owner changed");
        require(handler.validator().owners(address(handler.bob())) == handler.bobOwner(), "Bob owner changed");
        require(address(handler.alice()) != address(handler.bob()), "vault account identities collided");

        (uint128 aliceLimit, uint48 alicePeriod, uint48 aliceDelay, bool aliceEnabled) =
            handler.vault().policies(address(handler.alice()), address(handler.token()));
        (uint128 bobLimit, uint48 bobPeriod, uint48 bobDelay, bool bobEnabled) =
            handler.vault().policies(address(handler.bob()), address(handler.token()));
        require(aliceEnabled && bobEnabled, "vault policy disabled");
        require(aliceLimit == 100 && bobLimit == 100, "vault daily limit changed");
        require(alicePeriod == 1 days && bobPeriod == 1 days, "vault period changed");
        require(aliceDelay == 2 days && bobDelay == 2 days, "vault delay changed");
    }

    function invariantVaultSpendingAndTokenBalancesRemainConserved() public view {
        (uint128 aliceSpent,) = handler.vault().spending(address(handler.alice()), address(handler.token()));
        (uint128 bobSpent,) = handler.vault().spending(address(handler.bob()), address(handler.token()));
        require(aliceSpent <= 100 && bobSpent <= 100, "vault daily budget exceeded");

        uint256 accounted = handler.token().balanceOf(address(handler.alice()))
            + handler.token().balanceOf(address(handler.bob())) + handler.token().balanceOf(handler.ALICE_RECIPIENT())
            + handler.token().balanceOf(handler.BOB_RECIPIENT());
        require(accounted == 2_000, "vault token accounting diverged");
    }

    function invariantVaultDepositsRemainFullyBacked() public view {
        uint256 accounted = handler.entryPoint().balanceOf(address(handler.alice()))
            + handler.entryPoint().balanceOf(address(handler.bob()));
        require(address(handler.entryPoint()).balance == accounted, "vault deposits are not fully backed");
        require(
            address(handler.entryPoint()).balance + address(handler).balance == 2 * 100 ether,
            "vault gas settlement broke conservation"
        );
    }
}
