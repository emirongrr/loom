// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomModule} from "../interfaces/ILoomModule.sol";
import {ModuleType} from "./ModuleType.sol";

/// @notice Shared validator-set validation for recovery modules that stage a
/// replacement of an account's complete validator set.
/// @dev Recovery proposals must name the account's exact current validator set
/// (sorted, complete) so a proposal cannot silently leave a compromised
/// validator installed, and must stage only well-formed new validators. Every
/// module gating on these rules has to apply them identically, so they live
/// here. The account itself enforces the same rules again at execution time
/// from its own storage (see LoomAccount._validateCompleteValidatorSet and
/// _validateNewValidatorSet): this library is the module-side precondition
/// check through the public interface, not the authoritative enforcement.
library ValidatorSetLib {
    /// @notice Mirror of the account-side validator cap.
    uint256 internal constant MAX_VALIDATORS = 16;

    /// @notice True only if `validators` is exactly the account's current
    /// validator set: non-empty, strictly ascending, complete, all installed.
    function isCompleteSortedSet(ILoomAccount account, address[] calldata validators) internal view returns (bool) {
        if (validators.length == 0 || validators.length != account.validatorCount()) return false;
        address previous = address(0);
        for (uint256 i; i < validators.length; ++i) {
            if (validators[i] <= previous || !account.isModuleInstalled(ModuleType.VALIDATOR, validators[i])) {
                return false;
            }
            previous = validators[i];
        }
        return true;
    }

    /// @notice True only if `validators` is a well-formed replacement set:
    /// non-empty, within the validator cap, strictly ascending, every entry a
    /// deployed validator-typed module not already installed on the account.
    function isValidNewSet(ILoomAccount account, ILoomAccount.RecoveryModuleInit[] calldata validators)
        internal
        view
        returns (bool)
    {
        if (validators.length == 0 || validators.length > MAX_VALIDATORS) return false;
        address previous = address(0);
        for (uint256 i; i < validators.length; ++i) {
            ILoomAccount.RecoveryModuleInit calldata validator = validators[i];
            if (
                validator.moduleTypeId != ModuleType.VALIDATOR || validator.module <= previous
                    || validator.module.code.length == 0
                    || account.isModuleInstalled(ModuleType.VALIDATOR, validator.module)
                    || !ILoomModule(validator.module).isModuleType(ModuleType.VALIDATOR)
            ) {
                return false;
            }
            previous = validator.module;
        }
        return true;
    }
}
