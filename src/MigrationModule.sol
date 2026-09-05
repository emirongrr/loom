// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ILoomAccount} from "./interfaces/ILoomAccount.sol";
import {ILoomModule} from "./interfaces/ILoomModule.sol";
import {ExecutionLib} from "./libraries/ExecutionLib.sol";
import {GuardianVerificationLib} from "./libraries/GuardianVerificationLib.sol";
import {ModuleType} from "./libraries/ModuleType.sol";

/// @notice Account-scoped, delayed migration state and validation.
/// @dev The module is stateless with respect to protocol administration: each
/// account owns its own pending migration and remains the only authority able
/// to schedule or self-cancel it. Execution is permissionless after the delay.
contract MigrationModule is ILoomModule {
    error MigrationAlreadyPending();
    error MigrationNotPending();
    error InvalidMigration();
    error OperationNotReady();

    struct PendingMigration {
        address destination;
        bytes32 destinationCodeHash;
        bytes32 destinationConfigHash;
        bytes32 callsHash;
        uint48 readyAt;
        uint48 expiresAt;
        uint64 configVersion;
        uint64 nonce;
    }

    uint48 public constant MIN_MIGRATION_DELAY = 3 days;
    uint48 public constant MAX_MIGRATION_WINDOW = 30 days;
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CANCEL_MIGRATION_TYPEHASH =
        keccak256("CancelMigration(bytes32 migrationId,uint64 configVersion,uint64 nonce)");
    bytes32 private constant NAME_HASH = keccak256("LoomAccount");
    bytes32 private constant VERSION_HASH = keccak256("1");

    mapping(address account => PendingMigration) public pendingMigrations;
    mapping(address account => uint64 nonce) public migrationNonces;

    event MigrationScheduled(
        address indexed account,
        bytes32 indexed migrationId,
        address indexed destination,
        bytes32 destinationCodeHash,
        bytes32 destinationConfigHash,
        bytes32 callsHash,
        uint48 readyAt,
        uint48 expiresAt
    );
    event MigrationCancelled(address indexed account, bytes32 indexed migrationId);
    event MigrationExecuted(address indexed account, bytes32 indexed migrationId, address indexed destination);

    function scheduleMigration(
        address destination,
        bytes32 destinationCodeHash,
        bytes32 destinationConfigHash,
        bytes32 callsHash,
        uint48 delay,
        uint48 executionWindow
    ) external returns (bytes32 migrationId) {
        address account = msg.sender;
        _requireInstalledAccount(account);
        if (pendingMigrations[account].readyAt != 0) revert MigrationAlreadyPending();
        if (
            destination == address(0) || destination == account || destinationCodeHash == bytes32(0)
                || destination.code.length == 0 || destination.codehash != destinationCodeHash
                || callsHash == bytes32(0) || delay < MIN_MIGRATION_DELAY || executionWindow == 0
                || executionWindow > MAX_MIGRATION_WINDOW
        ) revert InvalidMigration();
        if (destinationConfigHash != bytes32(0) && ILoomAccount(destination).configHash() != destinationConfigHash) {
            revert InvalidMigration();
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 readyAt = uint48(block.timestamp) + delay;
        uint48 expiresAt = readyAt + executionWindow;
        PendingMigration memory migration = PendingMigration({
            destination: destination,
            destinationCodeHash: destinationCodeHash,
            destinationConfigHash: destinationConfigHash,
            callsHash: callsHash,
            readyAt: readyAt,
            expiresAt: expiresAt,
            configVersion: ILoomAccount(account).configVersion(),
            nonce: migrationNonces[account]
        });
        pendingMigrations[account] = migration;
        migrationId = migrationIdFor(account, migration);
        emit MigrationScheduled(
            account, migrationId, destination, destinationCodeHash, destinationConfigHash, callsHash, readyAt, expiresAt
        );
    }

    function cancelMigration() external {
        address account = msg.sender;
        _requireInstalledAccount(account);
        PendingMigration memory migration = pendingMigrations[account];
        if (migration.readyAt == 0) revert MigrationNotPending();
        _cancel(account, migration);
    }

    function cancelMigrationWithGuardians(
        address account,
        GuardianVerificationLib.Approval[] calldata guardianApprovals
    ) external {
        _requireInstalledAccount(account);
        PendingMigration memory migration = pendingMigrations[account];
        if (migration.readyAt == 0) revert MigrationNotPending();
        bytes32 migrationId = migrationIdFor(account, migration);
        bytes32 digest = migrationCancelDigest(account, migrationId, migration.configVersion, migration.nonce);
        ILoomAccount loom = ILoomAccount(account);
        if (!GuardianVerificationLib.approved(loom.guardianRoot(), loom.guardianThreshold(), digest, guardianApprovals))
        {
            revert InvalidMigration();
        }
        _cancel(account, migration);
    }

    /// @notice Consumes a ready migration before the account executes its committed batch.
    /// @dev Only the account can consume its record and the module never calls
    /// back into account execution. The account treats successful consumption as
    /// typed authorization, so the installed module remains security-critical.
    function consumeMigration(address account, ExecutionLib.Execution[] calldata calls)
        external
        returns (bytes32 migrationId, address destination)
    {
        if (msg.sender != account) revert InvalidMigration();
        _requireInstalledAccount(account);
        PendingMigration memory migration = pendingMigrations[account];
        if (migration.readyAt == 0 || calls.length == 0 || keccak256(abi.encode(calls)) != migration.callsHash) {
            revert InvalidMigration();
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < migration.readyAt) revert OperationNotReady();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > migration.expiresAt || ILoomAccount(account).configVersion() != migration.configVersion) {
            revert InvalidMigration();
        }
        if (migration.destination.codehash != migration.destinationCodeHash) revert InvalidMigration();
        if (
            migration.destinationConfigHash != bytes32(0)
                && ILoomAccount(migration.destination).configHash() != migration.destinationConfigHash
        ) revert InvalidMigration();

        migrationId = migrationIdFor(account, migration);
        destination = migration.destination;
        delete pendingMigrations[account];
        migrationNonces[account] = migration.nonce + 1;
        emit MigrationExecuted(account, migrationId, migration.destination);
    }

    function migrationIdFor(address account, PendingMigration memory migration) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                account,
                migration.destination,
                migration.destinationCodeHash,
                migration.destinationConfigHash,
                migration.callsHash,
                migration.readyAt,
                migration.expiresAt,
                migration.configVersion,
                migration.nonce,
                block.chainid
            )
        );
    }

    function migrationCancelDigest(address account, bytes32 migrationId, uint64 configVersion, uint64 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 separator =
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, account));
        bytes32 structHash = keccak256(abi.encode(CANCEL_MIGRATION_TYPEHASH, migrationId, configVersion, nonce));
        return keccak256(abi.encodePacked("\x19\x01", separator, structHash));
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.MIGRATION;
    }

    function _cancel(address account, PendingMigration memory migration) private {
        bytes32 migrationId = migrationIdFor(account, migration);
        delete pendingMigrations[account];
        migrationNonces[account] = migration.nonce + 1;
        emit MigrationCancelled(account, migrationId);
    }

    function _requireInstalledAccount(address account) private view {
        if (!ILoomAccount(account).isModuleInstalled(ModuleType.MIGRATION, address(this))) revert InvalidMigration();
    }
}
