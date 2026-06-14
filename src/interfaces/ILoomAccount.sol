// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface ILoomAccount {
    function configHash() external view returns (bytes32);
    function configVersion() external view returns (uint64);
    function guardianRoot() external view returns (bytes32);
    function guardianThreshold() external view returns (uint8);
    function validatorCount() external view returns (uint256);
    function validatorAt(uint256 index) external view returns (address);
    function frozenUntil() external view returns (uint48);
    function isExecutingScheduled() external view returns (bool);
    function isModuleInstalled(uint256 moduleTypeId, address module) external view returns (bool);
    function notifyConfigChange(bytes32 changeHash) external;
    function recoverConfiguration(
        address[] calldata oldValidators,
        address newValidator,
        bytes calldata initData,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) external;
}
