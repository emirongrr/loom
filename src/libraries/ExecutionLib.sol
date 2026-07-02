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

    function mode(bytes32 executionMode) internal pure returns (bytes1 callType, bytes1 execType) {
        // ERC-7579 stores callType and execType in the first two bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        callType = bytes1(executionMode);
        // forge-lint: disable-next-line(unsafe-typecast)
        execType = bytes1(executionMode << 8);
    }
}
