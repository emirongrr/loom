// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmNonstandardToken {
    function warp(uint256 timestamp) external;
}

contract NoReturnToken {
    mapping(address account => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

contract FeeOnTransferToken {
    mapping(address account => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - amount / 10;
        return true;
    }
}

contract NonstandardTokenBehaviorTest {
    VmNonstandardToken internal constant vm =
        VmNonstandardToken(address(uint160(uint256(keccak256("hevm cheat code")))));

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

    function testNoReturnTokenTransferExecutesAndConsumesPolicyBudget() public {
        NoReturnToken token = new NoReturnToken();
        token.mint(address(account), 100);
        _setPolicy(address(token), NoReturnToken.transfer.selector, 100);

        _transfer(address(token), abi.encodeCall(NoReturnToken.transfer, (RECIPIENT, 40)));

        require(token.balanceOf(RECIPIENT) == 40, "no-return token transfer failed");
        require(_spent(address(token), NoReturnToken.transfer.selector) == 40, "no-return spend not accounted");
    }

    function testFeeOnTransferMetersRequestedAmountAndRejectsBudgetBypass() public {
        FeeOnTransferToken token = new FeeOnTransferToken();
        token.mint(address(account), 200);
        _setPolicy(address(token), FeeOnTransferToken.transfer.selector, 100);

        _transfer(address(token), abi.encodeCall(FeeOnTransferToken.transfer, (RECIPIENT, 100)));
        require(token.balanceOf(RECIPIENT) == 90, "fee-on-transfer net amount mismatch");
        require(_spent(address(token), FeeOnTransferToken.transfer.selector) == 100, "requested amount not accounted");

        bytes memory secondTransfer = abi.encodeCall(FeeOnTransferToken.transfer, (RECIPIENT, 1));
        (bool accepted,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 0, secondTransfer)))
                )
            );
        require(!accepted, "net-received amount bypassed policy budget");
        require(token.balanceOf(RECIPIENT) == 90, "rejected fee transfer changed recipient balance");
        require(_spent(address(token), FeeOnTransferToken.transfer.selector) == 100, "rejected transfer changed spend");
    }

    function _setPolicy(address token, bytes4 selector, uint128 limit) internal {
        PolicyHook.Policy memory policy = PolicyHook.Policy(limit, limit, 1 days, RECIPIENT, true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (token, selector, policy));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(hook), 0, setPolicy, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(hook), 0, setPolicy);
    }

    function _transfer(address token, bytes memory data) internal {
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(token, 0, data)));
    }

    function _spent(address token, bytes4 selector) internal view returns (uint128 amount) {
        (amount,) = hook.spending(address(account), hook.policyId(token, selector));
    }
}
