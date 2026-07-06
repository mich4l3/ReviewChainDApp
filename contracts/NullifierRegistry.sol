// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NullifierRegistry
/// @notice Tracks consumed Proof-of-Purchase nullifiers to enforce the
///         Double-Submission Prevention property (WP1 S1.6; WP2 S2.3.1,
///         Check 4).
/// @dev Deployed as a standalone contract so its state is inspectable by
///      any third party without going through the main application logic
///      (ReviewContract), consistent with the Public Verifiability and
///      Censorship Resistance functional requirement of WP1 S1.2.
contract NullifierRegistry {
    address public owner;
    address public reviewContract;

    //byte32 qui è l'hash del nullifier
    mapping(bytes32 => bool) private _spent;

    event ReviewContractSet(address indexed reviewContract);
    event NullifierSpent(bytes32 indexed nullifier);

    error NotOwner();
    error NotReviewContract();
    error AlreadyInitialized();
    error ZeroAddress();
    error AlreadySpent(bytes32 nullifier);

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

    /// @notice One-time wiring of the ReviewContract address. Kept out of
    ///         the constructor to avoid a circular deployment dependency
    ///         (ReviewContract needs this contract's address too, and
    ///         vice versa).
    function setReviewContract(address reviewContract_) external onlyOwner {
        if (reviewContract != address(0)) revert AlreadyInitialized();
        if (reviewContract_ == address(0)) revert ZeroAddress();
        reviewContract = reviewContract_;
        emit ReviewContractSet(reviewContract_);
    }

    function isSpent(bytes32 nullifier) external view returns (bool) {
        return _spent[nullifier];
    }

    /// @notice Marks `nullifier` as spent. Called by ReviewContract during
    ///         review submission (WP2 Step 4.5, Check 4). Reverts on reuse,
    ///         which is what causes a replay attempt (WP3 S3.3, "Malicious
    ///         user") to revert the whole transaction.
    function spend(bytes32 nullifier) external onlyReviewContract {
        if (_spent[nullifier]) revert AlreadySpent(nullifier);
        _spent[nullifier] = true;
        emit NullifierSpent(nullifier);
    }
}
