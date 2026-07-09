/**
 * test/reviewchain.test.ts
 *
 * Integration test suite for the TechRate protocol — post-refactoring.
 *
 * Architecture changes vs. previous version:
 *   - SD-JWT verification is now performed OFF-CHAIN by the DApp backend
 *     (simulated here by the `deployer` account acting as trustedRelayer).
 *   - The `SDJWTPresentation` struct and `buildPoP` helper are gone.
 *     `submitReview` and `voteOnReview` now accept plain addresses and
 *     a nullifier; the relayer passes them after verifying the SD-JWT.
 *   - Every reviewer/voter/vendor must have an active DID in DIDRegistry
 *     before the protocol accepts their participation.
 *   - `buildVendorVCSig` is still needed because vendor onboarding
 *     remains an on-chain CA-signature check (not relayed).
 *
 * Covers (WP2):
 *   - S2.3  Review Submission (happy path + expected reverts)
 *   - S2.4  Modification, Revocation, Vendor Reply
 *   - S2.6  Voting, Curation, Rewards, Reputation, Burn-to-Redeem
 *   - DID   Registration, liveness check, post-revocation rejection
 *   - Relayer  Authorization guard (non-relayer calls rejected)
 *
 * Runtime: Hardhat 3 + @nomicfoundation/hardhat-toolbox-viem
 * Run:  npx hardhat test nodejs
 */

import { network } from "hardhat";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodeAbiParameters, parseAbiParameters, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── Protocol parameters ─────────────────────────────────────────────────────
const DELTA_PLUS           = 1n;
const DELTA_MINUS          = 3n;
const THETA_FIXED_POINT    = 5n * 10n ** 17n; // 0.5 WAD
const K_SCALING            = 10n ** 18n;
const REDEMPTION_THRESHOLD = 5n * 10n ** 18n;

// ─── Well-known Hardhat test private keys (for CA / vendor-VC signing) ────────
const CA_PRIVATE_KEY =
  "0xdbda1821b80551c9d65939329250132c444d36cd2edb8c94e48abb0af7e52657" as `0x${string}`;
const caAccount = privateKeyToAccount(CA_PRIVATE_KEY);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Builds a CA signature over the canonical Vendor-VC hash. */
async function buildVendorVCSig(
  vendorWallet: `0x${string}`,
  legalName: string,
  vatNumber: string,
) {
  const encoded = encodeAbiParameters(
    parseAbiParameters("address, string, string"),
    [vendorWallet, legalName, vatNumber],
  );
  const hash = keccak256(encoded);
  const sig  = await caAccount.sign({ hash });
  return {
    v: parseInt(sig.slice(130, 132), 16),
    r: `0x${sig.slice(2, 66)}`   as `0x${string}`,
    s: `0x${sig.slice(66, 130)}` as `0x${string}`,
  };
}

/** Generates a random 32-byte nullifier (simulating the one inside a SD-JWT). */
function randomNullifier(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Simulates the off-chain SD-JWT verification performed by the DApp backend.
 *
 * In production this function would:
 *   1. Decode the compact SD-JWT string.
 *   2. Resolve the Issuer's DID and fetch its public key.
 *   3. Verify the RSA-PSS / ECDSA-P256 signature over the JWT header+payload.
 *   4. Hash each revealed claim with its salt and check it against the `_sd`
 *      array inside the signed payload (selective-disclosure verification).
 *   5. Return the extracted claims (reviewer address, productIdHash, nullifier).
 *
 * For testing purposes we simply return `true` — the relayer "trusts" that
 * the SD-JWT was valid and proceeds to call the smart contract.
 */
async function simulateSDJWTVerification(
  _reviewerAddress: `0x${string}`,
  _productId: string,
  _nullifier: `0x${string}`,
): Promise<boolean> {
  // Off-chain: jose.compactVerify(sdjwt, issuerPublicKey) — omitted in tests
  return true;
}

// ─── Shared constants ────────────────────────────────────────────────────────
const PRODUCT_ID = "LAPTOP-XPS-9510";
const LEGAL_NAME = "TechCo S.r.l.";
const VAT_NUMBER = "IT12345678901";

// ─── DID helper ──────────────────────────────────────────────────────────────
/** Builds the canonical DID string for a given Ethereum address. */
function makeDID(address: `0x${string}`): string {
  return `did:ethr:${address.toLowerCase()}`;
}

// ─── Shared deploy helper ────────────────────────────────────────────────────
async function deployAll(viem: any) {
  // accounts[0] = deployer (also the trustedRelayer in tests)
  const [deployer, reviewer, voter, vendor, other] = await viem.getWalletClients();

  // ── Core contracts ──────────────────────────────────────────────────────
  const didRegistry = await viem.deployContract("DIDRegistry");

  const identityRegistry = await viem.deployContract("IdentityRegistry", [
    caAccount.address,   // genesis CA
    "0x0000000000000000000000000000000000000000", // no genesis issuer needed
  ]);

  const nullifierRegistry = await viem.deployContract("NullifierRegistry");

  const vendorRegistry = await viem.deployContract("VendorRegistry", [
    identityRegistry.address,
    didRegistry.address,
  ]);

  const reputationToken = await viem.deployContract("ReputationToken");

  const reviewContract = await viem.deployContract("ReviewContract", [
    nullifierRegistry.address,
    vendorRegistry.address,
    reputationToken.address,
    didRegistry.address,
    deployer.account.address, // trustedRelayer = deployer in tests
    DELTA_PLUS, DELTA_MINUS, THETA_FIXED_POINT, K_SCALING, REDEMPTION_THRESHOLD,
  ]);

  await nullifierRegistry.write.setReviewContract([reviewContract.address]);
  await reputationToken.write.setReviewContract([reviewContract.address]);

  // ── DID registration (every participant must register before acting) ─────
  // Each actor registers their own DID from their own wallet.
  await didRegistry.write.registerDID(
    [makeDID(reviewer.account.address), "pubkey-reviewer", ""],
    { account: reviewer.account },
  );
  await didRegistry.write.registerDID(
    [makeDID(voter.account.address), "pubkey-voter", ""],
    { account: voter.account },
  );
  await didRegistry.write.registerDID(
    [makeDID(vendor.account.address), "pubkey-vendor", ""],
    { account: vendor.account },
  );

  // ── Vendor onboarding (still on-chain with CA signature) ─────────────────
  const vcSig = await buildVendorVCSig(vendor.account.address, LEGAL_NAME, VAT_NUMBER);
  await vendorRegistry.write.registerVendor(
    [vendor.account.address, LEGAL_NAME, VAT_NUMBER, vcSig.v, vcSig.r, vcSig.s],
    { account: vendor.account },
  );
  await vendorRegistry.write.registerProduct([PRODUCT_ID], { account: vendor.account });

  const productIdHash = keccak256(
    new TextEncoder().encode(PRODUCT_ID) as Uint8Array,
  ) as `0x${string}`;

  return {
    didRegistry, identityRegistry, nullifierRegistry,
    vendorRegistry, reputationToken, reviewContract,
    deployer, reviewer, voter, vendor, other,
    productIdHash,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// S2.3 — Review Submission
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.3 — submitReview", async function () {
  const { viem } = await network.create();
  const ctx = await deployAll(viem);
  const { reviewContract, nullifierRegistry, reviewer, voter, other, deployer } = ctx;

  it("happy path: relayer submits review, emits ReviewSubmitted", async function () {
    const nullifier = randomNullifier();
    // Simulate off-chain SD-JWT verification
    assert.ok(await simulateSDJWTVerification(reviewer.account.address, PRODUCT_ID, nullifier));

    await viem.assertions.emit(
      reviewContract.write.submitReview(
        [reviewer.account.address, PRODUCT_ID, "bafybeig0001", 5, nullifier],
        { account: deployer.account }, // relayer sends the tx
      ),
      reviewContract, "ReviewSubmitted",
    );
    const r = await reviewContract.read.reviews([1n]);
    assert.equal(r[3], "bafybeig0001"); // cid
    assert.equal(r[4], 5);              // score
  });

  it("auto-registers reviewer and mints 1 RWT welcome token (R₀ = 1)", async function () {
    const { reputationToken } = ctx;
    const balance = await reputationToken.read.balanceOf([reviewer.account.address]);
    assert.ok(balance >= 1n * 10n ** 18n, `Welcome token missing, balance=${balance}`);
    const rep = await reviewContract.read.reputationScore([reviewer.account.address]);
    assert.equal(rep, 1n, "Initial reputation R₀ should be 1");
  });

  it("reverts InvalidScore for score = 0", async function () {
    const nullifier = randomNullifier();
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview(
        [reviewer.account.address, PRODUCT_ID, "bafybeig_bad", 0, nullifier],
        { account: deployer.account },
      ),
      reviewContract, "InvalidScore",
    );
  });

  it("reverts InvalidScore for score = 6", async function () {
    const nullifier = randomNullifier();
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview(
        [reviewer.account.address, PRODUCT_ID, "bafybeig_bad6", 6, nullifier],
        { account: deployer.account },
      ),
      reviewContract, "InvalidScore",
    );
  });

  it("reverts on nullifier replay — double-spend protection", async function () {
    const nullifier = randomNullifier();
    await reviewContract.write.submitReview(
      [voter.account.address, PRODUCT_ID, "bafybeig_ds_first", 4, nullifier],
      { account: deployer.account },
    );
    await assert.rejects(
      () => reviewContract.write.submitReview(
        [voter.account.address, PRODUCT_ID, "bafybeig_ds_replay", 4, nullifier],
        { account: deployer.account },
      ),
    );
    const spent = await nullifierRegistry.read.isSpent([nullifier]);
    assert.ok(spent, "Nullifier should be marked spent");
  });

  it("reverts NotRelayer when a non-relayer calls submitReview", async function () {
    const nullifier = randomNullifier();
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview(
        [reviewer.account.address, PRODUCT_ID, "bafybeig_direct", 3, nullifier],
        { account: reviewer.account }, // reviewer tries to call directly — not allowed
      ),
      reviewContract, "NotRelayer",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DID — Liveness checks and revocation
// ═══════════════════════════════════════════════════════════════════════════════

describe("DID — liveness enforcement", async function () {

  it("reverts DIDNotActive if reviewer has no registered DID", async function () {
    const { viem } = await network.create();
    const { reviewContract, other, deployer } = await deployAll(viem);
    // `other` has no DID registered
    const nullifier = randomNullifier();
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview(
        [other.account.address, PRODUCT_ID, "bafybeig_nodid", 4, nullifier],
        { account: deployer.account },
      ),
      reviewContract, "DIDNotActive",
    );
  });

  it("reverts DIDNotActive after DID revocation", async function () {
    const { viem } = await network.create();
    const { reviewContract, reviewer, deployer } = await deployAll(viem);

    // Submit one review while DID is active
    const n1 = randomNullifier();
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, "bafybeig_before_revoke", 4, n1],
      { account: deployer.account },
    );

    // Reviewer revokes their own DID
    const { didRegistry } = await deployAll(viem);
    // use the ctx from this network
    const ctx2 = await deployAll(viem);
    await ctx2.didRegistry.write.revokeDID([], { account: ctx2.reviewer.account });

    // Now a new submission should fail
    const n2 = randomNullifier();
    await viem.assertions.revertWithCustomError(
      ctx2.reviewContract.write.submitReview(
        [ctx2.reviewer.account.address, PRODUCT_ID, "bafybeig_after_revoke", 4, n2],
        { account: ctx2.deployer.account },
      ),
      ctx2.reviewContract, "DIDNotActive",
    );
  });

  it("reverts VendorDIDNotActive when vendor registers without a DID", async function () {
    const { viem } = await network.create();
    const { vendorRegistry, other } = await deployAll(viem);
    // `other` has no DID
    const vcSig = await buildVendorVCSig(other.account.address, LEGAL_NAME, VAT_NUMBER);
    await viem.assertions.revertWithCustomError(
      vendorRegistry.write.registerVendor(
        [other.account.address, LEGAL_NAME, VAT_NUMBER, vcSig.v, vcSig.r, vcSig.s],
        { account: other.account },
      ),
      vendorRegistry, "VendorDIDNotActive",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2.4 — Modification
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.4 — modifyReview", async function () {

  it("allows a single modification within the 3-hour window", async function () {
    const { viem } = await network.create();
    const { reviewContract, reviewer, deployer } = await deployAll(viem);
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, "bafybeig_orig", 4, randomNullifier()],
      { account: deployer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    await viem.assertions.emit(
      reviewContract.write.modifyReview(
        [reviewId, "bafybeig_mod"], { account: reviewer.account }),
      reviewContract, "ReviewModified",
    );
    const r = await reviewContract.read.reviews([reviewId]);
    assert.equal(r[3], "bafybeig_mod");
  });

  it("reverts ModificationLimitReached on a second attempt", async function () {
    const { viem } = await network.create();
    const { reviewContract, reviewer, deployer } = await deployAll(viem);
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, "bafybeig_base", 4, randomNullifier()],
      { account: deployer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();
    await reviewContract.write.modifyReview([reviewId, "bafybeig_once"], { account: reviewer.account });
    await viem.assertions.revertWithCustomError(
      reviewContract.write.modifyReview([reviewId, "bafybeig_twice"], { account: reviewer.account }),
      reviewContract, "ModificationLimitReached",
    );
  });

  it("reverts ModificationWindowElapsed after 3 hours", async function () {
    const { viem, networkHelpers } = await network.create();
    const { reviewContract, reviewer, deployer } = await deployAll(viem);
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, "bafybeig_late", 3, randomNullifier()],
      { account: deployer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();
    await networkHelpers.time.increase(3 * 60 * 60 + 1);
    await viem.assertions.revertWithCustomError(
      reviewContract.write.modifyReview([reviewId, "bafybeig_toolate"], { account: reviewer.account }),
      reviewContract, "ModificationWindowElapsed",
    );
  });

  it("reverts NotReviewer when a non-author attempts modification", async function () {
    const { viem } = await network.create();
    const { reviewContract, reviewer, voter, deployer } = await deployAll(viem);
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, "bafybeig_auth", 4, randomNullifier()],
      { account: deployer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();
    await viem.assertions.revertWithCustomError(
      reviewContract.write.modifyReview([reviewId, "bafybeig_steal"], { account: voter.account }),
      reviewContract, "NotReviewer",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2.4 — Revocation
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.4 — revokeReview", async function () {

  it("allows revocation and sets the revoked flag", async function () {
    const { viem } = await network.create();
    const { reviewContract, reviewer, deployer } = await deployAll(viem);
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, "bafybeig_revoke", 2, randomNullifier()],
      { account: deployer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    await viem.assertions.emit(
      reviewContract.write.revokeReview([reviewId], { account: reviewer.account }),
      reviewContract, "ReviewRevoked",
    );
    const r = await reviewContract.read.reviews([reviewId]);
    assert.ok(r[8] === true, "revoked flag (index 8) should be true");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2.4 — Vendor Reply
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.4 — submitVendorReply", async function () {
  const { viem } = await network.create();
  const { reviewContract, reviewer, vendor, deployer } = await deployAll(viem);
  const REVIEW_CID = "bafybeig_vr_target";

  before(async function () {
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, REVIEW_CID, 2, randomNullifier()],
      { account: deployer.account },
    );
  });

  it("vendor can submit a reply and emits VendorReplySubmitted", async function () {
    await viem.assertions.emit(
      reviewContract.write.submitVendorReply(
        [REVIEW_CID, "bafybeig_reply"], { account: vendor.account }),
      reviewContract, "VendorReplySubmitted",
    );
  });

  it("reverts AlreadyReplied on a second reply to the same review", async function () {
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitVendorReply(
        [REVIEW_CID, "bafybeig_reply2"], { account: vendor.account }),
      reviewContract, "AlreadyReplied",
    );
  });

  it("reverts NotAnAuthorizedVendor when a non-vendor replies", async function () {
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitVendorReply(
        [REVIEW_CID, "bafybeig_fake_reply"], { account: reviewer.account }),
      reviewContract, "NotAnAuthorizedVendor",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2.6 — Voting and Curation Finalization
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.6 — voteOnReview / finalizeCuration", async function () {
  const { viem, networkHelpers } = await network.create();
  const ctx = await deployAll(viem);
  const { reviewContract, reputationToken, reviewer, voter, productIdHash, vendor, deployer } = ctx;
  let reviewId: bigint;

  before(async function () {
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, "bafybeig_curation", 5, randomNullifier()],
      { account: deployer.account },
    );
    reviewId = await reviewContract.read.reviewCount();
  });

  it("relayer casts an upvote on behalf of voter", async function () {
    assert.ok(
      await simulateSDJWTVerification(voter.account.address, PRODUCT_ID, randomNullifier()),
    );
    await viem.assertions.emit(
      reviewContract.write.voteOnReview(
        [reviewId, voter.account.address, randomNullifier(), true],
        { account: deployer.account },
      ),
      reviewContract, "VoteCast",
    );
  });

  it("reverts AlreadyVoted on a duplicate vote from the same address", async function () {
    await viem.assertions.revertWithCustomError(
      reviewContract.write.voteOnReview(
        [reviewId, voter.account.address, randomNullifier(), false],
        { account: deployer.account },
      ),
      reviewContract, "AlreadyVoted",
    );
  });

  it("reverts NotRelayer when non-relayer calls voteOnReview", async function () {
    await viem.assertions.revertWithCustomError(
      reviewContract.write.voteOnReview(
        [reviewId, voter.account.address, randomNullifier(), true],
        { account: voter.account }, // voter tries to call directly
      ),
      reviewContract, "NotRelayer",
    );
  });

  it("reverts CurationWindowStillOpen before 30 days elapse", async function () {
    await viem.assertions.revertWithCustomError(
      reviewContract.write.finalizeCuration([reviewId]),
      reviewContract, "CurationWindowStillOpen",
    );
  });

  it("finalizes curation after 31-day time travel and emits CurationFinalized", async function () {
    await networkHelpers.time.increase(31 * 24 * 60 * 60);
    await viem.assertions.emit(
      reviewContract.write.finalizeCuration([reviewId]),
      reviewContract, "CurationFinalized",
    );
  });

  it("reviewer receives RWT reward after a qualifying curation", async function () {
    const balance = await reputationToken.read.balanceOf([reviewer.account.address]);
    assert.ok(balance > 1n * 10n ** 18n, `Reward not minted, balance=${balance}`);
  });

  it("concordant voter gains reputation (Δ+) after finalization", async function () {
    const rep = await reviewContract.read.reputationScore([voter.account.address]);
    assert.ok(rep > 1n, `Voter rep should be > 1 after concordant vote, got ${rep}`);
  });

  it("product reputation aggregation reflects the submitted score", async function () {
    const productRep = await reviewContract.read.productReputation([productIdHash]);
    assert.ok(productRep > 0n, `Product reputation should be > 0, got ${productRep}`);
  });

  it("vendor reputation aggregation reflects the submitted score", async function () {
    const vendorRep  = await reviewContract.read.vendorReputation([vendor.account.address]);
    const productRep = await reviewContract.read.productReputation([productIdHash]);
    console.log(`  [evidence] productRep=${productRep}, vendorRep=${vendorRep}`);
    assert.ok(productRep > 0n, "Product reputation should be positive");
    assert.ok(vendorRep  > 0n, `Vendor reputation should be > 0, got ${vendorRep}`);
  });

  it("reverts AlreadyFinalized on a second finalization attempt", async function () {
    await viem.assertions.revertWithCustomError(
      reviewContract.write.finalizeCuration([reviewId]),
      reviewContract, "AlreadyFinalized",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2.6 — Burn-to-Redeem
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.6 — redeemTokens", async function () {
  const { viem } = await network.create();
  const { reviewContract, reputationToken, reviewer, other, deployer } = await deployAll(viem);
  const DEAD = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

  it("reverts BalanceBelowThreshold for a user below T_min", async function () {
    await viem.assertions.revertWithCustomError(
      reviewContract.write.redeemTokens([DEAD, 1n], { account: other.account }),
      reviewContract, "BalanceBelowThreshold",
    );
  });

  it("burns tokens and emits TokensRedeemed when balance meets threshold", async function () {
    await reviewContract.write.setRedemptionThreshold([1n * 10n ** 18n]);
    await reviewContract.write.submitReview(
      [reviewer.account.address, PRODUCT_ID, "bafybeig_redeem", 3, randomNullifier()],
      { account: deployer.account },
    );

    const before = await reputationToken.read.balanceOf([reviewer.account.address]);
    const amount = 1n * 10n ** 18n;

    await viem.assertions.emit(
      reviewContract.write.redeemTokens([DEAD, amount], { account: reviewer.account }),
      reviewContract, "TokensRedeemed",
    );
    const after = await reputationToken.read.balanceOf([reviewer.account.address]);
    assert.equal(before - after, amount, "Burned amount mismatch");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ReputationToken — Soulbound enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe("ReputationToken — Soulbound: all transfer paths permanently disabled", async function () {
  const { viem } = await network.create();
  const { reputationToken, reviewer, voter } = await deployAll(viem);

  it("reverts on transfer()", async function () {
    await assert.rejects(
      () => reputationToken.read.transfer([voter.account.address, 1n]),
      (err: Error) => err.message.includes("SoulboundTokenNonTransferable"),
    );
  });

  it("reverts on transferFrom()", async function () {
    await assert.rejects(
      () => reputationToken.read.transferFrom([reviewer.account.address, voter.account.address, 1n]),
      (err: Error) => err.message.includes("SoulboundTokenNonTransferable"),
    );
  });

  it("reverts on approve()", async function () {
    await assert.rejects(
      () => reputationToken.read.approve([voter.account.address, 1n]),
      (err: Error) => err.message.includes("SoulboundTokenNonTransferable"),
    );
  });
});
