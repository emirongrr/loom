// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalGuardianVerifier, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountExecutionFormal is FormalAccountBase {
    function testFuzz_BatchExecutionAtomicity(uint256 newValue) public {
        check_BatchExecutionAtomicity(newValue);
    }

    function check_BatchExecutionAtomicity(uint256 newValue) public {
        (LoomAccount account,) = _account();
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution[] memory executions = new ExecutionLib.Execution[](2);
        executions[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue)));
        executions[1] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.fail, ()));

        (bool ok,) = address(account)
            .call(abi.encodeCall(LoomAccount.execute, (account.BATCH_EXECUTION_MODE(), abi.encode(executions))));

        assert(!ok);
        assert(target.value() == 0);
    }

    function testFuzz_FrozenAccountCannotExecute(uint256 newValue) public {
        check_FrozenAccountCannotExecute(newValue);
    }

    function check_FrozenAccountCannotExecute(uint256 newValue) public {
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        bytes32 leaf = _guardianLeaf(verifier, keyCommitment, salt);
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount account = new LoomAccount(address(this), leaf, 1, keccak256("config"), modules);
        account.freeze(address(verifier), keyCommitment, salt, new bytes32[](0), "");
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue)));

        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))));

        assert(!ok);
        assert(target.value() == 0);
    }

    function testFuzz_FrozenAccountCannotDirectExecute(uint256 newValue) public {
        check_FrozenAccountCannotDirectExecute(newValue);
    }

    function check_FrozenAccountCannotDirectExecute(uint256 newValue) public {
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        bytes32 leaf = _guardianLeaf(verifier, keyCommitment, salt);
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount account = new LoomAccount(address(this), leaf, 1, keccak256("config"), modules);
        account.freeze(address(verifier), keyCommitment, salt, new bytes32[](0), "");
        FormalTarget target = new FormalTarget();
        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue))));

        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.executeDirect,
                    (address(validator), bytes32(0), executionCalldata, type(uint48).max, bytes(""))
                )
            );

        assert(!ok);
        assert(target.value() == 0);
    }

    function testFuzz_DirectBatchExecutionAtomicity(uint256 newValue) public {
        check_DirectBatchExecutionAtomicity(newValue);
    }

    function check_DirectBatchExecutionAtomicity(uint256 newValue) public {
        (LoomAccount account, MockValidator validator) = _account();
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution[] memory executions = new ExecutionLib.Execution[](2);
        executions[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue)));
        executions[1] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.fail, ()));

        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.executeDirect,
                    (
                        address(validator),
                        account.BATCH_EXECUTION_MODE(),
                        abi.encode(executions),
                        type(uint48).max,
                        bytes("")
                    )
                )
            );

        assert(!ok);
        assert(target.value() == 0);
        assert(account.directExecutionNonces(address(validator)) == 0);
    }
}
