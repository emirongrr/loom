// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {P256RecoveryValidatorFactory} from "../../src/validators/P256RecoveryValidatorFactory.sol";
import {P256RecoveryValidator} from "../../src/validators/P256RecoveryValidator.sol";
import {P256Validator} from "../../src/validators/P256Validator.sol";
import {OZP256Verifier} from "../mocks/OZP256Verifier.sol";
import {P256TestKeys} from "../helpers/P256TestKeys.sol";

/// @notice The factory provisions a validator that is finished when it is
/// deployed (ADR-0025). Recovery therefore carries no initializer, so these
/// tests are about one question: is the key that ends up in the validator
/// exactly the key its address commits to, and is there any second way to get a
/// key in there.
contract P256RecoveryValidatorFactoryTest is Test {
    address internal constant ACCOUNT = address(0xA11CE);
    address internal constant POLICY_HOOK = address(0xBEEF);
    bytes32 internal constant RP_ID_HASH = keccak256("localhost");
    bytes32 internal constant ORIGIN_HASH = keccak256("http://localhost:5174");

    function _x() internal pure returns (bytes32) {
        return P256TestKeys.x(1);
    }

    function _y() internal pure returns (bytes32) {
        return P256TestKeys.y(1);
    }

    function _hash(P256RecoveryValidatorFactory factory) internal pure returns (bytes32) {
        return factory.initDataHashFor(_x(), _y(), RP_ID_HASH, ORIGIN_HASH, POLICY_HOOK);
    }

    function _deploy(P256RecoveryValidatorFactory factory, address account, uint64 nonce) internal returns (address) {
        return factory.deploy(account, nonce, _x(), _y(), RP_ID_HASH, ORIGIN_HASH, POLICY_HOOK);
    }

    function testDeploysThePredictedValidatorAndWritesItsKey() public {
        OZP256Verifier verifier = new OZP256Verifier();
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(verifier));

        address predicted = factory.getAddress(ACCOUNT, 7, _hash(factory));
        address deployed = _deploy(factory, ACCOUNT, 7);

        require(deployed == predicted, "unexpected recovery validator address");
        require(P256Validator(deployed).fallbackVerifier() == address(verifier), "fallback verifier changed");
        require(P256RecoveryValidator(deployed).recoveryAccount() == ACCOUNT, "recovery account not reserved");
        require(P256RecoveryValidator(deployed).recoveryInitDataHash() == _hash(factory), "initializer not reserved");

        // The point of the change: nothing else has to happen for this validator
        // to be usable, so nothing has to survive from the device that made it.
        (bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash) = P256Validator(deployed).publicKeys(ACCOUNT);
        require(x == _x() && y == _y(), "the key was not written at deployment");
        require(rpIdHash == RP_ID_HASH && originHash == ORIGIN_HASH, "relying party was not written at deployment");
        require(P256Validator(deployed).policyHooks(ACCOUNT) == POLICY_HOOK, "policy hook was not written");

        require(_deploy(factory, ACCOUNT, 7) == deployed, "repeat deployment was not idempotent");
    }

    /// The address commits to one key. Leaving any later initializer open would
    /// be a second way to put a key in a validator guardians already approved by
    /// address, so it is closed for everyone including the account.
    function testTheKeyCannotBeWrittenAgainByAnyone() public {
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));
        P256RecoveryValidator validator = P256RecoveryValidator(_deploy(factory, ACCOUNT, 7));

        bytes memory initializer = abi.encodeCall(
            P256Validator.initialize, (P256TestKeys.x(2), P256TestKeys.y(2), RP_ID_HASH, ORIGIN_HASH, POLICY_HOOK)
        );
        (bool asAccount,) = address(validator).call(initializer);
        require(!asAccount, "initialize is still open");

        vm.prank(ACCOUNT);
        (bool asOwner,) = address(validator).call(initializer);
        require(!asOwner, "the account can still write a key");

        (bool provisionedAgain,) = address(validator)
            .call(
                abi.encodeCall(
                    P256RecoveryValidator.provisionRecoveryIntent,
                    (
                        ACCOUNT,
                        _hash(factory),
                        P256TestKeys.x(2),
                        P256TestKeys.y(2),
                        RP_ID_HASH,
                        ORIGIN_HASH,
                        POLICY_HOOK
                    )
                )
            );
        require(!provisionedAgain, "an external caller re-provisioned the validator");

        (bytes32 x,,,) = P256Validator(address(validator)).publicKeys(ACCOUNT);
        require(x == _x(), "a rejected write still changed the key");
    }

    function testAddressBindsAccountNonceAndKey() public {
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));
        bytes32 hash = _hash(factory);
        address base = factory.getAddress(ACCOUNT, 7, hash);

        require(factory.getAddress(address(0xB0B), 7, hash) != base, "account was not bound");
        require(factory.getAddress(ACCOUNT, 8, hash) != base, "recovery nonce was not bound");

        bytes32 otherKey =
            factory.initDataHashFor(P256TestKeys.x(2), P256TestKeys.y(2), RP_ID_HASH, ORIGIN_HASH, POLICY_HOOK);
        require(factory.getAddress(ACCOUNT, 7, otherKey) != base, "key was not bound");

        bytes32 otherOrigin =
            factory.initDataHashFor(_x(), _y(), RP_ID_HASH, keccak256("https://evil.example"), POLICY_HOOK);
        require(factory.getAddress(ACCOUNT, 7, otherOrigin) != base, "relying party was not bound");
    }

    /// A different key must produce a different address, or approving an address
    /// would not be approving a key.
    function testFuzzDifferentKeyMaterialNeverSharesAnAddress(uint8 first, uint8 second) public {
        // The helper only carries a small table of real curve points.
        first = uint8(bound(first, 1, 2));
        second = uint8(bound(second, 1, 2));
        vm.assume(first != second);
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));

        bytes32 left =
            factory.initDataHashFor(P256TestKeys.x(first), P256TestKeys.y(first), RP_ID_HASH, ORIGIN_HASH, POLICY_HOOK);
        bytes32 right = factory.initDataHashFor(
            P256TestKeys.x(second), P256TestKeys.y(second), RP_ID_HASH, ORIGIN_HASH, POLICY_HOOK
        );

        assertTrue(left != right, "two keys shared a commitment");
        assertTrue(
            factory.getAddress(ACCOUNT, 0, left) != factory.getAddress(ACCOUNT, 0, right), "two keys shared an address"
        );
    }

    function testFuzzAnyCallerCanOnlyDeployTheCommittedValidator(
        address account,
        uint64 recoveryNonce,
        address publisher
    ) public {
        vm.assume(account != address(0));
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));
        address predicted = factory.getAddress(account, recoveryNonce, _hash(factory));

        vm.prank(publisher);
        address deployed = _deploy(factory, account, recoveryNonce);

        assertEq(deployed, predicted);
        assertGt(deployed.code.length, 0);
        assertEq(_deploy(factory, account, recoveryNonce), deployed);
        (bytes32 x,,,) = P256Validator(deployed).publicKeys(account);
        assertEq(x, _x(), "the publisher did not get the committed key");
    }

    function testRejectsUnboundDeploymentInputsAndInvalidFallback() public {
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));
        (bool zeroAccount,) = address(factory)
            .call(
                abi.encodeCall(
                    P256RecoveryValidatorFactory.deploy,
                    (address(0), 0, _x(), _y(), RP_ID_HASH, ORIGIN_HASH, POLICY_HOOK)
                )
            );
        (bool zeroHook,) = address(factory)
            .call(
                abi.encodeCall(
                    P256RecoveryValidatorFactory.deploy, (ACCOUNT, 0, _x(), _y(), RP_ID_HASH, ORIGIN_HASH, address(0))
                )
            );
        (bool invalidKey,) = address(factory)
            .call(
                abi.encodeCall(
                    P256RecoveryValidatorFactory.deploy,
                    (ACCOUNT, 0, bytes32(0), bytes32(0), RP_ID_HASH, ORIGIN_HASH, POLICY_HOOK)
                )
            );
        (bool invalidFallback,) =
            address(this).call(abi.encodeWithSelector(this.deployFactory.selector, address(0xDEAD)));

        require(!zeroAccount, "zero account accepted");
        require(!zeroHook, "zero policy hook accepted");
        require(!invalidKey, "an off-curve key was accepted");
        require(!invalidFallback, "code-less fallback verifier accepted");
    }

    function deployFactory(address verifier) external returns (P256RecoveryValidatorFactory) {
        return new P256RecoveryValidatorFactory(verifier);
    }
}
