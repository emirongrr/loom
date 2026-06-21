/*
 * LoomAccount authority rules.
 *
 * Scope:
 * - This is a first CVL ruleset for account authority invariants.
 * - It is intentionally narrower than the full Loom account behavior.
 * - It must not be presented as proof of all wallet behavior.
 *
 * Modeling notes:
 * - External validators, hooks, EntryPoint behavior, and tokens are not fully
 *   modeled here.
 * - Rules focus on account-local authority boundaries that should hold across
 *   selected externally reachable calls.
 */

methods {
    function validatorCount() external returns (uint256) envfree;
    function configVersion() external returns (uint64) envfree;
    function guardianRoot() external returns (bytes32) envfree;
    function guardianThreshold() external returns (uint8) envfree;
    function frozenUntil() external returns (uint48) envfree;
    function isExecutingScheduled() external returns (bool) envfree;

    function execute(bytes32, bytes) external;
    function executeDirect(address, bytes32, bytes, uint48, bytes) external;
    function installModule(uint256, address, bytes) external;
    function uninstallModule(uint256, address, bytes) external;
    function setGuardianConfig(bytes32, uint8) external;
    function recoverConfiguration(address[], address, bytes, bytes32, uint8) external;
    function scheduleCall(address, uint256, bytes, uint48) external returns (bytes32);
    function cancelScheduled(bytes32) external;
    function unfreeze() external;
}

definition selectedAuthorityMethod(method f) returns bool =
    f.selector == sig:execute(bytes32,bytes).selector
    || f.selector == sig:executeDirect(address,bytes32,bytes,uint48,bytes).selector
    || f.selector == sig:installModule(uint256,address,bytes).selector
    || f.selector == sig:uninstallModule(uint256,address,bytes).selector
    || f.selector == sig:setGuardianConfig(bytes32,uint8).selector
    || f.selector == sig:recoverConfiguration(address[],address,bytes,bytes32,uint8).selector
    || f.selector == sig:scheduleCall(address,uint256,bytes,uint48).selector
    || f.selector == sig:cancelScheduled(bytes32).selector
    || f.selector == sig:unfreeze().selector;

invariant validatorCountNeverZero()
    validatorCount() > 0
    filtered { f -> selectedAuthorityMethod(f) }

rule configVersionNeverDecreases(method f) filtered {
    f -> selectedAuthorityMethod(f)
} {
    uint64 beforeVersion = configVersion();

    calldataarg args;
    env e;
    f(e, args);

    uint64 afterVersion = configVersion();
    assert afterVersion >= beforeVersion, "config version must be monotonic";
}

rule directSetGuardianConfigCannotSucceed(bytes32 newRoot, uint8 newThreshold) {
    bytes32 rootBefore = guardianRoot();
    uint8 thresholdBefore = guardianThreshold();
    uint64 versionBefore = configVersion();
    env e;

    setGuardianConfig@withrevert(e, newRoot, newThreshold);

    assert lastReverted, "guardian config must require scheduled self execution";
    assert guardianRoot() == rootBefore, "failed direct guardian update must preserve root";
    assert guardianThreshold() == thresholdBefore, "failed direct guardian update must preserve threshold";
    assert configVersion() == versionBefore, "failed direct guardian update must preserve version";
}

rule directRecoveryCannotSucceed(
    address[] oldValidators,
    address newValidator,
    bytes initData,
    bytes32 newGuardianRoot,
    uint8 newGuardianThreshold
) {
    uint256 validatorsBefore = validatorCount();
    bytes32 rootBefore = guardianRoot();
    uint8 thresholdBefore = guardianThreshold();
    uint64 versionBefore = configVersion();
    env e;

    recoverConfiguration@withrevert(e, oldValidators, newValidator, initData, newGuardianRoot, newGuardianThreshold);

    assert lastReverted, "recovery must require an installed recovery module";
    assert validatorCount() == validatorsBefore, "failed direct recovery must preserve validator count";
    assert guardianRoot() == rootBefore, "failed direct recovery must preserve guardian root";
    assert guardianThreshold() == thresholdBefore, "failed direct recovery must preserve guardian threshold";
    assert configVersion() == versionBefore, "failed direct recovery must preserve config version";
}

rule externalPrivilegedCallsRequireAccountSelf(
    uint256 moduleTypeId,
    address module,
    bytes initData,
    bytes deInitData,
    address target,
    uint256 value,
    bytes callData,
    uint48 delay,
    bytes32 operationId
) {
    env e;
    require e.msg.sender != currentContract;

    installModule@withrevert(e, moduleTypeId, module, initData);
    assert lastReverted, "installModule must reject non-self callers";

    uninstallModule@withrevert(e, moduleTypeId, module, deInitData);
    assert lastReverted, "uninstallModule must reject non-scheduled-self callers";

    scheduleCall@withrevert(e, target, value, callData, delay);
    assert lastReverted, "scheduleCall must reject non-self callers";

    cancelScheduled@withrevert(e, operationId);
    assert lastReverted, "cancelScheduled must reject non-self callers";

    unfreeze@withrevert(e);
    assert lastReverted, "unfreeze must reject non-self callers";
}

rule cannotRemoveLastValidatorThroughUninstall(uint256 moduleTypeId, address module, bytes deInitData) {
    env e;
    require validatorCount() == 1;

    uninstallModule@withrevert(e, moduleTypeId, module, deInitData);

    assert lastReverted || validatorCount() > 0, "successful uninstall must not remove the final validator";
}
