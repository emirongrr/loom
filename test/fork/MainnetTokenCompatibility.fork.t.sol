// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {LoomAccount} from "../../src/LoomAccount.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {VaultHook} from "../../src/hooks/VaultHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface IERC20ForkToken {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IWETHForkToken is IERC20ForkToken {
    function deposit() external payable;
}

interface IERC4626ForkToken is IERC20ForkToken {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

contract MainnetTokenCompatibilityForkTest is Test {
    uint256 internal constant MAINNET_BLOCK = 20_000_000;

    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant SDAI = 0x83F20F44975D03b1b09e64809B757c47f942BEeA;
    address internal constant TOKEN_HOLDER = 0x28C6c06298d514Db089934071355E5743bf21d60;
    address internal constant RECIPIENT = address(0xBEEF);

    bool internal forkActive;
    PolicyHook internal policyHook;
    VaultHook internal vaultHook;
    LoomAccount internal account;

    function setUp() public {
        string memory rpcUrl = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl, MAINNET_BLOCK);
        forkActive = true;
        assertEq(block.chainid, 1, "fork is not Ethereum mainnet");

        for (uint256 i; i < _tokens().length; ++i) {
            assertGt(_tokens()[i].code.length, 0, "pinned token has no code");
        }

        policyHook = new PolicyHook();
        vaultHook = new VaultHook();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(policyHook), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(vaultHook), "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("fork-config"), modules);
    }

    function testForkUsdcBooleanReturnPreservesPolicyAccountingAndRollback() public {
        _requireFork();
        _assertPolicyTransfer(USDC, 40e6, 100e6);
    }

    function testForkUsdtNoReturnPreservesPolicyAccountingAndRollback() public {
        _requireFork();
        _assertPolicyTransfer(USDT, 40e6, 100e6);
    }

    function testForkWethDepositAndVaultTransferUseExactRequestedAmount() public {
        _requireFork();
        vm.deal(address(account), 1 ether);

        _execute(WETH, 0.3 ether, abi.encodeCall(IWETHForkToken.deposit, ()));
        assertEq(IERC20ForkToken(WETH).balanceOf(address(account)), 0.3 ether, "WETH deposit mismatch");

        _setVaultPolicy(WETH, 0.2 ether);
        uint256 recipientBefore = IERC20ForkToken(WETH).balanceOf(RECIPIENT);
        _execute(WETH, 0, abi.encodeCall(IERC20ForkToken.transfer, (RECIPIENT, 0.15 ether)));

        assertEq(IERC20ForkToken(WETH).balanceOf(RECIPIENT) - recipientBefore, 0.15 ether, "WETH transfer mismatch");
        assertEq(_vaultSpent(WETH), 0.15 ether, "WETH vault spend mismatch");

        vm.expectRevert(VaultHook.LimitExceeded.selector);
        _execute(WETH, 0, abi.encodeCall(IERC20ForkToken.transfer, (RECIPIENT, 0.06 ether)));
        assertEq(IERC20ForkToken(WETH).balanceOf(RECIPIENT) - recipientBefore, 0.15 ether, "rejection moved WETH");
        assertEq(_vaultSpent(WETH), 0.15 ether, "rejection changed WETH spend");
    }

    function testForkSdaiSharesUseCanonicalVaultTransferSemantics() public {
        _requireFork();
        _fundFromHolder(DAI, 100e18);

        _execute(DAI, 0, abi.encodeCall(IERC20ForkToken.approve, (SDAI, 100e18)));
        _execute(SDAI, 0, abi.encodeCall(IERC4626ForkToken.deposit, (100e18, address(account))));
        uint256 shares = IERC20ForkToken(SDAI).balanceOf(address(account));
        assertGt(shares, 0, "sDAI deposit minted no shares");
        assertLe(shares, type(uint128).max, "sDAI fixture exceeds vault amount range");

        // Safe after checking the pinned fixture balance fits the vault's uint128 policy range.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 dailyLimit = uint128(shares / 2);
        uint256 firstTransfer = shares / 3;
        _setVaultPolicy(SDAI, dailyLimit);
        uint256 recipientBefore = IERC20ForkToken(SDAI).balanceOf(RECIPIENT);
        _execute(SDAI, 0, abi.encodeCall(IERC20ForkToken.transfer, (RECIPIENT, firstTransfer)));

        assertEq(
            IERC20ForkToken(SDAI).balanceOf(RECIPIENT) - recipientBefore, firstTransfer, "sDAI share transfer mismatch"
        );
        assertEq(_vaultSpent(SDAI), firstTransfer, "sDAI vault spend mismatch");

        uint256 rejectedTransfer = uint256(dailyLimit) - firstTransfer + 1;
        vm.expectRevert(VaultHook.LimitExceeded.selector);
        _execute(SDAI, 0, abi.encodeCall(IERC20ForkToken.transfer, (RECIPIENT, rejectedTransfer)));
        assertEq(
            IERC20ForkToken(SDAI).balanceOf(RECIPIENT) - recipientBefore, firstTransfer, "rejection moved sDAI shares"
        );
        assertEq(_vaultSpent(SDAI), firstTransfer, "rejection changed sDAI spend");
    }

    function _assertPolicyTransfer(address token, uint256 amount, uint128 limit) internal {
        _fundFromHolder(token, uint256(limit) * 2);
        _setPolicy(token, limit);
        uint256 accountBefore = IERC20ForkToken(token).balanceOf(address(account));
        uint256 recipientBefore = IERC20ForkToken(token).balanceOf(RECIPIENT);

        _execute(token, 0, abi.encodeCall(IERC20ForkToken.transfer, (RECIPIENT, amount)));
        assertEq(accountBefore - IERC20ForkToken(token).balanceOf(address(account)), amount, "account debit mismatch");
        assertEq(IERC20ForkToken(token).balanceOf(RECIPIENT) - recipientBefore, amount, "recipient credit mismatch");
        assertEq(_policySpent(token), amount, "policy spend mismatch");

        uint256 rejectedTransfer = uint256(limit) - amount + 1;
        vm.expectRevert(PolicyHook.LimitExceeded.selector);
        _execute(token, 0, abi.encodeCall(IERC20ForkToken.transfer, (RECIPIENT, rejectedTransfer)));
        assertEq(
            accountBefore - IERC20ForkToken(token).balanceOf(address(account)), amount, "rejection debited account"
        );
        assertEq(IERC20ForkToken(token).balanceOf(RECIPIENT) - recipientBefore, amount, "rejection credited recipient");
        assertEq(_policySpent(token), amount, "rejection changed policy spend");
    }

    function _setPolicy(address token, uint128 limit) internal {
        PolicyHook.Policy memory policy = PolicyHook.Policy(limit, limit, 1 days, RECIPIENT, true);
        bytes memory data = abi.encodeCall(PolicyHook.setPolicy, (token, IERC20ForkToken.transfer.selector, policy));
        _schedule(address(policyHook), data);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(policyHook), 0, data);
    }

    function _setVaultPolicy(address token, uint128 dailyLimit) internal {
        VaultHook.VaultPolicy memory policy = VaultHook.VaultPolicy(dailyLimit, 1 days, 2 days, true);
        bytes memory data = abi.encodeCall(VaultHook.setVaultPolicy, (token, policy));
        _schedule(address(vaultHook), data);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(vaultHook), 0, data);
    }

    function _schedule(address target, bytes memory data) internal {
        bytes memory schedule = abi.encodeCall(LoomAccount.scheduleCall, (target, 0, data, account.MIN_CONFIG_DELAY()));
        _execute(address(account), 0, schedule);
    }

    function _execute(address target, uint256 value, bytes memory data) internal {
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(target, value, data)));
    }

    function _fundFromHolder(address token, uint256 amount) internal {
        assertGe(IERC20ForkToken(token).balanceOf(TOKEN_HOLDER), amount, "pinned holder balance too low");
        vm.prank(TOKEN_HOLDER);
        (bool success, bytes memory returnData) =
            token.call(abi.encodeCall(IERC20ForkToken.transfer, (address(account), amount)));
        assertTrue(success, "pinned holder transfer reverted");
        if (returnData.length != 0) {
            assertTrue(abi.decode(returnData, (bool)), "pinned holder transfer returned false");
        }
        assertEq(IERC20ForkToken(token).balanceOf(address(account)), amount, "fixture funding mismatch");
    }

    function _policySpent(address token) internal view returns (uint128 amount) {
        (amount,) = policyHook.spending(address(account), policyHook.policyId(token, IERC20ForkToken.transfer.selector));
    }

    function _vaultSpent(address token) internal view returns (uint128 amount) {
        (amount,) = vaultHook.spending(address(account), token);
    }

    function _tokens() internal pure returns (address[] memory tokens) {
        tokens = new address[](5);
        tokens[0] = USDC;
        tokens[1] = USDT;
        tokens[2] = WETH;
        tokens[3] = DAI;
        tokens[4] = SDAI;
    }

    function _requireFork() internal {
        if (!forkActive) vm.skip(true);
    }
}
