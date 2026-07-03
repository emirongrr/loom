// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

library ExecutionLib {
    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    bytes1 internal constant CALLTYPE_SINGLE = 0x00;
    bytes1 internal constant CALLTYPE_BATCH = 0x01;

    // Full ERC-7579 execution mode words for the two supported call types.
    bytes32 internal constant SINGLE_EXECUTION_MODE = bytes32(0);
    bytes32 internal constant BATCH_EXECUTION_MODE = bytes32(uint256(1) << 248);

    function mode(bytes32 executionMode) internal pure returns (bytes1 callType, bytes1 execType) {
        // ERC-7579 stores callType and execType in the first two bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        callType = bytes1(executionMode);
        // forge-lint: disable-next-line(unsafe-typecast)
        execType = bytes1(executionMode << 8);
    }
}
