// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {EntryPointMultiAccountHandler, VmMultiAccountInvariant} from "./EntryPointMultiAccountInvariant.t.sol";
import {StdInvariant} from "../../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

contract StatefulPaymaster is IPaymaster {
    error OnlyEntryPoint();
    error ForcedPostOpRevert();
    error InvalidContext();

    IEntryPoint public immutable entryPoint;
    bool public immutable revertPostOperation;
    uint256 public validationCalls;
    uint256 public postOpCalls;
    PostOpMode public lastPostOpMode;

    constructor(IEntryPoint entryPoint_, bool revertPostOperation_) {
        entryPoint = entryPoint_;
        revertPostOperation = revertPostOperation_;
    }

    function fund() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        external
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        ++validationCalls;
        return (abi.encode(address(this)), 0);
    }

    function postOp(PostOpMode mode, bytes calldata context, uint256, uint256) external {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        if (abi.decode(context, (address)) != address(this)) revert InvalidContext();
        if (revertPostOperation) revert ForcedPostOpRevert();
        ++postOpCalls;
        lastPostOpMode = mode;
    }
}

contract EntryPointMultiAccountPaymasterHandler is EntryPointMultiAccountHandler {
    uint256 internal constant INITIAL_SPONSOR_DEPOSIT = 10 ether;

    StatefulPaymaster public immutable alicePaymaster;
    StatefulPaymaster public immutable bobPaymaster;
    StatefulPaymaster public immutable underfundedPaymaster;
    StatefulPaymaster public immutable revertingPaymaster;

    uint256 public successfulSponsoredOperations;
    uint256 public revertedSponsoredExecutions;
    uint256 public rejectedSponsoredBundles;

    struct SponsorSnapshot {
        SystemSnapshot systemState;
        uint256 alicePaymasterDeposit;
        uint256 bobPaymasterDeposit;
        uint256 underfundedPaymasterDeposit;
        uint256 revertingPaymasterDeposit;
        uint256 aliceValidationCalls;
        uint256 alicePostOpCalls;
        uint256 bobValidationCalls;
        uint256 bobPostOpCalls;
        uint256 underfundedValidationCalls;
        uint256 underfundedPostOpCalls;
        uint256 revertingValidationCalls;
        uint256 revertingPostOpCalls;
    }

    constructor() {
        alicePaymaster = new StatefulPaymaster(IEntryPoint(address(entryPoint)), false);
        bobPaymaster = new StatefulPaymaster(IEntryPoint(address(entryPoint)), false);
        underfundedPaymaster = new StatefulPaymaster(IEntryPoint(address(entryPoint)), false);
        revertingPaymaster = new StatefulPaymaster(IEntryPoint(address(entryPoint)), true);

        vm.deal(address(this), 3 * INITIAL_SPONSOR_DEPOSIT);
        alicePaymaster.fund{value: INITIAL_SPONSOR_DEPOSIT}();
        bobPaymaster.fund{value: INITIAL_SPONSOR_DEPOSIT}();
        revertingPaymaster.fund{value: INITIAL_SPONSOR_DEPOSIT}();
    }

    function sponsorAlice(uint256 value, uint8 keySeed) external {
        AccountSnapshot memory bobBefore = _snapshot(bob, bobTarget);
        uint256 bobSponsorBefore = entryPoint.balanceOf(address(bobPaymaster));
        uint256 bobValidationBefore = bobPaymaster.validationCalls();
        uint256 bobPostOpBefore = bobPaymaster.postOpCalls();
        uint256 aliceAccountDepositBefore = entryPoint.balanceOf(address(alice));
        uint256 sponsorDepositBefore = entryPoint.balanceOf(address(alicePaymaster));
        uint256 beneficiaryBefore = address(this).balance;
        uint192 nonceKey = _nonceKey(keySeed);
        uint256 nonceBefore = entryPoint.getNonce(address(alice), nonceKey);
        uint256 validationBefore = alicePaymaster.validationCalls();
        uint256 postOpBefore = alicePaymaster.postOpCalls();

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sponsoredOperation(alice, aliceTarget, value, nonceKey, ALICE_KEY, alicePaymaster, false);
        (bool ok,) = _handleOps(ops);

        uint256 sponsorDepositAfter = entryPoint.balanceOf(address(alicePaymaster));
        if (!ok || aliceTarget.value() != value) violated = true;
        if (entryPoint.getNonce(address(alice), nonceKey) != nonceBefore + 1) violated = true;
        if (entryPoint.balanceOf(address(alice)) != aliceAccountDepositBefore) violated = true;
        if (sponsorDepositAfter >= sponsorDepositBefore) violated = true;
        if (sponsorDepositAfter + address(this).balance - beneficiaryBefore != sponsorDepositBefore) violated = true;
        if (alicePaymaster.validationCalls() != validationBefore + 1) violated = true;
        if (alicePaymaster.postOpCalls() != postOpBefore + 1) violated = true;
        if (alicePaymaster.lastPostOpMode() != IPaymaster.PostOpMode.opSucceeded) violated = true;
        if (!_sameAccountState(bobBefore, _snapshot(bob, bobTarget))) violated = true;
        if (entryPoint.balanceOf(address(bobPaymaster)) != bobSponsorBefore) violated = true;
        if (bobPaymaster.validationCalls() != bobValidationBefore || bobPaymaster.postOpCalls() != bobPostOpBefore) {
            violated = true;
        }
        if (ok) ++successfulSponsoredOperations;
    }

    function sponsorBob(uint256 value, uint8 keySeed) external {
        AccountSnapshot memory aliceBefore = _snapshot(alice, aliceTarget);
        uint256 aliceSponsorBefore = entryPoint.balanceOf(address(alicePaymaster));
        uint256 aliceValidationBefore = alicePaymaster.validationCalls();
        uint256 alicePostOpBefore = alicePaymaster.postOpCalls();
        uint256 bobAccountDepositBefore = entryPoint.balanceOf(address(bob));
        uint256 sponsorDepositBefore = entryPoint.balanceOf(address(bobPaymaster));
        uint256 beneficiaryBefore = address(this).balance;
        uint192 nonceKey = _nonceKey(keySeed);
        uint256 nonceBefore = entryPoint.getNonce(address(bob), nonceKey);
        uint256 validationBefore = bobPaymaster.validationCalls();
        uint256 postOpBefore = bobPaymaster.postOpCalls();

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sponsoredOperation(bob, bobTarget, value, nonceKey, BOB_KEY, bobPaymaster, false);
        (bool ok,) = _handleOps(ops);

        uint256 sponsorDepositAfter = entryPoint.balanceOf(address(bobPaymaster));
        if (!ok || bobTarget.value() != value) violated = true;
        if (entryPoint.getNonce(address(bob), nonceKey) != nonceBefore + 1) violated = true;
        if (entryPoint.balanceOf(address(bob)) != bobAccountDepositBefore) violated = true;
        if (sponsorDepositAfter >= sponsorDepositBefore) violated = true;
        if (sponsorDepositAfter + address(this).balance - beneficiaryBefore != sponsorDepositBefore) violated = true;
        if (bobPaymaster.validationCalls() != validationBefore + 1) violated = true;
        if (bobPaymaster.postOpCalls() != postOpBefore + 1) violated = true;
        if (bobPaymaster.lastPostOpMode() != IPaymaster.PostOpMode.opSucceeded) violated = true;
        if (!_sameAccountState(aliceBefore, _snapshot(alice, aliceTarget))) violated = true;
        if (entryPoint.balanceOf(address(alicePaymaster)) != aliceSponsorBefore) violated = true;
        if (
            alicePaymaster.validationCalls() != aliceValidationBefore
                || alicePaymaster.postOpCalls() != alicePostOpBefore
        ) violated = true;
        if (ok) ++successfulSponsoredOperations;
    }

    function executeMixedSponsoredBundle(uint256 aliceValue, uint256 bobValue, uint8 aliceKeySeed, uint8 bobKeySeed)
        external
    {
        uint192 aliceNonceKey = _nonceKey(aliceKeySeed);
        uint192 bobNonceKey = _nonceKey(bobKeySeed);
        uint256 aliceNonceBefore = entryPoint.getNonce(address(alice), aliceNonceKey);
        uint256 bobNonceBefore = entryPoint.getNonce(address(bob), bobNonceKey);
        uint256 aliceSponsorBefore = entryPoint.balanceOf(address(alicePaymaster));
        uint256 bobSponsorBefore = entryPoint.balanceOf(address(bobPaymaster));
        uint256 beneficiaryBefore = address(this).balance;
        uint256 aliceValidationBefore = alicePaymaster.validationCalls();
        uint256 bobValidationBefore = bobPaymaster.validationCalls();

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _sponsoredOperation(alice, aliceTarget, aliceValue, aliceNonceKey, ALICE_KEY, alicePaymaster, false);
        ops[1] = _sponsoredOperation(bob, bobTarget, bobValue, bobNonceKey, BOB_KEY, bobPaymaster, false);
        (bool ok,) = _handleOps(ops);

        uint256 aliceSponsorAfter = entryPoint.balanceOf(address(alicePaymaster));
        uint256 bobSponsorAfter = entryPoint.balanceOf(address(bobPaymaster));
        if (!ok || aliceTarget.value() != aliceValue || bobTarget.value() != bobValue) violated = true;
        if (entryPoint.getNonce(address(alice), aliceNonceKey) != aliceNonceBefore + 1) violated = true;
        if (entryPoint.getNonce(address(bob), bobNonceKey) != bobNonceBefore + 1) violated = true;
        if (aliceSponsorAfter >= aliceSponsorBefore || bobSponsorAfter >= bobSponsorBefore) violated = true;
        if (
            aliceSponsorAfter + bobSponsorAfter + address(this).balance - beneficiaryBefore
                != aliceSponsorBefore + bobSponsorBefore
        ) violated = true;
        if (alicePaymaster.validationCalls() != aliceValidationBefore + 1) violated = true;
        if (bobPaymaster.validationCalls() != bobValidationBefore + 1) violated = true;
        if (ok) successfulSponsoredOperations += 2;
    }

    function executeRevertingPostOpThenBob(uint256 bobValue, uint8 aliceKeySeed, uint8 bobKeySeed) external {
        uint192 aliceNonceKey = _nonceKey(aliceKeySeed);
        uint192 bobNonceKey = _nonceKey(bobKeySeed);
        uint256 aliceNonceBefore = entryPoint.getNonce(address(alice), aliceNonceKey);
        uint256 bobNonceBefore = entryPoint.getNonce(address(bob), bobNonceKey);
        uint256 aliceTargetBefore = aliceTarget.value();
        uint256 revertingDepositBefore = entryPoint.balanceOf(address(revertingPaymaster));
        uint256 bobDepositBefore = entryPoint.balanceOf(address(bobPaymaster));
        uint256 beneficiaryBefore = address(this).balance;
        uint256 revertingValidationBefore = revertingPaymaster.validationCalls();
        uint256 revertingPostOpBefore = revertingPaymaster.postOpCalls();

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _sponsoredOperation(alice, aliceTarget, 0, aliceNonceKey, ALICE_KEY, revertingPaymaster, false);
        ops[1] = _sponsoredOperation(bob, bobTarget, bobValue, bobNonceKey, BOB_KEY, bobPaymaster, false);
        (bool ok,) = _handleOps(ops);

        uint256 revertingDepositAfter = entryPoint.balanceOf(address(revertingPaymaster));
        uint256 bobDepositAfter = entryPoint.balanceOf(address(bobPaymaster));
        if (!ok || aliceTarget.value() != aliceTargetBefore || bobTarget.value() != bobValue) violated = true;
        if (entryPoint.getNonce(address(alice), aliceNonceKey) != aliceNonceBefore + 1) violated = true;
        if (entryPoint.getNonce(address(bob), bobNonceKey) != bobNonceBefore + 1) violated = true;
        if (revertingDepositAfter >= revertingDepositBefore || bobDepositAfter >= bobDepositBefore) violated = true;
        if (
            revertingDepositAfter + bobDepositAfter + address(this).balance - beneficiaryBefore
                != revertingDepositBefore + bobDepositBefore
        ) violated = true;
        if (revertingPaymaster.validationCalls() != revertingValidationBefore + 1) violated = true;
        if (revertingPaymaster.postOpCalls() != revertingPostOpBefore) violated = true;
        if (ok) {
            ++revertedSponsoredExecutions;
            ++successfulSponsoredOperations;
        }
    }

    function rejectUnderfundedSecondOperation(
        uint256 aliceValue,
        uint256 bobValue,
        uint8 aliceKeySeed,
        uint8 bobKeySeed
    ) external {
        SponsorSnapshot memory beforeState = _sponsorSnapshot();
        uint192 aliceNonceKey = _nonceKey(aliceKeySeed);
        uint192 bobNonceKey = _nonceKey(bobKeySeed);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _sponsoredOperation(bob, bobTarget, bobValue, bobNonceKey, BOB_KEY, bobPaymaster, false);
        ops[1] =
            _sponsoredOperation(alice, aliceTarget, aliceValue, aliceNonceKey, ALICE_KEY, underfundedPaymaster, false);

        (bool ok, bytes memory revertData) = _handleOps(ops);
        bytes memory expected =
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 1, "AA31 paymaster deposit too low");
        if (ok || keccak256(revertData) != keccak256(expected)) violated = true;
        if (!_sameSponsorState(beforeState, _sponsorSnapshot())) violated = true;
        if (!ok) ++rejectedSponsoredBundles;
    }

    function _sponsoredOperation(
        LoomAccount account,
        MockTarget operationTarget,
        uint256 value,
        uint192 nonceKey,
        uint256 signingKey,
        StatefulPaymaster paymaster,
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
            paymasterAndData: abi.encodePacked(address(paymaster), uint128(1_000_000), uint128(1_000_000)),
            signature: ""
        });
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingKey, userOpHash);
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
    }

    function _sponsorSnapshot() internal view returns (SponsorSnapshot memory state) {
        state = SponsorSnapshot({
            systemState: _systemSnapshot(),
            alicePaymasterDeposit: entryPoint.balanceOf(address(alicePaymaster)),
            bobPaymasterDeposit: entryPoint.balanceOf(address(bobPaymaster)),
            underfundedPaymasterDeposit: entryPoint.balanceOf(address(underfundedPaymaster)),
            revertingPaymasterDeposit: entryPoint.balanceOf(address(revertingPaymaster)),
            aliceValidationCalls: alicePaymaster.validationCalls(),
            alicePostOpCalls: alicePaymaster.postOpCalls(),
            bobValidationCalls: bobPaymaster.validationCalls(),
            bobPostOpCalls: bobPaymaster.postOpCalls(),
            underfundedValidationCalls: underfundedPaymaster.validationCalls(),
            underfundedPostOpCalls: underfundedPaymaster.postOpCalls(),
            revertingValidationCalls: revertingPaymaster.validationCalls(),
            revertingPostOpCalls: revertingPaymaster.postOpCalls()
        });
    }

    function _sameSponsorState(SponsorSnapshot memory left, SponsorSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }
}

contract EntryPointMultiAccountPaymasterInvariantTest is StdInvariant {
    EntryPointMultiAccountPaymasterHandler internal handler;

    function setUp() public {
        handler = new EntryPointMultiAccountPaymasterHandler();

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = EntryPointMultiAccountPaymasterHandler.sponsorAlice.selector;
        selectors[1] = EntryPointMultiAccountPaymasterHandler.sponsorBob.selector;
        selectors[2] = EntryPointMultiAccountPaymasterHandler.executeMixedSponsoredBundle.selector;
        selectors[3] = EntryPointMultiAccountPaymasterHandler.executeRevertingPostOpThenBob.selector;
        selectors[4] = EntryPointMultiAccountPaymasterHandler.rejectUnderfundedSecondOperation.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantSponsoredAccountsRetainIndependentAuthority() public view {
        LoomAccount alice = handler.alice();
        LoomAccount bob = handler.bob();

        require(!handler.violated(), "sponsored handler observed an invariant violation");
        require(handler.validator().owners(address(alice)) == handler.aliceOwner(), "Alice authority changed");
        require(handler.validator().owners(address(bob)) == handler.bobOwner(), "Bob authority changed");
        require(alice.configHash() == handler.aliceConfigHash(), "Alice config changed");
        require(bob.configHash() == handler.bobConfigHash(), "Bob config changed");
        require(alice.guardianRoot() == handler.aliceGuardianRoot(), "Alice guardians changed");
        require(bob.guardianRoot() == handler.bobGuardianRoot(), "Bob guardians changed");
    }

    function invariantSponsoredNonceKeysRemainAccountScoped() public view {
        address alice = address(handler.alice());
        address bob = address(handler.bob());
        for (uint192 key; key < 3; ++key) {
            require(handler.entryPoint().getNonce(alice, key) >> 64 == uint256(key), "Alice nonce escaped its key");
            require(handler.entryPoint().getNonce(bob, key) >> 64 == uint256(key), "Bob nonce escaped its key");
        }
    }

    function invariantAllEntryPointDepositsRemainFullyBacked() public view {
        uint256 accounted = handler.entryPoint().balanceOf(address(handler.alice()))
            + handler.entryPoint().balanceOf(address(handler.bob()))
            + handler.entryPoint().balanceOf(address(handler.alicePaymaster()))
            + handler.entryPoint().balanceOf(address(handler.bobPaymaster()))
            + handler.entryPoint().balanceOf(address(handler.underfundedPaymaster()))
            + handler.entryPoint().balanceOf(address(handler.revertingPaymaster()));
        require(address(handler.entryPoint()).balance == accounted, "EntryPoint sponsor deposits are not fully backed");
    }

    function invariantPaymasterLifecycleCountersRemainConsistent() public view {
        StatefulPaymaster alicePaymaster = handler.alicePaymaster();
        StatefulPaymaster bobPaymaster = handler.bobPaymaster();
        StatefulPaymaster underfundedPaymaster = handler.underfundedPaymaster();
        StatefulPaymaster revertingPaymaster = handler.revertingPaymaster();

        require(alicePaymaster.validationCalls() == alicePaymaster.postOpCalls(), "Alice sponsor lifecycle drifted");
        require(bobPaymaster.validationCalls() == bobPaymaster.postOpCalls(), "Bob sponsor lifecycle drifted");
        require(
            underfundedPaymaster.validationCalls() == 0 && underfundedPaymaster.postOpCalls() == 0,
            "underfunded sponsor was invoked"
        );
        require(revertingPaymaster.postOpCalls() == 0, "reverting sponsor persisted postOp state");
    }
}
