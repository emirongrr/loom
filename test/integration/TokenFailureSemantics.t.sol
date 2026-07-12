// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmTokenFailure {
    function warp(uint256 timestamp) external;
}

contract FalseReturnToken {
    mapping(address account => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

contract RevertingTransferToken {
    error TransferRejected();

    function transfer(address, uint256) external pure returns (bool) {
        revert TransferRejected();
    }
}

contract TokenFailureSemanticsTest {
    VmTokenFailure internal constant vm = VmTokenFailure(address(uint160(uint256(keccak256("hevm cheat code")))));

    PolicyHook internal hook;
    LoomAccount internal account;
    address internal constant RECIPIENT = address(0xBEEF);

    function setUp() public {
        hook = new PolicyHook();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function testFalseReturnConsumesBudgetWithoutReportingTokenSuccess() public {
        FalseReturnToken token = new FalseReturnToken();
        token.mint(address(account), 100);
        _setPolicy(address(token), FalseReturnToken.transfer.selector);

        _execute(address(token), abi.encodeCall(FalseReturnToken.transfer, (RECIPIENT, 40)));

        require(token.balanceOf(address(account)) == 100, "false-return token moved account funds");
        require(token.balanceOf(RECIPIENT) == 0, "false-return token credited recipient");
        require(_spent(address(token), FalseReturnToken.transfer.selector) == 40, "false return bypassed accounting");
    }

    function testRevertingTransferBubblesErrorAndRollsBackBudget() public {
        RevertingTransferToken token = new RevertingTransferToken();
        _setPolicy(address(token), RevertingTransferToken.transfer.selector);

        bytes memory transfer = abi.encodeCall(RevertingTransferToken.transfer, (RECIPIENT, 40));
        (bool accepted, bytes memory reason) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 0, transfer)))
                )
            );

        require(!accepted, "reverting token transfer reported success");
        require(reason.length >= 4, "reverting token returned malformed error");
        // Safe after checking that the revert data contains a complete selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(reason);
        require(selector == RevertingTransferToken.TransferRejected.selector, "token error was not bubbled");
        require(_spent(address(token), RevertingTransferToken.transfer.selector) == 0, "revert consumed policy budget");
    }

    function _setPolicy(address token, bytes4 selector) internal {
        PolicyHook.Policy memory policy = PolicyHook.Policy(100, 100, 1 days, RECIPIENT, true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (token, selector, policy));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(hook), 0, setPolicy, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(hook), 0, setPolicy);
    }

    function _execute(address token, bytes memory data) internal {
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(token, 0, data)));
    }

    function _spent(address token, bytes4 selector) internal view returns (uint128 amount) {
        (amount,) = hook.spending(address(account), hook.policyId(token, selector));
    }
}
