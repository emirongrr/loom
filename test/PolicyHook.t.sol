// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PolicyHook} from "../src/hooks/PolicyHook.sol";

// Acts as the calling account: PolicyHook reads isExecutingScheduled() on
// msg.sender, so this test contract toggles the scheduled state and calls the
// hook directly.
contract PolicyHookConfigGateTest {
    PolicyHook internal hook = new PolicyHook();
    bool internal executing;

    function isExecutingScheduled() external view returns (bool) {
        return executing;
    }

    function notifyConfigChange(bytes32) external {}

    function _policy(uint48 period) internal pure returns (PolicyHook.Policy memory) {
        return PolicyHook.Policy({
            maxPerCall: 1, maxPerPeriod: 1, period: period, allowedCounterparty: address(0), enabled: true
        });
    }

    function testSetAndRemovePolicyRequireScheduledExecution() public {
        address target = address(0xBEEF);
        bytes4 selector = bytes4(0x12345678);
        PolicyHook.Policy memory policy = _policy(1);

        // Outside a scheduled self-call the timelock gate rejects both setters.
        executing = false;
        (bool setOk,) = address(hook).call(abi.encodeCall(PolicyHook.setPolicy, (target, selector, policy)));
        require(!setOk, "setPolicy without timelock should revert");
        (bool removeOk,) = address(hook).call(abi.encodeCall(PolicyHook.removePolicy, (target, selector)));
        require(!removeOk, "removePolicy without timelock should revert");

        // Under scheduled execution both succeed.
        executing = true;
        hook.setPolicy(target, selector, policy);
        (,,,, bool enabled) = hook.policies(address(this), hook.policyId(target, selector));
        require(enabled, "policy not set under scheduled execution");
        hook.removePolicy(target, selector);
        (,,,, bool stillEnabled) = hook.policies(address(this), hook.policyId(target, selector));
        require(!stillEnabled, "policy not removed under scheduled execution");
    }

    function testSetPolicyRejectsZeroPeriod() public {
        executing = true;
        (bool ok,) =
            address(hook).call(abi.encodeCall(PolicyHook.setPolicy, (address(0xBEEF), bytes4(0x12345678), _policy(0))));
        require(!ok, "zero-period policy should revert");
    }

    function testPreCheckOnlyAccount() public {
        // preCheck must be called by the account it is checking.
        (bool ok,) = address(hook).call(abi.encodeCall(PolicyHook.preCheck, (address(0xABCD), address(this), "")));
        require(!ok, "preCheck from a non-account caller should revert");
    }

    function testPreCheckIgnoresUnrelatedSelector() public {
        // A call whose selector is neither execute nor executeScheduled is a no-op.
        bytes memory result = hook.preCheck(address(this), address(this), hex"aabbccdd");
        require(result.length == 0, "unrelated selector should produce no hook data");
    }

    function testIsLowRiskRejectsShortCalldata() public view {
        require(!hook.isLowRisk(address(this), hex"00"), "short calldata is not low risk");
    }
}
