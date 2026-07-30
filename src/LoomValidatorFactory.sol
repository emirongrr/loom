// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Permissionless CREATE2 deployer for the fresh validator instance a
/// recovery needs.
/// @dev Recovery replaces an account's whole validator set, and both
/// `RecoveryManager.proposeRecovery` and `LoomAccount.recoverConfiguration` reject
/// a `newValidator` that is already installed on the account. Loom's validators are
/// multi-tenant -- they key state by the calling account -- so a user recovering to
/// a new credential of the same kind cannot reuse the installed instance. They need
/// a second deployment of the same code at a different address.
///
/// Nothing in the repository provided one, so the reference wallet reached for a
/// backend endpoint that spends an operator key to deploy instances on demand. That
/// makes recovery depend on a hosted service holding a private key, which
/// contradicts the walkaway guarantee: recovery has to work when every
/// Loom-operated service is gone.
///
/// This factory removes that dependency. The address is a pure function of this
/// factory, the account, the recovery nonce, and the exact creation code, so a
/// wallet can compute it offline before anyone spends gas. Any party may then
/// deploy it -- the user, a guardian, a relayer, a stranger -- and the deployer
/// gains nothing by doing so.
///
/// The factory has no owner, no upgrade path, no registry, and no state. It never
/// calls `initialize`: validator state is keyed by the caller, and the account
/// performs initialization itself through `recoverConfiguration`, so a deployment
/// carries no authority over the resulting instance.
contract LoomValidatorFactory {
    error EmptyCreationCode();
    error DeploymentFailed();

    /// @notice Domain tag so a salt derived here cannot collide with one derived
    /// for another purpose that happens to hash the same fields.
    bytes32 private constant SALT_DOMAIN = keccak256("loom.validator.factory.v1");

    event ValidatorDeployed(
        address indexed validator, address indexed account, uint64 indexed recoveryNonce, bytes32 creationCodeHash
    );

    /// @notice Deploy the validator instance for `account`'s recovery at
    /// `recoveryNonce`, or return it if someone already did.
    /// @dev Idempotent on purpose. The address is fully determined by the inputs, so
    /// two parties racing to provision the same recovery converge on the same
    /// instance with the same code rather than one of them failing. Front-running is
    /// therefore not a denial: an attacker who deploys first has produced exactly the
    /// contract the user asked for, at the address the guardians will sign over.
    ///
    /// Constructor arguments are part of `creationCode` and so part of the address.
    /// A validator deployed against a different fallback verifier, or any other
    /// constructor input, lands somewhere else and cannot be substituted here.
    function deploy(address account, uint64 recoveryNonce, bytes calldata creationCode)
        external
        returns (address validator)
    {
        if (creationCode.length == 0) revert EmptyCreationCode();
        bytes32 creationCodeHash = keccak256(creationCode);
        validator = predict(account, recoveryNonce, creationCodeHash);
        if (validator.code.length != 0) return validator;

        bytes32 salt = saltFor(account, recoveryNonce);
        bytes memory code = creationCode;
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 32), mload(code), salt)
        }
        if (deployed != validator || deployed.code.length == 0) revert DeploymentFailed();
        emit ValidatorDeployed(validator, account, recoveryNonce, creationCodeHash);
    }

    /// @notice The address `deploy` will produce for these inputs.
    /// @dev Lets a wallet commit to the instance before it exists. Guardians sign a
    /// recovery proposal that binds `newValidator`, so the address has to be known in
    /// advance; deployment can then happen at any time before execution, by anyone.
    function predict(address account, uint64 recoveryNonce, bytes32 creationCodeHash) public view returns (address) {
        bytes32 hash =
            keccak256(abi.encodePacked(bytes1(0xff), address(this), saltFor(account, recoveryNonce), creationCodeHash));
        return address(uint160(uint256(hash)));
    }

    /// @notice Salt binding an instance to one account and one recovery.
    /// @dev Binding the recovery nonce is what keeps each recovery's instance
    /// distinct, so a later recovery never collides with a validator the account
    /// already has installed -- which both `proposeRecovery` and
    /// `recoverConfiguration` reject.
    function saltFor(address account, uint64 recoveryNonce) public pure returns (bytes32) {
        return keccak256(abi.encode(SALT_DOMAIN, account, recoveryNonce));
    }
}
