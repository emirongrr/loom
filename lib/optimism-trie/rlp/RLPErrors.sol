// SPDX-License-Identifier: MIT
//
// Vendored from Optimism (ethereum-optimism/optimism), MIT licensed. See LICENSE
// in the parent directory.
//   Source:  packages/contracts-bedrock/src/libraries/rlp/RLPErrors.sol
//   Commit:  b3e09977c2f1b51a7a351b8ebd4afa4122f55a46
//   Fetched: 2026-06-30
// Modifications: none (this file has no internal imports). Do not edit in place;
// to update, re-vendor from a pinned upstream commit and re-pin the reference.
pragma solidity ^0.8.0;

/// @notice The length of an RLP item must be greater than zero to be decodable
error EmptyItem();

/// @notice The decoded item type for list is not a list item
error UnexpectedString();

/// @notice The RLP item has an invalid data remainder
error InvalidDataRemainder();

/// @notice Decoded item type for bytes is not a string item
error UnexpectedList();

/// @notice The length of the content must be greater than the RLP item length
error ContentLengthMismatch();

/// @notice Invalid RLP header for RLP item
error InvalidHeader();
