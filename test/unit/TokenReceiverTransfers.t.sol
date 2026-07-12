// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC721} from "openzeppelin-contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "openzeppelin-contracts/token/ERC1155/ERC1155.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmTokenReceiver {
    function prank(address sender) external;
}

contract ReceiverTestERC721 is ERC721 {
    constructor() ERC721("Receiver Test", "RCV") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

contract ReceiverTestERC1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function mintBatch(address to, uint256[] memory ids, uint256[] memory amounts) external {
        _mintBatch(to, ids, amounts, "");
    }
}

contract TokenReceiverTransfersTest {
    VmTokenReceiver internal constant vm = VmTokenReceiver(address(uint160(uint256(keccak256("hevm cheat code")))));

    LoomAccount internal account;

    function setUp() public {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function testERC721SafeTransferReachesAccount() public {
        ReceiverTestERC721 token = new ReceiverTestERC721();
        token.mint(address(this), 7);

        token.safeTransferFrom(address(this), address(account), 7, hex"aabbcc");

        require(token.ownerOf(7) == address(account), "ERC-721 safe transfer did not reach account");
        require(token.balanceOf(address(account)) == 1, "ERC-721 account balance missing");
    }

    function testERC1155SingleAndBatchSafeTransfersReachAccount() public {
        ReceiverTestERC1155 token = new ReceiverTestERC1155();
        address holder = address(0xA11CE);
        token.mint(holder, 11, 5);

        vm.prank(holder);
        token.safeTransferFrom(holder, address(account), 11, 3, hex"1122");
        require(token.balanceOf(address(account), 11) == 3, "ERC-1155 single transfer did not reach account");

        uint256[] memory ids = new uint256[](2);
        ids[0] = 12;
        ids[1] = 13;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 4;
        amounts[1] = 6;
        token.mintBatch(holder, ids, amounts);

        vm.prank(holder);
        token.safeBatchTransferFrom(holder, address(account), ids, amounts, hex"3344");

        require(token.balanceOf(address(account), 12) == 4, "first ERC-1155 batch balance missing");
        require(token.balanceOf(address(account), 13) == 6, "second ERC-1155 batch balance missing");
    }
}
