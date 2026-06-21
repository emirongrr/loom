/*
 * LoomAccount initialization and anti-upgrade rules.
 *
 * Scope:
 * - Historical wallet failures include uninitialized account takeover,
 *   delegated initialization abuse, and upgrade/admin authority appearing
 *   through deployment plumbing.
 * - This ruleset targets the account-local portion of that bug class.
 * - Proxy constructor behavior remains covered by Foundry/Halmos properties
 *   until a dedicated Certora proxy harness is added.
 */

methods {
    function validatorCount() external returns (uint256) envfree;
    function configVersion() external returns (uint64) envfree;
    function configHash() external returns (bytes32) envfree;
    function guardianRoot() external returns (bytes32) envfree;
    function guardianThreshold() external returns (uint8) envfree;
    function initialize(address, bytes32, uint8, bytes32, LoomAccount.ModuleInit[]) external;
    function initializeDelegatedAccount(address, bytes32, uint8, bytes32, LoomAccount.ModuleInit[]) external;
}

rule initializedAccountCannotBeReinitialized(
    address entryPoint,
    bytes32 newGuardianRoot,
    uint8 newGuardianThreshold,
    bytes32 newConfigHash,
    LoomAccount.ModuleInit[] modules
) {
    env e;
    require configVersion() != 0;
    uint256 validatorsBefore = validatorCount();
    bytes32 configHashBefore = configHash();
    bytes32 guardianRootBefore = guardianRoot();
    uint8 guardianThresholdBefore = guardianThreshold();
    uint64 configVersionBefore = configVersion();

    initialize@withrevert(e, entryPoint, newGuardianRoot, newGuardianThreshold, newConfigHash, modules);

    assert lastReverted, "initialized account must reject direct initialize";
    assert validatorCount() == validatorsBefore, "failed initialize must preserve validator count";
    assert configHash() == configHashBefore, "failed initialize must preserve config hash";
    assert guardianRoot() == guardianRootBefore, "failed initialize must preserve guardian root";
    assert guardianThreshold() == guardianThresholdBefore, "failed initialize must preserve threshold";
    assert configVersion() == configVersionBefore, "failed initialize must preserve version";
}

rule delegatedInitializerRequiresAccountSelf(
    address entryPoint,
    bytes32 newGuardianRoot,
    uint8 newGuardianThreshold,
    bytes32 newConfigHash,
    LoomAccount.ModuleInit[] modules
) {
    env e;
    require e.msg.sender != currentContract;
    uint256 validatorsBefore = validatorCount();
    uint64 configVersionBefore = configVersion();

    initializeDelegatedAccount@withrevert(e, entryPoint, newGuardianRoot, newGuardianThreshold, newConfigHash, modules);

    assert lastReverted, "delegated initializer must reject external callers";
    assert validatorCount() == validatorsBefore, "failed delegated initialize must preserve validators";
    assert configVersion() == configVersionBefore, "failed delegated initialize must preserve version";
}
