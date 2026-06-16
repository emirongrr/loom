// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IKeystoreProofVerifier} from "../../src/interfaces/IKeystoreProofVerifier.sol";
import {ILoomKeystore} from "../../src/interfaces/ILoomKeystore.sol";

contract MockKeystoreProofVerifier is IKeystoreProofVerifier {
    bool public enabled = true;

    function setEnabled(bool enabled_) external {
        enabled = enabled_;
    }

    function verifyKeystoreConfig(
        address keystore,
        bytes32 identityId,
        uint64 version,
        ILoomKeystore.KeystoreConfig calldata config,
        bytes calldata
    ) external view returns (bool) {
        if (!enabled || keystore.code.length == 0 || identityId == bytes32(0)) return false;
        ILoomKeystore.KeystoreConfig memory stored = ILoomKeystore(keystore).getConfig(identityId);
        return stored.validatorRoot == config.validatorRoot && stored.guardianRoot == config.guardianRoot
            && stored.appAccountRoot == config.appAccountRoot && stored.guardianThreshold == config.guardianThreshold
            && stored.version == version && config.version == version;
    }
}
