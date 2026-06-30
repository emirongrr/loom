// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IKeystoreProofVerifier} from "../interfaces/IKeystoreProofVerifier.sol";
import {ILoomKeystore} from "../interfaces/ILoomKeystore.sol";

/// @notice Same-chain Ethereum L1 verifier: reads `LoomKeystore` directly because the verifier and
/// the keystore are on the same chain, so no cross-chain state-root proof is needed (`proof` must be
/// empty). This is NOT an L2 proof verifier and must not be deployed as a Base, Optimism, or Arbitrum
/// adapter — those require a chain-specific verifier that proves L1 keystore state against the
/// target chain's accepted L1 state root, which does not exist yet (see docs/design/keystore.md and
/// docs/decisions/0003-l1-keystore-verifier.md).
contract EthereumL1KeystoreVerifier is IKeystoreProofVerifier {
    error InvalidKeystore();

    address public immutable loomKeystore;

    constructor(address loomKeystore_) {
        if (loomKeystore_.code.length == 0) revert InvalidKeystore();
        loomKeystore = loomKeystore_;
    }

    function verifyKeystoreConfig(
        address keystore,
        bytes32 identityId,
        uint64 version,
        ILoomKeystore.KeystoreConfig calldata config,
        bytes calldata proof
    ) external view returns (bool) {
        if (
            keystore != loomKeystore || identityId == bytes32(0) || proof.length != 0 || version == 0
                || config.version != version
        ) return false;

        try ILoomKeystore(loomKeystore).getConfig(identityId) returns (ILoomKeystore.KeystoreConfig memory stored) {
            return stored.validatorRoot == config.validatorRoot && stored.guardianRoot == config.guardianRoot
                && stored.appAccountRoot == config.appAccountRoot
                && stored.guardianThreshold == config.guardianThreshold && stored.version == version;
        } catch {
            return false;
        }
    }
}
