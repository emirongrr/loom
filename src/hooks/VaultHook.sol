// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomHook} from "../interfaces/ILoomHook.sol";
import {EIP712Lib} from "../libraries/EIP712Lib.sol";
import {ERC20CallLib} from "../libraries/ERC20CallLib.sol";
import {ExecutionLib} from "../libraries/ExecutionLib.sol";
import {GuardianVerificationLib} from "../libraries/GuardianVerificationLib.sol";
import {ModuleType} from "../libraries/ModuleType.sol";

contract VaultHook is ILoomHook {
    error OnlyAccount();
    error ConfigTimelockRequired();
    error InvalidPolicy();
    error InvalidWithdrawal();
    error WithdrawalAlreadyPending();
    error WithdrawalNotPending();
    error WithdrawalNotReady();
    error WithdrawalExpired();
    error LimitExceeded();

    uint48 public constant MIN_VAULT_DELAY = 1 hours;

    struct VaultPolicy {
        uint128 dailyLimit;
        uint48 period;
        uint48 delay;
        bool enabled;
    }

    struct Spend {
        uint128 amount;
        uint48 periodStart;
    }

    struct PendingWithdrawal {
        uint48 readyAt;
        uint48 expiresAt;
        uint64 configVersion;
    }

    uint48 public constant MAX_WITHDRAWAL_WINDOW = 30 days;
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = EIP712Lib.DOMAIN_TYPEHASH;
    bytes32 public constant CANCEL_WITHDRAWAL_TYPEHASH =
        keccak256("CancelVaultWithdrawal(address account,bytes32 withdrawalId,uint64 configVersion)");

    bytes4 private constant EXECUTE = bytes4(keccak256("execute(bytes32,bytes)"));
    bytes4 private constant EXECUTE_SCHEDULED = bytes4(keccak256("executeScheduled(address,uint256,bytes)"));
    bytes32 private constant NAME_HASH = keccak256("LoomVaultHook");
    bytes32 private constant VERSION_HASH = keccak256("1");

    mapping(address account => mapping(address asset => VaultPolicy)) public policies;
    mapping(address account => mapping(address asset => Spend)) public spending;
    mapping(address account => mapping(bytes32 withdrawalId => PendingWithdrawal)) public pendingWithdrawals;

    event VaultPolicySet(address indexed account, address indexed asset, VaultPolicy policy);
    event VaultPolicyRemoved(address indexed account, address indexed asset);
    event VaultWithdrawalScheduled(
        address indexed account, bytes32 indexed withdrawalId, address indexed asset, uint48 readyAt, uint48 expiresAt
    );
    event VaultWithdrawalCancelled(address indexed account, bytes32 indexed withdrawalId);
    event VaultWithdrawalExecuted(address indexed account, bytes32 indexed withdrawalId);

    function setVaultPolicy(address asset, VaultPolicy calldata policy) external {
        // The account's notifyConfigChange also reverts outside a scheduled
        // self-call, but that is a side effect of a different contract's
        // gate, not a guarantee this contract makes on its own. Assert it
        // directly so the delay requirement does not depend on call order.
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        if (policy.period == 0 || policy.delay < MIN_VAULT_DELAY) revert InvalidPolicy();
        policies[msg.sender][asset] = policy;
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("VAULT_POLICY_SET", asset, policy)));
        emit VaultPolicySet(msg.sender, asset, policy);
    }

    function removeVaultPolicy(address asset) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        delete policies[msg.sender][asset];
        delete spending[msg.sender][asset];
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("VAULT_POLICY_REMOVE", asset)));
        emit VaultPolicyRemoved(msg.sender, asset);
    }

    function scheduleVaultWithdrawal(address target, uint256 value, bytes calldata callData, uint48 executionWindow)
        external
        returns (bytes32 withdrawalId)
    {
        if (executionWindow == 0 || executionWindow > MAX_WITHDRAWAL_WINDOW) revert InvalidWithdrawal();
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(target, value, callData);
        (bool protectedAsset, address asset,) = _protectedSpend(msg.sender, execution);
        if (!protectedAsset) revert InvalidWithdrawal();

        withdrawalId =
            withdrawalIdFor(msg.sender, target, value, keccak256(callData), ILoomAccount(msg.sender).configVersion());
        if (pendingWithdrawals[msg.sender][withdrawalId].readyAt != 0) revert WithdrawalAlreadyPending();

        VaultPolicy memory policy = policies[msg.sender][asset];
        // Timestamp drift is negligible relative to vault withdrawal delays.
        // forge-lint: disable-next-line(block-timestamp)
        uint48 readyAt = uint48(block.timestamp) + policy.delay;
        uint48 expiresAt = readyAt + executionWindow;
        pendingWithdrawals[msg.sender][withdrawalId] = PendingWithdrawal({
            readyAt: readyAt, expiresAt: expiresAt, configVersion: ILoomAccount(msg.sender).configVersion()
        });
        emit VaultWithdrawalScheduled(msg.sender, withdrawalId, asset, readyAt, expiresAt);
    }

    function cancelVaultWithdrawal(bytes32 withdrawalId) external {
        _cancel(msg.sender, withdrawalId);
    }

    function cancelVaultWithdrawalWithGuardians(
        address account,
        bytes32 withdrawalId,
        GuardianVerificationLib.Approval[] calldata guardianApprovals
    ) external {
        PendingWithdrawal memory pending = pendingWithdrawals[account][withdrawalId];
        if (pending.readyAt == 0) revert WithdrawalNotPending();
        bytes32 digest = cancelWithdrawalDigest(account, withdrawalId, pending.configVersion);
        ILoomAccount loom = ILoomAccount(account);
        if (!GuardianVerificationLib.approved(loom.guardianRoot(), loom.guardianThreshold(), digest, guardianApprovals))
        {
            revert InvalidWithdrawal();
        }
        _cancel(account, withdrawalId);
    }

    function cancelWithdrawalDigest(address account, bytes32 withdrawalId, uint64 configVersion)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_WITHDRAWAL_TYPEHASH, account, withdrawalId, configVersion));
        return EIP712Lib.digest(_domainSeparator(), structHash);
    }

    function withdrawalIdFor(address account, address target, uint256 value, bytes32 callDataHash, uint64 configVersion)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(account, target, value, callDataHash, configVersion));
    }

    function preCheck(address account, address, bytes calldata accountCall) external returns (bytes memory) {
        if (msg.sender != account) revert OnlyAccount();
        if (accountCall.length < 4) return "";
        bytes4 selector = bytes4(accountCall[:4]);
        if (selector == EXECUTE_SCHEDULED) {
            (address target, uint256 value, bytes memory data) = abi.decode(accountCall[4:], (address, uint256, bytes));
            _checkExecution(account, ExecutionLib.Execution(target, value, data));
            return "";
        }
        if (selector != EXECUTE) return "";
        (bytes32 mode, bytes memory executionCalldata) = abi.decode(accountCall[4:], (bytes32, bytes));
        if (mode != ExecutionLib.SINGLE_EXECUTION_MODE && mode != ExecutionLib.BATCH_EXECUTION_MODE) return "";
        (bytes1 callType,) = ExecutionLib.mode(mode);
        if (callType == ExecutionLib.CALLTYPE_SINGLE) {
            _checkExecution(account, abi.decode(executionCalldata, (ExecutionLib.Execution)));
        } else if (callType == ExecutionLib.CALLTYPE_BATCH) {
            ExecutionLib.Execution[] memory executions = abi.decode(executionCalldata, (ExecutionLib.Execution[]));
            for (uint256 i; i < executions.length; ++i) {
                _checkExecution(account, executions[i]);
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

    function _checkExecution(address account, ExecutionLib.Execution memory execution) internal {
        (bool protectedAsset, address asset, uint256 amount) = _protectedSpend(account, execution);
        if (!protectedAsset) return;

        VaultPolicy memory policy = policies[account][asset];
        if (amount <= policy.dailyLimit) {
            _consumeDailyLimit(account, asset, amount, policy);
            return;
        }

        bytes32 withdrawalId = withdrawalIdFor(
            account,
            execution.target,
            execution.value,
            keccak256(execution.callData),
            ILoomAccount(account).configVersion()
        );
        PendingWithdrawal memory pending = pendingWithdrawals[account][withdrawalId];
        if (pending.readyAt == 0) revert WithdrawalNotPending();
        if (pending.configVersion != ILoomAccount(account).configVersion()) revert InvalidWithdrawal();
        // Timestamp drift is negligible relative to vault withdrawal delays.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pending.readyAt) revert WithdrawalNotReady();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > pending.expiresAt) revert WithdrawalExpired();
        delete pendingWithdrawals[account][withdrawalId];
        emit VaultWithdrawalExecuted(account, withdrawalId);
    }

    function _consumeDailyLimit(address account, address asset, uint256 amount, VaultPolicy memory policy) internal {
        Spend storage used = spending[account][asset];
        // Timestamp drift is negligible relative to configured spending periods.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= uint256(used.periodStart) + policy.period) {
            // forge-lint: disable-next-line(unsafe-typecast)
            used.periodStart = uint48(block.timestamp);
            used.amount = 0;
        }
        uint256 next = uint256(used.amount) + amount;
        if (next > policy.dailyLimit) revert LimitExceeded();
        // Safe because next was checked against dailyLimit, which is uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        used.amount = uint128(next);
    }

    function _protectedSpend(address account, ExecutionLib.Execution memory execution)
        internal
        view
        returns (bool protectedAsset, address asset, uint256 amount)
    {
        if (execution.value != 0) {
            asset = address(0);
            amount = execution.value;
            return (policies[account][asset].enabled, asset, amount);
        }

        bytes4 selector = ERC20CallLib.selector(execution.callData);
        if (!ERC20CallLib.isTokenSelector(selector)) return (false, address(0), 0);
        (bool parsed, address from,, uint256 tokenAmount) = ERC20CallLib.decodeTokenCall(execution.callData);
        if (!parsed) {
            // Malformed token calldata meters as an unbounded spend so it can
            // never slip under the daily limit.
            return (policies[account][execution.target].enabled, execution.target, type(uint256).max);
        }
        // Only transferFrom pulls from a `from` address; the vault meters it
        // solely when the account's own balance is the source.
        if (selector == ERC20CallLib.TRANSFER_FROM && from != account) return (false, address(0), 0);
        return (policies[account][execution.target].enabled, execution.target, tokenAmount);
    }

    function _cancel(address account, bytes32 withdrawalId) internal {
        if (pendingWithdrawals[account][withdrawalId].readyAt == 0) revert WithdrawalNotPending();
        delete pendingWithdrawals[account][withdrawalId];
        emit VaultWithdrawalCancelled(account, withdrawalId);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return EIP712Lib.domainSeparator(NAME_HASH, VERSION_HASH);
    }
}
