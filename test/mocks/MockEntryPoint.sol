// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";

/// @notice A stand-in for the *caller* the account expects, not a model of the
/// ERC-4337 EntryPoint.
/// @dev It exists so unit tests can reach `execute` and `validateUserOp`
/// through an address the account accepts, without pulling the real EntryPoint
/// and its deposit accounting into every unit test. It does not implement
/// `IEntryPoint`, does not run the validation loop, does not track deposits or
/// prefund, does not model `senderCreator` as a separate contract, and its
/// `getNonce` is a constant rather than a two-dimensional nonce.
///
/// No nonce, prefund, deposit, aggregation, or bundler-visibility property may
/// be claimed from a test that uses this. Those are proven against the real
/// EntryPoint under `test/integration/EntryPoint*.t.sol` and
/// `test/invariant/EntryPointMultiAccountInvariant.t.sol`, which are the only
/// places `getNonce` results are asserted on.
/// See docs/security/test-doubles.md.
contract MockEntryPoint {
    /// @dev Deliberately constant. Any test that needs real nonce sequencing
    /// must use the real EntryPoint instead of reading this.
    function getNonce(address, uint192) external pure returns (uint256) {
        return 0;
    }

    function senderCreator() external view returns (address) {
        return address(this);
    }

    function createAccount(
        LoomAccountFactory factory,
        bytes32 salt,
        bytes32 guardianRoot,
        uint8 guardianThreshold,
        bytes32 configHash,
        LoomAccount.ModuleInit[] calldata modules
    ) external returns (LoomAccount) {
        return factory.createAccount(salt, guardianRoot, guardianThreshold, configHash, modules);
    }
}
