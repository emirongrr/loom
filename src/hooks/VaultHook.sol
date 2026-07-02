// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {IGuardianVerifier} from "../interfaces/IGuardianVerifier.sol";
import {ILoomHook} from "../interfaces/ILoomHook.sol";
import {ExecutionLib} from "../libraries/ExecutionLib.sol";
import {MerkleProof} from "../libraries/MerkleProof.sol";
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

    struct GuardianApproval {
        address verifier;
        bytes32 keyCommitment;
        bytes32 salt;
        bytes signature;
        bytes32[] proof;
    }

    uint48 public constant MAX_WITHDRAWAL_WINDOW = 30 days;
    uint256 public constant MAX_GUARDIAN_THRESHOLD = 32;
    uint256 public constant MAX_GUARDIAN_PROOF_LENGTH = 32;
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CANCEL_WITHDRAWAL_TYPEHASH =
        keccak256("CancelVaultWithdrawal(address account,bytes32 withdrawalId,uint64 configVersion)");

    bytes4 private constant EXECUTE = bytes4(keccak256("execute(bytes32,bytes)"));
    bytes4 private constant EXECUTE_SCHEDULED = bytes4(keccak256("executeScheduled(address,uint256,bytes)"));
    bytes4 private constant ERC20_TRANSFER = 0xa9059cbb;
    bytes4 private constant ERC20_TRANSFER_FROM = 0x23b872dd;
    bytes4 private constant ERC20_APPROVE = 0x095ea7b3;
    bytes32 private constant SINGLE_EXECUTION_MODE = bytes32(0);
    bytes32 private constant BATCH_EXECUTION_MODE = bytes32(uint256(1) << 248);
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
        GuardianApproval[] calldata guardianApprovals
    ) external {
        PendingWithdrawal memory pending = pendingWithdrawals[account][withdrawalId];
        if (pending.readyAt == 0) revert WithdrawalNotPending();
        bytes32 digest = cancelWithdrawalDigest(account, withdrawalId, pending.configVersion);
        if (!_guardianApproved(account, digest, guardianApprovals)) revert InvalidWithdrawal();
        _cancel(account, withdrawalId);
    }

    function cancelWithdrawalDigest(address account, bytes32 withdrawalId, uint64 configVersion)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_WITHDRAWAL_TYPEHASH, account, withdrawalId, configVersion));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
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
        if (mode != SINGLE_EXECUTION_MODE && mode != BATCH_EXECUTION_MODE) return "";
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

        bytes4 selector = _selector(execution.callData);
        if (selector == ERC20_TRANSFER || selector == ERC20_APPROVE) {
            if (execution.callData.length != 68) {
                return (policies[account][execution.target].enabled, execution.target, type(uint256).max);
            }
            amount = _uintArgument(execution.callData, 68);
            asset = execution.target;
            return (policies[account][asset].enabled, asset, amount);
        }
        if (selector == ERC20_TRANSFER_FROM) {
            if (execution.callData.length != 100) {
                return (policies[account][execution.target].enabled, execution.target, type(uint256).max);
            }
            address from = _addressArgument(execution.callData, 36);
            if (from != account) return (false, address(0), 0);
            amount = _uintArgument(execution.callData, 100);
            asset = execution.target;
            return (policies[account][asset].enabled, asset, amount);
        }
        return (false, address(0), 0);
    }

    function _cancel(address account, bytes32 withdrawalId) internal {
        if (pendingWithdrawals[account][withdrawalId].readyAt == 0) revert WithdrawalNotPending();
        delete pendingWithdrawals[account][withdrawalId];
        emit VaultWithdrawalCancelled(account, withdrawalId);
    }

    function _guardianApproved(address account, bytes32 digest, GuardianApproval[] calldata approvals)
        internal
        view
        returns (bool)
    {
        ILoomAccount loom = ILoomAccount(account);
        uint256 threshold = loom.guardianThreshold();
        if (threshold == 0 || approvals.length < threshold || approvals.length > MAX_GUARDIAN_THRESHOLD) return false;

        bytes32 root = loom.guardianRoot();
        bytes32 previous = bytes32(0);
        for (uint256 i; i < approvals.length; ++i) {
            GuardianApproval calldata item = approvals[i];
            if (item.verifier.code.length == 0 || item.keyCommitment == bytes32(0)) return false;
            // Use the account's guardianLeaf so this cancel path and the account's own
            // freeze/recovery share one leaf definition and cannot drift.
            bytes32 leaf = loom.guardianLeaf(item.verifier, item.keyCommitment, item.salt);
            if (leaf <= previous || item.proof.length > MAX_GUARDIAN_PROOF_LENGTH) return false;
            previous = leaf;
            if (!MerkleProof.verify(item.proof, root, leaf)) return false;
            try IGuardianVerifier(item.verifier).verify(item.keyCommitment, digest, item.signature) returns (
                bool valid
            ) {
                if (!valid) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _selector(bytes memory data) internal pure returns (bytes4 selector) {
        if (data.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(data, 32))
        }
    }

    function _addressArgument(bytes memory callData, uint256 offset) internal pure returns (address value) {
        assembly {
            value := mload(add(callData, offset))
        }
    }

    function _uintArgument(bytes memory callData, uint256 offset) internal pure returns (uint256 value) {
        assembly {
            value := mload(add(callData, offset))
        }
    }
}
