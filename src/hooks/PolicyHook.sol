// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../interfaces/ILoomHook.sol";
import {IPolicyHook} from "../interfaces/IPolicyHook.sol";
import {ERC20CallLib} from "../libraries/ERC20CallLib.sol";
import {ExecutionLib} from "../libraries/ExecutionLib.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";

interface ILoomExecutionSelectors {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
    function executeScheduled(address target, uint256 value, bytes calldata data) external;
    function scheduleCall(address target, uint256 value, bytes calldata data, uint48 delay) external returns (bytes32);
    function cancelScheduled(bytes32 operationId) external;
    function cancelMigration() external;
    function revokeTokenAllowance(address token, address spender) external;
}

contract PolicyHook is ILoomHook, IPolicyHook {
    error OnlyAccount();
    error InvalidPeriod();
    error LimitExceeded();
    error CounterpartyNotAllowed();
    error ConfigTimelockRequired();

    struct Policy {
        uint128 maxPerCall;
        uint128 maxPerPeriod;
        uint48 period;
        address allowedCounterparty;
        bool enabled;
    }

    struct Spend {
        uint128 amount;
        uint48 periodStart;
    }

    mapping(address account => mapping(bytes32 policyId => Policy)) public policies;
    mapping(address account => mapping(bytes32 policyId => Spend)) public spending;

    event PolicySet(address indexed account, bytes32 indexed policyId, Policy policy);
    event PolicyRemoved(address indexed account, bytes32 indexed policyId);

    bytes4 private constant REVOKE_PERMISSION = bytes4(keccak256("revokePermission(bytes32)"));
    bytes4 private constant CANCEL_RECOVERY = bytes4(keccak256("cancelRecovery(address)"));

    function setPolicy(address target, bytes4 selector, Policy calldata policy) external {
        // Assert the timelock directly rather than relying on notifyConfigChange's
        // gate, so the delay requirement does not depend on call order.
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        if (policy.period == 0) revert InvalidPeriod();
        bytes32 id = policyId(target, selector);
        policies[msg.sender][id] = policy;
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("POLICY_SET", id, policy)));
        emit PolicySet(msg.sender, id, policy);
    }

    function removePolicy(address target, bytes4 selector) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        bytes32 id = policyId(target, selector);
        delete policies[msg.sender][id];
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("POLICY_REMOVE", id)));
        emit PolicyRemoved(msg.sender, id);
    }

    function policyId(address target, bytes4 selector) public pure returns (bytes32) {
        return keccak256(abi.encode(target, selector));
    }

    function isLowRisk(address account, bytes calldata accountCall) external view returns (bool) {
        if (accountCall.length < 4 || bytes4(accountCall[:4]) != ILoomExecutionSelectors.execute.selector) {
            return false;
        }
        (bytes32 mode, bytes memory executionCalldata) = abi.decode(accountCall[4:], (bytes32, bytes));
        if (mode != ExecutionLib.SINGLE_EXECUTION_MODE && mode != ExecutionLib.BATCH_EXECUTION_MODE) return false;
        (bytes1 callType,) = ExecutionLib.mode(mode);

        if (callType == ExecutionLib.CALLTYPE_SINGLE) {
            ExecutionLib.Execution memory item = abi.decode(executionCalldata, (ExecutionLib.Execution));
            return _isLowRiskExecution(account, item);
        }
        if (callType == ExecutionLib.CALLTYPE_BATCH) {
            ExecutionLib.Execution[] memory items = abi.decode(executionCalldata, (ExecutionLib.Execution[]));
            if (items.length == 0) return false;
            for (uint256 i; i < items.length; ++i) {
                if (!_isLowRiskExecution(account, items[i])) return false;
            }
            return true;
        }
        return false;
    }

    function preCheck(address account, address, bytes calldata accountCall) external returns (bytes memory hookData) {
        if (msg.sender != account) revert OnlyAccount();
        if (accountCall.length < 4) return "";
        bytes4 accountSelector = bytes4(accountCall[:4]);
        if (accountSelector == ILoomExecutionSelectors.executeScheduled.selector) {
            (address target, uint256 value, bytes memory data) = abi.decode(accountCall[4:], (address, uint256, bytes));
            _consumeIfPolicy(account, ExecutionLib.Execution(target, value, data));
            return "";
        }
        if (accountSelector != ILoomExecutionSelectors.execute.selector) return "";
        (bytes32 mode, bytes memory executionCalldata) = abi.decode(accountCall[4:], (bytes32, bytes));
        // Skips policy enforcement rather than reverting on an unrecognized mode. This is safe only
        // because LoomAccount.execute() already rejects unsupported modes before this hook runs; a
        // standalone ERC-7579 account that calls this hook without that upstream check would not get
        // spend-limit enforcement here.
        if (mode != ExecutionLib.SINGLE_EXECUTION_MODE && mode != ExecutionLib.BATCH_EXECUTION_MODE) return "";
        (bytes1 callType,) = ExecutionLib.mode(mode);
        if (callType == ExecutionLib.CALLTYPE_SINGLE) {
            _consumeIfPolicy(account, abi.decode(executionCalldata, (ExecutionLib.Execution)));
        } else if (callType == ExecutionLib.CALLTYPE_BATCH) {
            ExecutionLib.Execution[] memory items = abi.decode(executionCalldata, (ExecutionLib.Execution[]));
            for (uint256 i; i < items.length; ++i) {
                _consumeIfPolicy(account, items[i]);
            }
        }
        return "";
    }

    function postCheck(address account, bytes calldata) external view {
        if (msg.sender != account) revert OnlyAccount();
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }

    function _isLowRiskExecution(address account, ExecutionLib.Execution memory item) internal view returns (bool) {
        bytes4 selector = ERC20CallLib.selector(item.callData);
        if (
            item.target == account
                && (selector == ILoomExecutionSelectors.scheduleCall.selector
                    || selector == ILoomExecutionSelectors.cancelScheduled.selector
                    || selector == ILoomExecutionSelectors.cancelMigration.selector
                    || selector == ILoomExecutionSelectors.revokeTokenAllowance.selector)
        ) return true;
        if (selector == REVOKE_PERMISSION && ILoomAccount(account).isModuleInstalled(ModuleType.VALIDATOR, item.target))
        {
            return true;
        }
        if (
            selector == CANCEL_RECOVERY && item.value == 0 && item.callData.length == 36
                && ILoomAccount(account).isModuleInstalled(ModuleType.RECOVERY, item.target)
                && _addressArgument(item.callData) == account
        ) return true;

        Policy memory policy = policies[account][policyId(item.target, selector)];
        uint256 amount = _spendAmount(item);
        if (!policy.enabled || amount > policy.maxPerCall || !_isCounterpartyAllowed(policy, item)) return false;
        Spend memory used = spending[account][policyId(item.target, selector)];
        // Timestamp drift is negligible relative to configured spending periods.
        // forge-lint: disable-next-line(block-timestamp)
        uint256 current = block.timestamp >= uint256(used.periodStart) + policy.period ? 0 : used.amount;
        return current + amount <= policy.maxPerPeriod;
    }

    function _consumeIfPolicy(address account, ExecutionLib.Execution memory item) internal {
        bytes4 selector = ERC20CallLib.selector(item.callData);
        bytes32 id = policyId(item.target, selector);
        Policy memory policy = policies[account][id];
        if (!policy.enabled) return;
        if (!_isCounterpartyAllowed(policy, item)) revert CounterpartyNotAllowed();
        uint256 amount = _spendAmount(item);
        if (amount > policy.maxPerCall) revert LimitExceeded();

        Spend storage used = spending[account][id];
        // Timestamp drift is negligible relative to configured spending periods.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= uint256(used.periodStart) + policy.period) {
            // forge-lint: disable-next-line(unsafe-typecast)
            used.periodStart = uint48(block.timestamp);
            used.amount = 0;
        }
        uint256 next = uint256(used.amount) + amount;
        if (next > policy.maxPerPeriod) revert LimitExceeded();
        // Safe because next was checked against maxPerPeriod, which is uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        used.amount = uint128(next);
    }

    function _spendAmount(ExecutionLib.Execution memory item) internal pure returns (uint256) {
        if (!ERC20CallLib.isTokenSelector(ERC20CallLib.selector(item.callData))) return item.value;
        (bool parsed,,, uint256 amount) = ERC20CallLib.decodeTokenCall(item.callData);
        // Malformed token calldata meters as an unbounded spend so it can never
        // slip under a per-call or per-period limit.
        return parsed ? amount : type(uint256).max;
    }

    function _isCounterpartyAllowed(Policy memory policy, ExecutionLib.Execution memory item)
        internal
        pure
        returns (bool)
    {
        if (policy.allowedCounterparty == address(0)) return true;
        (bool parsed, address counterparty) = _counterparty(item.callData);
        return parsed && counterparty == policy.allowedCounterparty;
    }

    /// @dev The policy counterparty is the recipient or spender: `to` for
    /// transfer, the spender for approve, and the recipient for transferFrom.
    function _counterparty(bytes memory callData) internal pure returns (bool parsed, address counterparty) {
        (bool decoded,, address to,) = ERC20CallLib.decodeTokenCall(callData);
        return (decoded, to);
    }

    function _addressArgument(bytes memory callData) internal pure returns (address value) {
        assembly {
            value := mload(add(callData, 36))
        }
    }
}
