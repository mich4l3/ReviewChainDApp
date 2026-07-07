// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";
import {NullifierRegistry} from "./NullifierRegistry.sol";
import {VendorRegistry} from "./VendorRegistry.sol";
import {ReputationToken} from "./ReputationToken.sol";
import {FixedPointMath} from "./FixedPointMath.sol";

/// @title ReviewContract
/// @notice Core application logic of the TechRate protocol: review
///         submission/modification/revocation (WP2 S2.3-S2.4), the
///         Vendor Reply mechanism (S2.4), Utility Voting and
///         Proof-of-Curation (S2.6), seller/product reputation
///         aggregation (S2.6), and the Burn-to-Redeem mechanism (S2.6).
contract ReviewContract {
    //così uint256 può "nativamente" chiamare la funzione di FixedPointMath
    using FixedPointMath for uint256;

    // ------------------------------------------------------------------
    // External contracts
    // ------------------------------------------------------------------
    IdentityRegistry public immutable identityRegistry;
    NullifierRegistry public immutable nullifierRegistry;
    VendorRegistry public immutable vendorRegistry;
    ReputationToken public immutable reputationToken;

    address public owner;

    // ------------------------------------------------------------------
    // Protocol parameters (WP2 S2.6: "defined at contract deployment time")
    // ------------------------------------------------------------------
    uint256 public constant WELCOME_TOKEN_AMOUNT = 1e18; // 1 token, Step 4.6
    uint256 public constant INITIAL_REPUTATION = 1;      // R0 = 1, S2.6
    uint256 public constant CURATION_WINDOW = 30 days;
    uint256 public constant MODIFICATION_WINDOW = 3 hours;

    uint256 public deltaPlus;          // Delta+ (reputation reward)
    uint256 public deltaMinus;         // Delta- (reputation penalty), must exceed deltaPlus
    uint256 public thetaFixedPoint;    // theta consensus-distance threshold, scaled 1e18
    uint256 public kScaling;           // k, token-issuance scaling factor
    uint256 public redemptionThreshold; // T_min, Burn-to-Redeem minimum balance

    // ------------------------------------------------------------------
    // Proof of Purchase presentation (WP2 S2.3 Step 4.3, selective disclosure)
    // ------------------------------------------------------------------

    /// @notice The claims the smart contract needs from an SD-JWT
    ///         presentation, plus the (v, r, s) ECDSA (ES256K) signature
    ///         over their canonical hash.
    /// @dev `sdDigests` carries the `_sd` array of commitments for the
    ///      undisclosed claims (shipping address, payment amount, ...).
    ///      Their content is never interpreted on-chain; they are folded
    ///      into the signed hash purely so that tampering with them
    ///      (Check 3, "SD-JWT Integrity Verification") is detectable.
    struct SDJWTPresentation {
        address issuerWallet;
        address userWalletAddress;
        bytes32 productIdHash;
        bytes32 nullifier;
        bytes32[] sdDigests;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    // ------------------------------------------------------------------
    // Review state (WP2 S2.3-S2.4)
    // ------------------------------------------------------------------
    struct Review {
        address reviewer;
        bytes32 productIdHash;
        address vendor;              // resolved from VendorRegistry at submission time
        string cid;                  // current IPFS CID (Table 2.1)
        uint8 score;                 // 1-5
        uint64 submittedAt;
        uint64 windowStart;          // resets on modification (S2.4, "re-enters the curation queue")
        bool modified;
        bool revoked;
        bool curationClosed;
        bool includedInAggregation;
        uint256 upvoteWeight;        // fixed point 1e18
        uint256 downvoteWeight;      // fixed point 1e18
        uint256 reputationAtSubmission; // W_i for reputation aggregation (S2.6)
    }

    //uint256 qui è il reviewID
    mapping(uint256 => Review) public reviews;
    uint256 public reviewCount;


    //facciamo cidHash perchè cid 46byte e dovrebbe altrimenti essere dichiarato come stringa,
    //e ciò porta a un maggior consumo di gas
    /// @dev cidHash = keccak256(bytes(cid)) -> reviewId, and its inverse
    ///      mapping "reviewToProduct" used by the Vendor Reply check.

    //bytes32 qui fa riferimento a cidHash
    mapping(bytes32 => uint256) public reviewIdOfCid;
    mapping(bytes32 => bytes32) public reviewToProduct;
    mapping(bytes32 => bool) public hasVendorReplied;

    // ------------------------------------------------------------------
    // Voting state (WP2 S2.6)
    // ------------------------------------------------------------------
    struct VoteRecord {
        address voter;
        bool useful;
        uint256 weight; // snapshot of W at cast time, fixed point 1e18
    }

    mapping(uint256 => VoteRecord[]) private _reviewVotes;
    mapping(bytes32 => bool) private _hasVoted; // keccak256(voter, reviewId)
    //È il meccanismo anti-doppio-voto. Invece di scorrere l'array di cui sopra 
    //per vedere se un utente ha già votato (che costerebbe troppo gas), il contratto 
    //genera al volo questa chiave composita. Se il valore è true, blocca il voto.




    // ------------------------------------------------------------------
    // Registration and reputation (WP2 S2.3 Step 4.6; S2.6)
    // ------------------------------------------------------------------
    mapping(address => bool) public registered;
    mapping(address => uint256) public reputationScore; // R, plain integer

    // ------------------------------------------------------------------
    // Seller / product reputation aggregation (WP2 S2.6)
    // ------------------------------------------------------------------
    mapping(address => uint256) public vendorScoreSum;   // sum(S_i * W_i)
    mapping(address => uint256) public vendorWeightSum;  // sum(W_i)
    mapping(bytes32 => uint256) public productScoreSum;  // by productIdHash(bytes32)
    mapping(bytes32 => uint256) public productWeightSum;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event UserRegistered(address indexed user);
    event ReviewSubmitted(
        uint256 indexed reviewId,
        address indexed reviewerAddress,
        string productID,
        uint8 score,
        string cid,
        uint256 timestamp); // Table 2.1 fields
    event ReviewModified(uint256 indexed reviewId, string oldCid, string newCid);
    event ReviewRevoked(uint256 indexed reviewId);
    event VendorReplySubmitted(bytes32 indexed reviewCidHash, string replyCid, address indexed vendorAddress);
    event VoteCast(uint256 indexed reviewId, address indexed voter, bool useful, uint256 weight);
    event CurationFinalized(uint256 indexed reviewId, uint256 consensus, uint256 upvoteWeight, uint256 downvoteWeight);
    event TokensRedeemed(address indexed user, address indexed platform, uint256 amount);
    event ReviewerRewarded(uint256 indexed reviewId, address indexed reviewer, uint256 tokens);


    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error NotOwner();
    error InvalidScore();
    error WalletBindingMismatch();
    error SignatureIssuerMismatch();
    error UntrustedIssuer();
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

    constructor(
        address identityRegistry_,
        address nullifierRegistry_,
        address vendorRegistry_,
        address reputationToken_,
        uint256 deltaPlus_,
        uint256 deltaMinus_,
        uint256 thetaFixedPoint_,
        uint256 kScaling_,
        uint256 redemptionThreshold_
    ) {
        if (deltaMinus_ <= deltaPlus_) revert AsymmetryRequired();

        owner = msg.sender;
        identityRegistry = IdentityRegistry(identityRegistry_);
        nullifierRegistry = NullifierRegistry(nullifierRegistry_);
        vendorRegistry = VendorRegistry(vendorRegistry_);
        reputationToken = ReputationToken(reputationToken_);

        deltaPlus = deltaPlus_;
        deltaMinus = deltaMinus_;
        thetaFixedPoint = thetaFixedPoint_;
        kScaling = kScaling_;
        redemptionThreshold = redemptionThreshold_;
    }

    /// @notice Recalibrates the curation incentive parameters (WP2 S2.6).
    ///         Deliberately re-enforces Delta- > Delta+ on every update,
    ///         since that asymmetry is the whole basis of the anti-farming
    ///         argument in WP3 S3.3.5.
    function setCurationParameters(
        uint256 deltaPlus_,
        uint256 deltaMinus_,
        uint256 thetaFixedPoint_,
        uint256 kScaling_
    ) external onlyOwner {
        if (deltaMinus_ <= deltaPlus_) revert AsymmetryRequired();
        deltaPlus = deltaPlus_;
        deltaMinus = deltaMinus_;
        thetaFixedPoint = thetaFixedPoint_;
        kScaling = kScaling_;
    }

    function setRedemptionThreshold(uint256 redemptionThreshold_) external onlyOwner {
        redemptionThreshold = redemptionThreshold_;
    }

    // ------------------------------------------------------------------
    // Internal: PoP verification (WP2 S2.3 Step 4.5, Checks 1-3)
    // ------------------------------------------------------------------

    /// @dev Recomputes the canonical hash the issuer must have signed and
    ///      recovers the signer via `ecrecover`. Combines:
    ///        - Check 1 (Issuer Authentication): recovered address must be
    ///          a registered issuer (IdentityRegistry.isIssuer);
    ///        - Check 2 (Wallet Binding): userWalletAddress == msg.sender;
    ///        - Check 3 (SD-JWT Integrity): any tampering with the
    ///          disclosed fields or the `_sd` digest array changes the
    ///          hash and breaks recovery, so integrity is enforced for
    ///          free by the signature check itself.
    ///
    ///      NOTE on the "ecrecover v parameter" gap flagged during WP2
    ///      design: standard JOSE ES256K signatures carry only (r, s),
    ///      not a recovery id. The off-chain issuer/backend is therefore
    ///      responsible for computing the correct v in {27, 28} (by
    ///      testing both candidates against its own known address) before
    ///      handing the presentation to the user's wallet. This contract
    ///      only consumes the already-resolved (v, r, s).
    function _verifyPresentation(SDJWTPresentation calldata p) internal view {
        if (p.userWalletAddress != msg.sender) revert WalletBindingMismatch(); // Check 2

        bytes32 h = keccak256(
            abi.encode(p.userWalletAddress, p.productIdHash, p.nullifier, p.sdDigests)
        );
        address recovered = ecrecover(h, p.v, p.r, p.s);
        if (recovered != p.issuerWallet) revert SignatureIssuerMismatch(); // Check 3
        if (!identityRegistry.isIssuer(p.issuerWallet)) revert UntrustedIssuer(); // Check 1
    }

    function _registerIfNeeded(address user) internal {
        if (!registered[user]) {
            registered[user] = true;
            reputationScore[user] = INITIAL_REPUTATION;
            reputationToken.mint(user, WELCOME_TOKEN_AMOUNT);
            emit UserRegistered(user);
        }
    }

    // ------------------------------------------------------------------
    // Review submission (WP2 S2.3, Steps 4.2-4.7)
    // ------------------------------------------------------------------

    /// @param pop        The verified Proof-of-Purchase presentation.
    /// @param productID  Human-readable productID; must hash to
    ///                    pop.productIdHash (kept off-chain in the PoP as
    ///                    just a hash, but needed here in full for
    ///                    Table 2.1's emitted metadata and for
    ///                    vendor/product reputation bookkeeping).
    /// @param cid         IPFS Content Identifier of the review JSON
    ///                    (Step 4.2).
    /// @param score       Numerical rating in [1, 5].
    function submitReview(
        SDJWTPresentation calldata pop,
        string calldata productID,
        string calldata cid,
        uint8 score
    ) external returns (uint256 reviewId) {
        if (score < 1 || score > 5) revert InvalidScore();
        if (keccak256(bytes(productID)) != pop.productIdHash) revert ProductIdMismatch(productID);

        _verifyPresentation(pop);

        // Check 4: Cross-Platform Nullifier Verification. `spend` itself
        // reverts on reuse, which is the mechanism that stops a replay
        // attempt from a malicious user (WP3 S3.3).
        nullifierRegistry.spend(pop.nullifier);

        // Step 4.6: Lazy Registration and Welcome Token Minting.
        _registerIfNeeded(msg.sender);

        // vendor may be address(0) if the product was never registered in
        // VendorRegistry; the review is still accepted (WP2 does not make
        // vendor pre-registration a precondition for review eligibility),
        // but it can then never contribute to a vendor's aggregate score
        // nor receive a vendor reply.
        address vendor = vendorRegistry.vendorOfProduct(pop.productIdHash);

        reviewCount++;
        reviewId = reviewCount;

        reviews[reviewId] = Review({
            reviewer: msg.sender,
            productIdHash: pop.productIdHash,
            vendor: vendor,
            cid: cid,
            score: score,
            submittedAt: uint64(block.timestamp),
            windowStart: uint64(block.timestamp),
            modified: false,
            revoked: false,
            curationClosed: false,
            includedInAggregation: false,
            upvoteWeight: 0,
            downvoteWeight: 0,
            reputationAtSubmission: reputationScore[msg.sender]
        });

        bytes32 cidHash = keccak256(bytes(cid));
        reviewIdOfCid[cidHash] = reviewId;
        reviewToProduct[cidHash] = pop.productIdHash;

        emit ReviewSubmitted(reviewId, msg.sender, productID, score, cid, block.timestamp);
    }

    // ------------------------------------------------------------------
    // Review modification (WP2 S2.4, "Modification")
    // ------------------------------------------------------------------
    function modifyReview(uint256 reviewId, string calldata newCid) external {
        Review storage rv = reviews[reviewId];
        if (rv.reviewer == address(0)) revert UnknownReview();
        if (rv.reviewer != msg.sender) revert NotReviewer();
        if (rv.revoked) revert ReviewAlreadyRevoked();
        if (block.timestamp > rv.submittedAt + MODIFICATION_WINDOW) revert ModificationWindowElapsed();
        if (rv.modified) revert ModificationLimitReached();

        //al momento la recensione non fa ancora media
        if (rv.includedInAggregation) {
            _excludeFromAggregation(rv);
        }

        string memory oldCid = rv.cid;
        rv.cid = newCid;
        rv.modified = true;  // enforces the once-only modification limit (WP2 S2.4)
        rv.windowStart = uint64(block.timestamp); // "reintroduces the review into the curation queue as new content"
        rv.upvoteWeight = 0;
        rv.downvoteWeight = 0;
        rv.curationClosed = false;

        bytes32 newCidHash = keccak256(bytes(newCid));
        reviewIdOfCid[newCidHash] = reviewId;
        reviewToProduct[newCidHash] = rv.productIdHash;

        //non salviamo vecchio cid in una struttura ma facciamo emissione evento
        emit ReviewModified(reviewId, oldCid, newCid);
    }

    // ------------------------------------------------------------------
    // Review revocation (WP2 S2.4, "Revocation")
    // ------------------------------------------------------------------
    function revokeReview(uint256 reviewId) external {
        Review storage rv = reviews[reviewId];
        if (rv.reviewer == address(0)) revert UnknownReview();
        if (rv.reviewer != msg.sender) revert NotReviewer();
        if (rv.revoked) revert ReviewAlreadyRevoked();

        if (rv.includedInAggregation) {
            _excludeFromAggregation(rv);
        }
        rv.revoked = true;

        emit ReviewRevoked(reviewId);
    }

    // ------------------------------------------------------------------
    // Vendor Reply (WP2 S2.4, "Vendor Reply Mechanism")
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
    // Utility Voting (WP2 S2.6, "Voting eligibility and submission")
    // ------------------------------------------------------------------

    /// @dev Voting deliberately does NOT consume the PoP's nullifier via
    ///      NullifierRegistry.spend(). WP2 S2.6 protects against
    ///      double-voting through the independent `_hasVoted` mapping
    ///      below, not through nullifier consumption: the nullifier here
    ///      only serves to prove product ownership within `pop`, and the
    ///      same underlying PoP may already be "spent" from the holder's
    ///      own prior review submission.
    function voteOnReview(uint256 reviewId, SDJWTPresentation calldata pop, bool useful) external {
        Review storage rv = reviews[reviewId];
        if (rv.reviewer == address(0)) revert UnknownReview();
        if (rv.revoked) revert ReviewAlreadyRevoked();
        if (rv.curationClosed) revert ReviewClosed();

        _verifyPresentation(pop);
        // Voting eligibility: the voter's PoP must be for the exact
        // product the target review is about.
        if (pop.productIdHash != rv.productIdHash) revert ProductIdMismatch("");

        bytes32 voteKey = keccak256(abi.encodePacked(msg.sender, reviewId));
        if (_hasVoted[voteKey]) revert AlreadyVoted();
        _hasVoted[voteKey] = true;

        _registerIfNeeded(msg.sender);

        uint256 weight = FixedPointMath.ln1p(reputationScore[msg.sender]);
        //avendo usato using in alternativa potremmo scrivere:
        //uint256 weight = reputationScore[msg.sender].ln1p();

        if (useful) {
            rv.upvoteWeight += weight;
        } else {
            rv.downvoteWeight += weight;
        }

        _reviewVotes[reviewId].push(VoteRecord({voter: msg.sender, useful: useful, weight: weight}));

        emit VoteCast(reviewId, msg.sender, useful, weight);
    }

     // ------------------------------------------------------------------
    // Curation window closure and reputation update (WP2 S2.6)
    // ------------------------------------------------------------------
    function finalizeCuration(uint256 reviewId) external {
        Review storage rv = reviews[reviewId];
        if (rv.reviewer == address(0)) revert UnknownReview();
        if (rv.curationClosed) revert AlreadyFinalized();
        if (block.timestamp < rv.windowStart + CURATION_WINDOW) revert CurationWindowStillOpen();

        uint256 totalWeight = rv.upvoteWeight + rv.downvoteWeight;
        // C = U / (U + D), fixed point 1e18. If nobody voted, C stays 0
        // and the review is simply excluded below (visibility_score = 0).
        uint256 consensus = totalWeight == 0 ? 0 : (rv.upvoteWeight * 1e18) / totalWeight;

        VoteRecord[] storage votes = _reviewVotes[reviewId];
        for (uint256 i = 0; i < votes.length; i++) {
            VoteRecord storage vr = votes[i];
            uint256 vi = vr.useful ? 1e18 : 0;
            uint256 diff = vi > consensus ? vi - consensus : consensus - vi;

            if (diff < thetaFixedPoint) {
                reputationScore[vr.voter] += deltaPlus;
                uint256 tokens = (deltaPlus * reputationScore[vr.voter] * kScaling) / 1e18;
                if (tokens > 0) {
                    reputationToken.mint(vr.voter, tokens);
                }
            } else {
                // No tokens minted for discordant voters (WP2 S2.6).
                if (reputationScore[vr.voter] > deltaMinus) {
                    reputationScore[vr.voter] -= deltaMinus;
                } else {
                    reputationScore[vr.voter] = 0;
                }
            }
        }

        rv.curationClosed = true;

        // visibility_score = upvoteWeight - downvoteWeight; reviews below
        // zero are excluded from seller/product reputation (WP2 S2.6).
        bool qualifies = !rv.revoked && rv.upvoteWeight >= rv.downvoteWeight;
        if (qualifies) {
            _includeInAggregation(rv);

            // Reviewer reward (WP1 S1.4: "generates a second reputation
            // metric associated with reviewers themselves"). Token-only
            // reward -- it does NOT touch reputationScore (R), which
            // stays reserved for curation-alignment behaviour (S2.6) --
            // gated on the same visibility_score >= 0 quality filter used
            // above, and scaled with the same Delta+/k parameters already
            // calibrated for voter rewards rather than introducing a new
            // tunable.
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
    // Seller / product reputation aggregation (WP2 S2.6)
    // ------------------------------------------------------------------

    //scoresum numeratore
    //weightsum denominatore
    function _includeInAggregation(Review storage rv) internal {
        rv.includedInAggregation = true;
        uint256 contribution = uint256(rv.score) * rv.reputationAtSubmission;
        if (rv.vendor != address(0)) {
            vendorScoreSum[rv.vendor] += contribution;
            vendorWeightSum[rv.vendor] += rv.reputationAtSubmission;
        }
        productScoreSum[rv.productIdHash] += contribution;
        productWeightSum[rv.productIdHash] += rv.reputationAtSubmission;
    }

    //used only to revoke and modify
    function _excludeFromAggregation(Review storage rv) internal {
        uint256 contribution = uint256(rv.score) * rv.reputationAtSubmission;
        if (rv.vendor != address(0)) {
            vendorScoreSum[rv.vendor] -= contribution;
            vendorWeightSum[rv.vendor] -= rv.reputationAtSubmission;
        }
        productScoreSum[rv.productIdHash] -= contribution;
        productWeightSum[rv.productIdHash] -= rv.reputationAtSubmission;
        rv.includedInAggregation = false;
    }

    /// @notice R_vendor, fixed point 1e18 (0 if the vendor has no
    ///         qualifying reviews yet).
    function vendorReputation(address vendor) external view returns (uint256) {
        uint256 w = vendorWeightSum[vendor];
        if (w == 0) return 0;
        return (vendorScoreSum[vendor] * 1e18) / w;
    }

    /// @notice R_product, fixed point 1e18 (0 if the product has no
    ///         qualifying reviews yet).
    function productReputation(bytes32 productIdHash) external view returns (uint256) {
        uint256 w = productWeightSum[productIdHash];
        if (w == 0) return 0;
        return (productScoreSum[productIdHash] * 1e18) / w;  //1e18 per evitare il problema dei decimali
    }

    // ------------------------------------------------------------------
    // Burn-to-Redeem (WP2 S2.6)
    // ------------------------------------------------------------------

    /// @notice Burns `amount` tokens to trigger an off-chain discount on
    ///         `platform`. The platform's backend listens for
    ///         `TokensRedeemed`, resolves `msg.sender`'s wallet to its
    ///         Web2 account, and applies the discount idempotently keyed
    ///         on the transaction hash of this call (WP2 S2.6,
    ///         "Off-Chain Discount Resolution") -- the txHash itself is
    ///         not (and cannot be) embedded in the event by the contract
    ///         and is instead read off the transaction receipt by the
    ///         listening backend.
    function redeemTokens(address platform, uint256 amount) external {
        uint256 balance = reputationToken.balanceOf(msg.sender);
        if (balance < redemptionThreshold) revert BalanceBelowThreshold();
        if (amount == 0 || amount > balance) revert InvalidRedemptionAmount();

        reputationToken.burn(msg.sender, amount);
        emit TokensRedeemed(msg.sender, platform, amount);
    }
}
