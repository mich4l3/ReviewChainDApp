// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NullifierRegistry} from "./NullifierRegistry.sol";
import {VendorRegistry}    from "./VendorRegistry.sol";
import {ReputationToken}   from "./ReputationToken.sol";
import {FixedPointMath}    from "./FixedPointMath.sol";
import {DIDRegistry}       from "./DIDRegistry.sol";

/// @title ReviewContract
/// @notice Core application logic of the TechRate protocol: review
///         submission/modification/revocation (WP2 S2.3-S2.4), the
///         Vendor Reply mechanism (S2.4), Utility Voting and
///         Proof-of-Curation (S2.6), seller/product reputation
///         aggregation (S2.6), and the Burn-to-Redeem mechanism (S2.6).
///
/// @dev ARCHITECTURAL NOTE — Off-Chain SD-JWT Verification (WP4):
///      In the original design the smart contract received a raw ECDSA
///      (v, r, s) tuple and called `ecrecover` on-chain to verify the
///      issuer's signature over the Proof of Purchase (SDJWTPresentation).
///      In the current implementation the verification of the SD-JWT
///      (including the issuer's RSA/P-256 signature and selective-disclosure
///      claims) is performed **off-chain** by the DApp backend, which acts
///      as a trusted relayer. Only the relayer is allowed to call
///      `submitReview` and `voteOnReview`; the contract trusts the relayer
///      to have verified the SD-JWT honestly.
///      The nullifier is still spent on-chain (via NullifierRegistry) to
///      guarantee replay-resistance even in the event of a compromised
///      relayer.
///      All actors (reviewers, voters) must have an active DID registered
///      in the DIDRegistry before the contract accepts their participation.
contract ReviewContract {
    using FixedPointMath for uint256;

    // ------------------------------------------------------------------
    // External contracts
    // ------------------------------------------------------------------
    NullifierRegistry public immutable nullifierRegistry;
    VendorRegistry    public immutable vendorRegistry;
    ReputationToken   public immutable reputationToken;
    DIDRegistry       public immutable didRegistry;

    address public owner;

    /// @notice The DApp backend wallet authorised to relay review
    ///         submissions and votes after verifying the SD-JWT off-chain.
    address public trustedRelayer;

    // ------------------------------------------------------------------
    // Protocol parameters (WP2 S2.6)
    // ------------------------------------------------------------------
    uint256 public constant WELCOME_TOKEN_AMOUNT = 1e18;
    uint256 public constant INITIAL_REPUTATION   = 1;
    uint256 public constant CURATION_WINDOW      = 30 days;
    uint256 public constant MODIFICATION_WINDOW  = 3 hours;

    uint256 public deltaPlus;
    uint256 public deltaMinus;
    uint256 public thetaFixedPoint;
    uint256 public kScaling;
    uint256 public redemptionThreshold;

    // ------------------------------------------------------------------
    // Review state (WP2 S2.3-S2.4)
    // ------------------------------------------------------------------
    struct Review {
        address reviewer;
        bytes32 productIdHash;
        address vendor;
        string  cid;
        uint8   score;
        uint64  submittedAt;
        uint64  windowStart;
        bool    modified;
        bool    revoked;
        bool    curationClosed;
        bool    includedInAggregation;
        uint256 upvoteWeight;
        uint256 downvoteWeight;
        uint256 reputationAtSubmission;
    }

    mapping(uint256 => Review) public reviews;
    uint256 public reviewCount;

    mapping(bytes32 => uint256) public reviewIdOfCid;
    mapping(bytes32 => bytes32) public reviewToProduct;
    mapping(bytes32 => bool)    public hasVendorReplied;

    // ------------------------------------------------------------------
    // Voting state (WP2 S2.6)
    // ------------------------------------------------------------------
    struct VoteRecord {
        address voter;
        bool    useful;
        uint256 weight;
    }

    mapping(uint256 => VoteRecord[]) private _reviewVotes;
    mapping(bytes32 => bool)         private _hasVoted;

    // ------------------------------------------------------------------
    // Registration and reputation (WP2 S2.3, S2.6)
    // ------------------------------------------------------------------
    mapping(address => bool)    public registered;
    mapping(address => uint256) public reputationScore;

    // ------------------------------------------------------------------
    // Seller / product reputation aggregation (WP2 S2.6)
    // ------------------------------------------------------------------
    mapping(address => uint256) public vendorScoreSum;
    mapping(address => uint256) public vendorWeightSum;
    mapping(bytes32 => uint256) public productScoreSum;
    mapping(bytes32 => uint256) public productWeightSum;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event UserRegistered(address indexed user);
    event ReviewSubmitted(
        uint256 indexed reviewId,
        address indexed reviewerAddress,
        string  productID,
        uint8   score,
        string  cid,
        uint256 timestamp
    );
    event ReviewModified(uint256 indexed reviewId, string oldCid, string newCid);
    event ReviewRevoked(uint256 indexed reviewId);
    event VendorReplySubmitted(bytes32 indexed reviewCidHash, string replyCid, address indexed vendorAddress);
    event VoteCast(uint256 indexed reviewId, address indexed voter, bool useful, uint256 weight);
    event CurationFinalized(uint256 indexed reviewId, uint256 consensus, uint256 upvoteWeight, uint256 downvoteWeight);
    event TokensRedeemed(address indexed user, address indexed platform, uint256 amount);
    event ReviewerRewarded(uint256 indexed reviewId, address indexed reviewer, uint256 tokens);
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error NotOwner();
    error NotRelayer();
    error DIDNotActive();
    error InvalidScore();
    error ProductIdMismatch(string productID);
    error UnknownReview();
    error NotReviewer();
    error ReviewAlreadyRevoked();
    error ModificationWindowElapsed();
    error ModificationLimitReached();
    error NotAnAuthorizedVendor();
    error NotProductOwner();
    error AlreadyReplied();
    error ReviewClosed();
    error AlreadyVoted();
    error AlreadyFinalized();
    error CurationWindowStillOpen();
    error AsymmetryRequired();
    error BalanceBelowThreshold();
    error InvalidRedemptionAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Only the trusted DApp relayer may call `submitReview` and
    ///      `voteOnReview`. This enforces that SD-JWT verification has
    ///      been performed off-chain before any on-chain state change.
    modifier onlyRelayer() {
        if (msg.sender != trustedRelayer) revert NotRelayer();
        _;
    }

    constructor(
        address nullifierRegistry_,
        address vendorRegistry_,
        address reputationToken_,
        address didRegistry_,
        address trustedRelayer_,
        uint256 deltaPlus_,
        uint256 deltaMinus_,
        uint256 thetaFixedPoint_,
        uint256 kScaling_,
        uint256 redemptionThreshold_
    ) {
        if (deltaMinus_ <= deltaPlus_) revert AsymmetryRequired();

        owner          = msg.sender;
        nullifierRegistry = NullifierRegistry(nullifierRegistry_);
        vendorRegistry    = VendorRegistry(vendorRegistry_);
        reputationToken   = ReputationToken(reputationToken_);
        didRegistry       = DIDRegistry(didRegistry_);
        trustedRelayer    = trustedRelayer_;

        deltaPlus          = deltaPlus_;
        deltaMinus         = deltaMinus_;
        thetaFixedPoint    = thetaFixedPoint_;
        kScaling           = kScaling_;
        redemptionThreshold = redemptionThreshold_;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setCurationParameters(
        uint256 deltaPlus_,
        uint256 deltaMinus_,
        uint256 thetaFixedPoint_,
        uint256 kScaling_
    ) external onlyOwner {
        if (deltaMinus_ <= deltaPlus_) revert AsymmetryRequired();
        deltaPlus       = deltaPlus_;
        deltaMinus      = deltaMinus_;
        thetaFixedPoint = thetaFixedPoint_;
        kScaling        = kScaling_;
    }

    function setRedemptionThreshold(uint256 redemptionThreshold_) external onlyOwner {
        redemptionThreshold = redemptionThreshold_;
    }

    /// @notice Allows the owner to rotate the trusted relayer address
    ///         (e.g. in case of a backend key compromise).
    function setTrustedRelayer(address newRelayer) external onlyOwner {
        emit RelayerUpdated(trustedRelayer, newRelayer);
        trustedRelayer = newRelayer;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    function _registerIfNeeded(address user) internal {
        if (!registered[user]) {
            registered[user]       = true;
            reputationScore[user]  = INITIAL_REPUTATION;
            reputationToken.mint(user, WELCOME_TOKEN_AMOUNT);
            emit UserRegistered(user);
        }
    }

    // ------------------------------------------------------------------
    // Review submission (WP2 S2.3)
    // ------------------------------------------------------------------

    /// @notice Submit a new review on behalf of `reviewer`.
    ///         Must be called by the trusted DApp relayer after verifying
    ///         the reviewer's SD-JWT Proof of Purchase off-chain.
    ///
    /// @param reviewer   Ethereum address of the reviewer (extracted from
    ///                   the SD-JWT by the relayer).
    /// @param productID  Human-readable product identifier.
    /// @param cid        IPFS Content Identifier of the review JSON.
    /// @param score      Numerical rating in [1, 5].
    /// @param nullifier  Anti-replay nullifier extracted from the SD-JWT.
    ///                   Spent on-chain to prevent the same PoP being
    ///                   reused even by a compromised relayer.
    function submitReview(
        address        reviewer,
        string calldata productID,
        string calldata cid,
        uint8           score,
        bytes32         nullifier
    ) external onlyRelayer returns (uint256 reviewId) {
        if (score < 1 || score > 5) revert InvalidScore();

        // DID check: the reviewer must have an active registered DID.
        if (!didRegistry.isActiveByOwner(reviewer)) revert DIDNotActive();

        // Anti-replay: burn the nullifier on-chain regardless of relayer honesty.
        nullifierRegistry.spend(nullifier);

        _registerIfNeeded(reviewer);

        bytes32 productIdHash = keccak256(bytes(productID));
        address vendor        = vendorRegistry.vendorOfProduct(productIdHash);

        reviewCount++;
        reviewId = reviewCount;

        reviews[reviewId] = Review({
            reviewer:              reviewer,
            productIdHash:         productIdHash,
            vendor:                vendor,
            cid:                   cid,
            score:                 score,
            submittedAt:           uint64(block.timestamp),
            windowStart:           uint64(block.timestamp),
            modified:              false,
            revoked:               false,
            curationClosed:        false,
            includedInAggregation: false,
            upvoteWeight:          0,
            downvoteWeight:        0,
            reputationAtSubmission: reputationScore[reviewer]
        });

        bytes32 cidHash = keccak256(bytes(cid));
        reviewIdOfCid[cidHash]   = reviewId;
        reviewToProduct[cidHash] = productIdHash;

        emit ReviewSubmitted(reviewId, reviewer, productID, score, cid, block.timestamp);
    }

    // ------------------------------------------------------------------
    // Review modification (WP2 S2.4)
    // ------------------------------------------------------------------

    /// @notice The reviewer calls this directly (no new SD-JWT needed).
    function modifyReview(uint256 reviewId, string calldata newCid) external {
        Review storage rv = reviews[reviewId];
        if (rv.reviewer == address(0))                           revert UnknownReview();
        if (rv.reviewer != msg.sender)                           revert NotReviewer();
        if (rv.revoked)                                          revert ReviewAlreadyRevoked();
        if (block.timestamp > rv.submittedAt + MODIFICATION_WINDOW) revert ModificationWindowElapsed();
        if (rv.modified)                                         revert ModificationLimitReached();

        if (rv.includedInAggregation) {
            _excludeFromAggregation(rv);
        }

        string memory oldCid = rv.cid;
        rv.cid         = newCid;
        rv.modified    = true;
        rv.windowStart = uint64(block.timestamp);
        rv.upvoteWeight   = 0;
        rv.downvoteWeight = 0;
        rv.curationClosed = false;

        bytes32 newCidHash = keccak256(bytes(newCid));
        reviewIdOfCid[newCidHash]   = reviewId;
        reviewToProduct[newCidHash] = rv.productIdHash;

        emit ReviewModified(reviewId, oldCid, newCid);
    }

    // ------------------------------------------------------------------
    // Review revocation (WP2 S2.4)
    // ------------------------------------------------------------------

    /// @notice The reviewer calls this directly.
    function revokeReview(uint256 reviewId) external {
        Review storage rv = reviews[reviewId];
        if (rv.reviewer == address(0)) revert UnknownReview();
        if (rv.reviewer != msg.sender) revert NotReviewer();
        if (rv.revoked)                revert ReviewAlreadyRevoked();

        if (rv.includedInAggregation) {
            _excludeFromAggregation(rv);
        }
        rv.revoked = true;

        emit ReviewRevoked(reviewId);
    }

    // ------------------------------------------------------------------
    // Vendor Reply (WP2 S2.4)
    // ------------------------------------------------------------------

    function submitVendorReply(string calldata reviewCid, string calldata replyCid) external {
        if (!vendorRegistry.isVendor(msg.sender)) revert NotAnAuthorizedVendor();

        bytes32 reviewCidHash = keccak256(bytes(reviewCid));
        bytes32 productIdHash = reviewToProduct[reviewCidHash];
        if (vendorRegistry.vendorOfProduct(productIdHash) != msg.sender) revert NotProductOwner();
        if (hasVendorReplied[reviewCidHash]) revert AlreadyReplied();

        hasVendorReplied[reviewCidHash] = true;
        emit VendorReplySubmitted(reviewCidHash, replyCid, msg.sender);
    }

    // ------------------------------------------------------------------
    // Utility Voting (WP2 S2.6)
    // ------------------------------------------------------------------

    /// @notice Cast a vote on behalf of `voter`.
    ///         Must be called by the trusted relayer after verifying the
    ///         voter's SD-JWT (proving product ownership) off-chain.
    ///
    /// @param reviewId  The review to vote on.
    /// @param voter     Address of the voter (extracted from SD-JWT).
    /// @param nullifier Anti-replay nullifier from the voter's PoP.
    /// @param useful    true = upvote, false = downvote.
    function voteOnReview(
        uint256 reviewId,
        address voter,
        bytes32 nullifier,
        bool    useful
    ) external onlyRelayer {
        Review storage rv = reviews[reviewId];
        if (rv.reviewer == address(0)) revert UnknownReview();
        if (rv.revoked)                revert ReviewAlreadyRevoked();
        if (rv.curationClosed)         revert ReviewClosed();

        // DID check
        if (!didRegistry.isActiveByOwner(voter)) revert DIDNotActive();

        // Anti-replay nullifier (spent on-chain for safety)
        nullifierRegistry.spend(nullifier);

        bytes32 voteKey = keccak256(abi.encodePacked(voter, reviewId));
        if (_hasVoted[voteKey]) revert AlreadyVoted();
        _hasVoted[voteKey] = true;

        _registerIfNeeded(voter);

        uint256 weight = FixedPointMath.ln1p(reputationScore[voter]);

        if (useful) {
            rv.upvoteWeight += weight;
        } else {
            rv.downvoteWeight += weight;
        }

        _reviewVotes[reviewId].push(VoteRecord({voter: voter, useful: useful, weight: weight}));

        emit VoteCast(reviewId, voter, useful, weight);
    }

    // ------------------------------------------------------------------
    // Curation Finalization (WP2 S2.6)
    // ------------------------------------------------------------------
    function finalizeCuration(uint256 reviewId) external {
        Review storage rv = reviews[reviewId];
        if (rv.reviewer == address(0))                                    revert UnknownReview();
        if (rv.curationClosed)                                            revert AlreadyFinalized();
        if (block.timestamp < rv.windowStart + CURATION_WINDOW)           revert CurationWindowStillOpen();

        uint256 totalWeight = rv.upvoteWeight + rv.downvoteWeight;
        uint256 consensus   = totalWeight == 0 ? 0 : (rv.upvoteWeight * 1e18) / totalWeight;

        VoteRecord[] storage votes = _reviewVotes[reviewId];
        for (uint256 i = 0; i < votes.length; i++) {
            VoteRecord storage vr = votes[i];
            uint256 vi   = vr.useful ? 1e18 : 0;
            uint256 diff = vi > consensus ? vi - consensus : consensus - vi;

            if (diff < thetaFixedPoint) {
                reputationScore[vr.voter] += deltaPlus;
                uint256 tokens = (deltaPlus * reputationScore[vr.voter] * kScaling) / 1e18;
                if (tokens > 0) reputationToken.mint(vr.voter, tokens);
            } else {
                if (reputationScore[vr.voter] > deltaMinus) {
                    reputationScore[vr.voter] -= deltaMinus;
                } else {
                    reputationScore[vr.voter] = 0;
                }
            }
        }

        rv.curationClosed = true;

        bool qualifies = !rv.revoked && rv.upvoteWeight >= rv.downvoteWeight;
        if (qualifies) {
            _includeInAggregation(rv);

            uint256 reviewerTokens = (deltaPlus * reputationScore[rv.reviewer] * kScaling) / 1e18;
            if (reviewerTokens > 0) {
                reputationToken.mint(rv.reviewer, reviewerTokens);
                emit ReviewerRewarded(reviewId, rv.reviewer, reviewerTokens);
            }
        }

        emit CurationFinalized(reviewId, consensus, rv.upvoteWeight, rv.downvoteWeight);
    }

    function visibilityScore(uint256 reviewId) external view returns (int256) {
        Review storage rv = reviews[reviewId];
        return int256(rv.upvoteWeight) - int256(rv.downvoteWeight);
    }

    // ------------------------------------------------------------------
    // Reputation aggregation (WP2 S2.6)
    // ------------------------------------------------------------------
    function _includeInAggregation(Review storage rv) internal {
        rv.includedInAggregation = true;
        uint256 contribution = uint256(rv.score) * rv.reputationAtSubmission;
        if (rv.vendor != address(0)) {
            vendorScoreSum[rv.vendor]  += contribution;
            vendorWeightSum[rv.vendor] += rv.reputationAtSubmission;
        }
        productScoreSum[rv.productIdHash]  += contribution;
        productWeightSum[rv.productIdHash] += rv.reputationAtSubmission;
    }

    function _excludeFromAggregation(Review storage rv) internal {
        uint256 contribution = uint256(rv.score) * rv.reputationAtSubmission;
        if (rv.vendor != address(0)) {
            vendorScoreSum[rv.vendor]  -= contribution;
            vendorWeightSum[rv.vendor] -= rv.reputationAtSubmission;
        }
        productScoreSum[rv.productIdHash]  -= contribution;
        productWeightSum[rv.productIdHash] -= rv.reputationAtSubmission;
        rv.includedInAggregation = false;
    }

    function vendorReputation(address vendor) external view returns (uint256) {
        uint256 w = vendorWeightSum[vendor];
        if (w == 0) return 0;
        return (vendorScoreSum[vendor] * 1e18) / w;
    }

    function productReputation(bytes32 productIdHash) external view returns (uint256) {
        uint256 w = productWeightSum[productIdHash];
        if (w == 0) return 0;
        return (productScoreSum[productIdHash] * 1e18) / w;
    }

    // ------------------------------------------------------------------
    // Burn-to-Redeem (WP2 S2.6)
    // ------------------------------------------------------------------
    function redeemTokens(address platform, uint256 amount) external {
        uint256 balance = reputationToken.balanceOf(msg.sender);
        if (balance < redemptionThreshold)    revert BalanceBelowThreshold();
        if (amount == 0 || amount > balance)  revert InvalidRedemptionAmount();

        reputationToken.burn(msg.sender, amount);
        emit TokensRedeemed(msg.sender, platform, amount);
    }
}
