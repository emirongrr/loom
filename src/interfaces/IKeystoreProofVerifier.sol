// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomKeystore} from "./ILoomKeystore.sol";

interface IKeystoreProofVerifier {
    function verifyKeystoreConfig(
        address keystore,
        bytes32 identityId,
        uint64 version,
        ILoomKeystore.KeystoreConfig calldata config,
        bytes calldata proof
    ) external view returns (bool);
}
