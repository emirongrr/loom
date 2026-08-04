// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmHooks {
    function warp(uint256 timestamp) external;
}

/// @notice Shared tape the hooks under test write to, so composition order is
/// observable rather than inferred.
contract HookCallRecorder {
    bytes32[] public calls;

    function record(bytes32 entry) external {
        calls.push(entry);
    }

    function length() external view returns (uint256) {
        return calls.length;
    }

    function reset() external {
        delete calls;
    }
}

/// @notice Hook that reports which of its callbacks ran and in what order, and
/// returns identifying `hookData` so the account's pairing of pre- and
/// post-check state can be checked rather than assumed.
contract OrderRecordingHook is ILoomHook {
    HookCallRecorder internal immutable recorder;
    bytes32 internal immutable label;

    constructor(HookCallRecorder recorder_, bytes32 label_) {
        recorder = recorder_;
        label = label_;
    }

    function preCheck(address, address, bytes calldata) external returns (bytes memory) {
        recorder.record(keccak256(abi.encode("pre", label)));
        return abi.encode(label);
    }

    function postCheck(address, bytes calldata hookData) external {
        // Fail loudly rather than silently if the account ever hands a hook the
        // wrong slot's data; a mismatched pairing is the failure this test is
        // meant to catch.
        require(abi.decode(hookData, (bytes32)) == label, "hook received another hook's data");
        recorder.record(keccak256(abi.encode("post", label)));
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }
}

contract HookCompositionTest {
    VmHooks internal constant vm = VmHooks(address(uint160(uint256(keccak256("hevm cheat code")))));

    HookCallRecorder internal recorder;
    LoomAccount internal account;
    MockTarget internal target;
    OrderRecordingHook internal first;
    OrderRecordingHook internal second;
    OrderRecordingHook internal third;

    function setUp() public {
        recorder = new HookCallRecorder();
        first = new OrderRecordingHook(recorder, "first");
        second = new OrderRecordingHook(recorder, "second");
        third = new OrderRecordingHook(recorder, "third");
        target = new MockTarget();

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](4);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(first), "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.HOOK, address(second), "");
        modules[3] = LoomAccount.ModuleInit(ModuleType.HOOK, address(third), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    /// @dev Every hook's `preCheck` runs before any target call, and every
    /// `postCheck` runs after, both in installation order. `postCheck` is not
    /// reversed: hooks are peers around one execution, not nested wrappers, and
    /// a hook author who assumes LIFO teardown would be wrong.
    function testHooksRunInInstallationOrderAroundTheWholeExecution() public {
        _execute(7);

        require(recorder.length() == 6, "unexpected hook callback count");
        _assertTape(
            [
                _entry("pre", "first"),
                _entry("pre", "second"),
                _entry("pre", "third"),
                _entry("post", "first"),
                _entry("post", "second"),
                _entry("post", "third")
            ]
        );
        require(target.value() == 7, "execution did not reach the target");
    }

    /// @dev The finding this test exists for: removal used a swap-and-pop, so
    /// uninstalling the first hook moved the last one into its slot and the
    /// surviving hooks silently swapped places. Nothing reverted and no test
    /// failed - the order just quietly became a different order.
    function testUninstallingAHookDoesNotReorderTheSurvivors() public {
        _uninstall(address(first));
        recorder.reset();

        _execute(11);

        require(recorder.length() == 4, "uninstalled hook still ran");
        _assertTape4(
            [_entry("pre", "second"), _entry("pre", "third"), _entry("post", "second"), _entry("post", "third")]
        );
    }

    /// @dev A swap-and-pop happens to produce the right answer here, because
    /// the entry moved into the gap is the one that already followed it. That
    /// is exactly why this case cannot be the only coverage: the sibling test
    /// above removes the first hook, where the two removal strategies diverge.
    function testUninstallingAMiddleHookKeepsTheRemainingOrder() public {
        _uninstall(address(second));
        recorder.reset();

        _execute(13);

        require(recorder.length() == 4, "uninstalled hook still ran");
        _assertTape4([_entry("pre", "first"), _entry("pre", "third"), _entry("post", "first"), _entry("post", "third")]);
    }

    function _execute(uint256 value) internal {
        account.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (value))))
        );
    }

    function _uninstall(address hook) internal {
        bytes memory uninstall = abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, hook, ""));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, uninstall);
        require(!account.isModuleInstalled(ModuleType.HOOK, hook), "hook not uninstalled");
    }

    function _entry(string memory phase, bytes32 label) internal pure returns (bytes32) {
        return keccak256(abi.encode(phase, label));
    }

    function _assertTape(bytes32[6] memory expected) internal view {
        for (uint256 i; i < expected.length; ++i) {
            require(recorder.calls(i) == expected[i], "hook callback order changed");
        }
    }

    function _assertTape4(bytes32[4] memory expected) internal view {
        for (uint256 i; i < expected.length; ++i) {
            require(recorder.calls(i) == expected[i], "hook callback order changed");
        }
    }
}
