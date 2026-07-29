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

/*
 * The uninitialized-takeover rule.
 *
 * Deliberately carries no `configVersion() != 0` precondition: the takeover was
 * reachable exactly when `configVersion() == 0`, which is the state of an
 * EIP-7702 delegated EOA whose Loom storage is still empty. A rule that assumes
 * an already-initialized account cannot observe that state at all, which is why
 * `initializedAccountCannotBeReinitialized` above did not catch it.
 *
 * `nativeCodesize[currentContract] > 0` is an assumption about the environment,
 * not an exclusion of the bug state. Every live account has code: a deployed
 * proxy has its own, and an EIP-7702 delegated EOA carries the 23-byte
 * `0xef0100 || template` delegation indicator. The only account with no code is
 * a proxy still executing its own constructor, which is the single legitimate
 * caller `initialize` exists for and which no external party can occupy.
 */
rule uninitializedAccountRejectsProxyInitializer(
    address entryPoint,
    bytes32 newGuardianRoot,
    uint8 newGuardianThreshold,
    bytes32 newConfigHash,
    LoomAccount.ModuleInit[] modules
) {
    env e;
    require nativeCodesize[currentContract] > 0;
    uint256 validatorsBefore = validatorCount();
    bytes32 configHashBefore = configHash();
    bytes32 guardianRootBefore = guardianRoot();
    uint8 guardianThresholdBefore = guardianThreshold();
    uint64 configVersionBefore = configVersion();

    initialize@withrevert(e, entryPoint, newGuardianRoot, newGuardianThreshold, newConfigHash, modules);

    assert lastReverted, "a live account must reject the proxy bootstrap initializer at any config version";
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
