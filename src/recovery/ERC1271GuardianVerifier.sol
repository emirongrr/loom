// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC1271} from "../interfaces/IERC1271.sol";
import {IGuardianVerifier} from "../interfaces/IGuardianVerifier.sol";

/// @notice Stateless guardian verifier for contract wallets and multisigs.
/// @dev The commitment is keccak256(abi.encode(signerContract)).
contract ERC1271GuardianVerifier is IGuardianVerifier {
    bytes4 public constant MAGIC_VALUE = 0x1626ba7e;

    function verify(bytes32 keyCommitment, bytes32 digest, bytes calldata signature) external view returns (bool) {
        (address signerContract, bytes memory signerSignature) = abi.decode(signature, (address, bytes));
        if (signerContract.code.length == 0 || keyCommitment != keccak256(abi.encode(signerContract))) {
            return false;
        }

        try IERC1271(signerContract).isValidSignature(digest, signerSignature) returns (bytes4 value) {
            return value == MAGIC_VALUE;
        } catch {
            return false;
        }
    }
}
