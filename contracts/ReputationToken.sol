// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReputationToken
/// @notice ERC-20-shaped, strictly non-transferable (Soulbound) token used
///         both for the "Welcome Token" (WP2 S2.3, Step 3.5 / Step 4.6)
///         and for curation-alignment rewards (WP2 S2.6, "Token minting
///         upon finalization"). Both use cases share this single
///         contract: WP2 never distinguishes the Welcome Token and the
///         curation reward as two different asset types, only as two
///         different mint triggers.
/// @dev transfer / transferFrom / approve are permanently disabled
///      (revert), per the SBT definition in WP2 S2.3. mint / burn are
///      restricted to the ReviewContract via `onlyReviewContract`. The
///      contract is deployed standalone, rather than as part of
///      ReviewContract, so that any external observer can verify a
///      balance without touching the main application logic -- the same
///      Public Verifiability rationale behind NullifierRegistry.
contract ReputationToken {
    string public constant name = "ReviewToken";    //come lo chiamiamo sto token?
    string public constant symbol = "RWT";
    uint8 public constant decimals = 18;

    address public owner;
    address public reviewContract;

    mapping(address => uint256) private _balances;
    uint256 private _totalSupply;

    /// @dev Emitted only on mint (from = address(0)) and burn
    ///      (to = address(0)); kept for ERC-20 tooling/indexer compatibility.
    event Transfer(address indexed from, address indexed to, uint256 value);
    event ReviewContractSet(address indexed reviewContract);

    error NotOwner();
    error NotReviewContract();
    error AlreadyInitialized();
    error ZeroAddress();
    error SoulboundTokenNonTransferable();
    error InsufficientBalance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyReviewContract() {
        if (msg.sender != reviewContract) revert NotReviewContract();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setReviewContract(address reviewContract_) external onlyOwner {
        if (reviewContract != address(0)) revert AlreadyInitialized();
        if (reviewContract_ == address(0)) revert ZeroAddress();
        reviewContract = reviewContract_;
        emit ReviewContractSet(reviewContract_);
    }

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    /// @notice Mints `amount` tokens to `to`. Called by ReviewContract for
    ///         both the Welcome Token bonus (Step 4.6) and curation reward
    ///         issuance (S2.6, "Token minting upon finalization").
    function mint(address to, uint256 amount) external onlyReviewContract {
        _balances[to] += amount;
        _totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burns `amount` tokens from `from`. Called by ReviewContract
    ///         as the effect of the Burn-to-Redeem mechanism (WP2 S2.6).
    function burn(address from, uint256 amount) external onlyReviewContract {
        if (_balances[from] < amount) revert InsufficientBalance();
        _balances[from] -= amount;
        _totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    // --- Soulbound: every transfer path is permanently disabled ---
    // we maintain the function definitions just for compatibility

    function transfer(address, uint256) external pure returns (bool) {
        revert SoulboundTokenNonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert SoulboundTokenNonTransferable();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert SoulboundTokenNonTransferable();
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }
}
