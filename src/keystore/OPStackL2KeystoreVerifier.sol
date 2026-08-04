// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IKeystoreProofVerifier} from "../interfaces/IKeystoreProofVerifier.sol";
import {ILoomKeystore} from "../interfaces/ILoomKeystore.sol";
import {IL1Block} from "../interfaces/IL1Block.sol";
import {SecureMerkleTrie} from "@optimism-trie/trie/SecureMerkleTrie.sol";
import {RLPReader} from "@optimism-trie/rlp/RLPReader.sol";

/// @notice Cross-chain keystore verifier for OP Stack L2s (Base, Optimism, and
/// other OP Stack chains). It proves that the L1 `LoomKeystore` holds a given
/// `KeystoreConfig` for an identity by verifying an EIP-1186 account-and-storage
/// proof against an Ethereum L1 state root. There is no bridge, oracle, messaging
/// layer, or Loom-operated service in the trust path: authority comes from L1
/// state alone, and any party can carry a valid proof.
/// See docs/decisions/0008-op-stack-l2-keystore-verifier.md.
///
/// The state root is not read directly. The canonical `L1Block` predeploy does
/// not publish one; it publishes the L1 block *hash*. The caller therefore
/// supplies the RLP-encoded L1 block header alongside the proofs, this contract
/// checks `keccak256(header) == L1Block.hash()`, and reads the state root out of
/// the header's fourth field. Binding the header to the sequencer-written hash is
/// what makes the state root authentic; the header itself is untrusted calldata.
///
/// Trust boundary: the OP Stack sequencer that writes `L1Block` is a liveness
/// dependency for state-root currency (a withheld or stale root only delays
/// keystore sync), not a safety dependency — `KeystoreConfig.version`
/// monotonicity prevents a stale root from validating a config the user did not
/// author. This contract is bound to one L1 `LoomKeystore` and one `L1Block`
/// address at construction and must be deployed independently per OP Stack chain.
///
/// This is NOT the same-chain Ethereum L1 verifier; for L1, use
/// `EthereumL1KeystoreVerifier`, which reads the keystore directly.
contract OPStackL2KeystoreVerifier is IKeystoreProofVerifier {
    error InvalidKeystore();
    error InvalidL1Block();
    error OnlySelf();

    /// @notice The Ethereum L1 `LoomKeystore` whose storage is proven. This
    /// address need not (and usually does not) have code on the L2.
    address public immutable loomKeystore;

    /// @notice The OP Stack `L1Block` predeploy used as the L1 state-root source.
    /// Taken as a constructor argument rather than hardcoded so a chain that
    /// relocates or changes the predeploy can be supported without a code change.
    address public immutable l1Block;

    /// @notice Storage slot of `LoomKeystore._configs` (mapping). `controllerOf`
    /// occupies slot 0 and `_configs` occupies slot 1; `MAX_GUARDIAN_THRESHOLD`
    /// is a constant and takes no slot. A storage-layout pin test guards this.
    uint256 private constant CONFIGS_SLOT = 1;

    /// @notice Number of fields in an Ethereum account RLP list:
    /// [nonce, balance, storageRoot, codeHash].
    uint256 private constant ACCOUNT_FIELDS = 4;

    /// @notice Index of the storage root within the account RLP list.
    uint256 private constant STORAGE_ROOT_INDEX = 2;

    /// @notice Index of `stateRoot` in an Ethereum block header RLP list:
    /// [parentHash, ommersHash, beneficiary, stateRoot, ...].
    uint256 private constant HEADER_STATE_ROOT_INDEX = 3;

    /// @notice Minimum number of fields in an Ethereum block header RLP list.
    /// @dev A pre-London header has 15. Later forks only append (baseFeePerGas,
    /// withdrawalsRoot, blobGasUsed, excessBlobGas, parentBeaconBlockRoot,
    /// requestsHash), so a lower bound stays valid across forks while still
    /// rejecting a short list that could not be a header. The fields this contract
    /// reads sit well inside the first 15.
    uint256 private constant MIN_HEADER_FIELDS = 15;

    /// @notice Caller-supplied EIP-1186 proof, ABI-encoded as `proof`.
    /// @param l1BlockHeader      RLP-encoded Ethereum L1 block header. Untrusted until
    ///                           `keccak256(l1BlockHeader)` matches `L1Block.hash()`;
    ///                           the state root the proofs verify against is read from it.
    /// @param accountProof       Account-trie nodes proving `loomKeystore` against the L1 state root.
    /// @param validatorRootProof Storage-trie nodes for `_configs[id].validatorRoot` (slot base + 0).
    /// @param guardianRootProof  Storage-trie nodes for `_configs[id].guardianRoot` (slot base + 1).
    /// @param appAccountRootProof Storage-trie nodes for `_configs[id].appAccountRoot` (slot base + 2).
    /// @param packedProof        Storage-trie nodes for the packed slot holding `guardianThreshold`
    ///                           and `version` (slot base + 3).
    struct KeystoreProof {
        bytes l1BlockHeader;
        bytes[] accountProof;
        bytes[] validatorRootProof;
        bytes[] guardianRootProof;
        bytes[] appAccountRootProof;
        bytes[] packedProof;
    }

    /// @param loomKeystore_ L1 LoomKeystore address (non-zero; code on L1, not L2).
    /// @param l1Block_      OP Stack L1Block predeploy address (must have code on this L2).
    constructor(address loomKeystore_, address l1Block_) {
        if (loomKeystore_ == address(0)) revert InvalidKeystore();
        if (l1Block_.code.length == 0) revert InvalidL1Block();
        // Probe the predeploy for the exact function this verifier depends on, so a
        // deployment onto a chain whose `L1Block` does not expose it fails here
        // rather than silently returning false for every proof forever. The
        // previous version asked for a function the canonical predeploy has never
        // had, and nothing caught it until a real chain was involved.
        (bool probed, bytes memory result) = l1Block_.staticcall(abi.encodeCall(IL1Block.hash, ()));
        if (!probed || result.length != 32) revert InvalidL1Block();
        loomKeystore = loomKeystore_;
        l1Block = l1Block_;
    }

    /// @inheritdoc IKeystoreProofVerifier
    /// @dev Returns false (never reverts) on any invalid input, malformed proof,
    /// or failed trie verification. Proof verification is delegated to an external
    /// self-call so reverts from the trie/RLP libraries are caught and mapped to
    /// `false` rather than propagating.
    function verifyKeystoreConfig(
        address keystore,
        bytes32 identityId,
        uint64 version,
        ILoomKeystore.KeystoreConfig calldata config,
        bytes calldata proof
    ) external view returns (bool) {
        if (
            keystore != loomKeystore || identityId == bytes32(0) || version == 0 || config.version != version
                || proof.length == 0
        ) return false;

        try this.verifyProvenConfig(identityId, version, config, proof) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @notice Proof verification body. External only so `verifyKeystoreConfig`
    /// can wrap it in try/catch and fail closed; rejects any caller other than
    /// this contract.
    function verifyProvenConfig(
        bytes32 identityId,
        uint64 version,
        ILoomKeystore.KeystoreConfig calldata config,
        bytes calldata proof
    ) external view returns (bool) {
        if (msg.sender != address(this)) revert OnlySelf();

        KeystoreProof memory p = abi.decode(proof, (KeystoreProof));

        // The predeploy publishes the L1 block hash, not the state root. Binding
        // the caller's header to that hash is what makes the state root read out
        // of it authentic; the header is otherwise untrusted calldata.
        bytes32 l1BlockHash = IL1Block(l1Block).hash();
        if (l1BlockHash == bytes32(0)) return false;
        if (keccak256(p.l1BlockHeader) != l1BlockHash) return false;

        RLPReader.RLPItem[] memory header = RLPReader.readList(p.l1BlockHeader);
        if (header.length < MIN_HEADER_FIELDS) return false;
        bytes32 stateRoot = _toBytes32(RLPReader.readBytes(header[HEADER_STATE_ROOT_INDEX]));
        if (stateRoot == bytes32(0)) return false;

        // Prove the LoomKeystore account against the L1 state root and recover its storage root.
        bytes memory accountRLP = SecureMerkleTrie.get(abi.encodePacked(loomKeystore), p.accountProof, stateRoot);
        RLPReader.RLPItem[] memory account = RLPReader.readList(accountRLP);
        if (account.length != ACCOUNT_FIELDS) return false;
        bytes32 storageRoot = _toBytes32(RLPReader.readBytes(account[STORAGE_ROOT_INDEX]));

        // _configs[identityId] base slot.
        uint256 base = uint256(keccak256(abi.encode(identityId, CONFIGS_SLOT)));

        if (_storageValue(p.validatorRootProof, bytes32(base), storageRoot) != config.validatorRoot) return false;
        if (_storageValue(p.guardianRootProof, bytes32(base + 1), storageRoot) != config.guardianRoot) return false;
        if (_storageValue(p.appAccountRootProof, bytes32(base + 2), storageRoot) != config.appAccountRoot) {
            return false;
        }

        // Slot base + 3 packs guardianThreshold (lowest byte) and version (next 8 bytes).
        uint256 packed = uint256(_storageValue(p.packedProof, bytes32(base + 3), storageRoot));
        // Truncation is intended: guardianThreshold is the lowest byte of the packed slot.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint8(packed) != config.guardianThreshold) return false;
        // Truncation is intended: version is the next 8 bytes (uint64) above guardianThreshold.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint64(packed >> 8) != version) return false;

        return true;
    }

    /// @notice Proves a single storage slot against `storageRoot` and returns its
    /// value right-aligned into a bytes32. Reverts (caught upstream) if the proof
    /// is invalid or the slot is absent.
    function _storageValue(bytes[] memory proof, bytes32 slot, bytes32 storageRoot) private pure returns (bytes32) {
        bytes memory rlpValue = SecureMerkleTrie.get(abi.encode(slot), proof, storageRoot);
        return _toBytes32(RLPReader.readBytes(RLPReader.toRLPItem(rlpValue)));
    }

    /// @notice Right-aligns up to 32 big-endian bytes into a bytes32. Returns zero
    /// for empty or over-long input (a zero result fails every config comparison,
    /// since all proven fields are required non-zero).
    function _toBytes32(bytes memory value) private pure returns (bytes32 out) {
        uint256 len = value.length;
        if (len == 0 || len > 32) return bytes32(0);
        assembly {
            out := shr(mul(8, sub(32, len)), mload(add(value, 32)))
        }
    }
}
