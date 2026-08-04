// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {P256RecoveryValidatorFactory} from "../../src/validators/P256RecoveryValidatorFactory.sol";
import {P256RecoveryValidator} from "../../src/validators/P256RecoveryValidator.sol";
import {P256Validator} from "../../src/validators/P256Validator.sol";
import {OZP256Verifier} from "../mocks/OZP256Verifier.sol";

contract P256RecoveryValidatorFactoryTest is Test {
    address internal constant ACCOUNT = address(0xA11CE);
    bytes32 internal constant INIT_DATA_HASH = keccak256("new passkey initializer");

    function testDeploysThePredictedImmutableValidatorIdempotently() public {
        OZP256Verifier verifier = new OZP256Verifier();
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(verifier));

        address predicted = factory.getAddress(ACCOUNT, 7, INIT_DATA_HASH);
        address deployed = factory.deploy(ACCOUNT, 7, INIT_DATA_HASH);

        require(deployed == predicted, "unexpected recovery validator address");
        require(deployed.code.length != 0, "recovery validator has no code");
        require(P256Validator(deployed).fallbackVerifier() == address(verifier), "fallback verifier changed");
        require(P256RecoveryValidator(deployed).recoveryAccount() == ACCOUNT, "recovery account not reserved");
        require(
            P256RecoveryValidator(deployed).recoveryInitDataHash() == INIT_DATA_HASH,
            "recovery initializer not reserved"
        );
        require(factory.deploy(ACCOUNT, 7, INIT_DATA_HASH) == deployed, "repeat deployment was not idempotent");
    }

    function testOnlyFactoryCanReserveTheRecoveryIntent() public {
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));
        P256RecoveryValidator validator = P256RecoveryValidator(factory.deploy(ACCOUNT, 7, INIT_DATA_HASH));

        (bool reservedAgain,) = address(validator)
            .call(abi.encodeCall(P256RecoveryValidator.reserveRecoveryIntent, (ACCOUNT, INIT_DATA_HASH)));

        require(!reservedAgain, "external caller changed the recovery reservation");
        require(validator.recoveryAccount() == ACCOUNT, "failed call changed recovery account");
        require(validator.recoveryInitDataHash() == INIT_DATA_HASH, "failed call changed initializer hash");
    }

    function testAddressBindsAccountNonceAndInitializer() public {
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));
        address base = factory.getAddress(ACCOUNT, 7, INIT_DATA_HASH);

        require(factory.getAddress(address(0xB0B), 7, INIT_DATA_HASH) != base, "account was not bound");
        require(factory.getAddress(ACCOUNT, 8, INIT_DATA_HASH) != base, "recovery nonce was not bound");
        require(factory.getAddress(ACCOUNT, 7, keccak256("other passkey")) != base, "initializer was not bound");
    }

    function testFuzzAnyCallerCanOnlyDeployTheCommittedValidator(
        address account,
        uint64 recoveryNonce,
        bytes32 initDataHash,
        address publisher
    ) public {
        vm.assume(account != address(0));
        vm.assume(initDataHash != bytes32(0));
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));
        address predicted = factory.getAddress(account, recoveryNonce, initDataHash);

        vm.prank(publisher);
        address deployed = factory.deploy(account, recoveryNonce, initDataHash);

        assertEq(deployed, predicted);
        assertGt(deployed.code.length, 0);
        assertEq(factory.deploy(account, recoveryNonce, initDataHash), deployed);
    }

    function testRejectsUnboundDeploymentInputsAndInvalidFallback() public {
        P256RecoveryValidatorFactory factory = new P256RecoveryValidatorFactory(address(0));
        (bool zeroAccount,) =
            address(factory).call(abi.encodeCall(P256RecoveryValidatorFactory.deploy, (address(0), 0, INIT_DATA_HASH)));
        (bool zeroInitializer,) =
            address(factory).call(abi.encodeCall(P256RecoveryValidatorFactory.deploy, (ACCOUNT, 0, bytes32(0))));
        (bool invalidFallback,) =
            address(this).call(abi.encodeWithSelector(this.deployFactory.selector, address(0xDEAD)));

        require(!zeroAccount, "zero account accepted");
        require(!zeroInitializer, "zero initializer accepted");
        require(!invalidFallback, "code-less fallback verifier accepted");
    }

    function deployFactory(address verifier) external returns (P256RecoveryValidatorFactory) {
        return new P256RecoveryValidatorFactory(verifier);
    }
}
