/**
 * test/reviewchain.test.ts
 *
 * Integration test suite for the TechRate protocol.
 * Covers every execution flow defined in WP2:
 *   - S2.3  Review Submission (happy path + all expected reverts)
 *   - S2.4  Modification, Revocation, Vendor Reply
 *   - S2.6  Utility Voting, Curation Finalization, Reward Distribution,
 *           Reputation Aggregation, Burn-to-Redeem
 *
 * Architecture: each top-level describe block calls `network.create()` to
 * get a completely isolated EVM state. This avoids shared-state pollution
 * between test groups that manipulate time or the `modified` flag.
 *
 * Runtime: Hardhat 3 + @nomicfoundation/hardhat-toolbox-viem
 * Run:  npx hardhat test nodejs
 */

import { network }    from "hardhat";
import { describe, it, before } from "node:test";
import assert          from "node:assert/strict";
import {
  keccak256, encodeAbiParameters, parseAbiParameters, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── Protocol parameters ─────────────────────────────────────────────────────
const DELTA_PLUS           = 1n;
const DELTA_MINUS          = 3n;
const THETA_FIXED_POINT    = 5n * 10n ** 17n; // 0.5 WAD
const K_SCALING            = 10n ** 18n;       // 1.0 WAD → reward = 1 wei at R=1
const REDEMPTION_THRESHOLD = 5n * 10n ** 18n;  // 5 RWT

// ─── Well-known Hardhat test private keys ─────────────────────────────────────
const ISSUER_PRIVATE_KEY =
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as `0x${string}`;
const issuerAccount = privateKeyToAccount(ISSUER_PRIVATE_KEY);

const CA_PRIVATE_KEY =
  "0xdbda1821b80551c9d65939329250132c444d36cd2edb8c94e48abb0af7e52657" as `0x${string}`;
const caAccount = privateKeyToAccount(CA_PRIVATE_KEY);

// ─── Signature helpers ───────────────────────────────────────────────────────

async function buildPoP(
  userAddress: `0x${string}`,
  productId:   string,
  nullifier:   `0x${string}`,
  sdDigests:   `0x${string}`[] = [],
) {
  const productIdHash = keccak256(
    new TextEncoder().encode(productId) as Uint8Array
  ) as `0x${string}`;

  const encoded = encodeAbiParameters(
    parseAbiParameters("address, bytes32, bytes32, bytes32[]"),
    [userAddress, productIdHash, nullifier, sdDigests],
  );
  const hash = keccak256(encoded);
  const sig  = await issuerAccount.sign({ hash });

  return {
    issuerWallet:      issuerAccount.address,
    userWalletAddress: userAddress,
    productIdHash,
    nullifier,
    sdDigests,
    v: parseInt(sig.slice(130, 132), 16),
    r: `0x${sig.slice(2, 66)}`   as `0x${string}`,
    s: `0x${sig.slice(66, 130)}` as `0x${string}`,
  };
}

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

function randomNullifier(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// ─── Shared deploy helper (called once per isolated network) ─────────────────

const PRODUCT_ID  = "LAPTOP-XPS-9510";
const LEGAL_NAME  = "TechCo S.r.l.";
const VAT_NUMBER  = "IT12345678901";

async function deployAll(viem: any) {
  const [deployer, reviewer, voter, vendor, other] = await viem.getWalletClients();

  const identityRegistry = await viem.deployContract("IdentityRegistry", [
    caAccount.address,
    issuerAccount.address,
  ]);
  const nullifierRegistry = await viem.deployContract("NullifierRegistry");
  const vendorRegistry    = await viem.deployContract("VendorRegistry",
    [identityRegistry.address]);
  const reputationToken   = await viem.deployContract("ReputationToken");
  const reviewContract    = await viem.deployContract("ReviewContract", [
    identityRegistry.address,
    nullifierRegistry.address,
    vendorRegistry.address,
    reputationToken.address,
    DELTA_PLUS, DELTA_MINUS, THETA_FIXED_POINT, K_SCALING, REDEMPTION_THRESHOLD,
  ]);

  await nullifierRegistry.write.setReviewContract([reviewContract.address]);
  await reputationToken.write.setReviewContract([reviewContract.address]);

  const vcSig = await buildVendorVCSig(vendor.account.address, LEGAL_NAME, VAT_NUMBER);
  await vendorRegistry.write.registerVendor(
    [vendor.account.address, LEGAL_NAME, VAT_NUMBER, vcSig.v, vcSig.r, vcSig.s],
    { account: vendor.account },
  );
  await vendorRegistry.write.registerProduct([PRODUCT_ID], { account: vendor.account });

  const productIdHash = keccak256(
    new TextEncoder().encode(PRODUCT_ID) as Uint8Array
  ) as `0x${string}`;

  return {
    identityRegistry, nullifierRegistry, vendorRegistry,
    reputationToken, reviewContract,
    deployer, reviewer, voter, vendor, other,
    productIdHash,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// S2.3 — Review Submission
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.3 — submitReview", async function () {
  const { viem, networkHelpers } = await network.create();
  const ctx = await deployAll(viem);
  const { reviewContract, nullifierRegistry, reviewer, voter, other } = ctx;

  it("happy path: emits ReviewSubmitted and stores correct state", async function () {
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await viem.assertions.emit(
      reviewContract.write.submitReview(
        [pop, PRODUCT_ID, "bafybeig0001", 5],
        { account: reviewer.account },
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
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview([pop, PRODUCT_ID, "bafybeig_bad", 0],
        { account: reviewer.account }),
      reviewContract, "InvalidScore",
    );
  });

  it("reverts InvalidScore for score = 6", async function () {
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview([pop, PRODUCT_ID, "bafybeig_bad", 6],
        { account: reviewer.account }),
      reviewContract, "InvalidScore",
    );
  });

  it("reverts on nullifier replay — double-spend protection", async function () {
    const nullifier = randomNullifier();
    const pop1 = await buildPoP(voter.account.address, PRODUCT_ID, nullifier);
    await reviewContract.write.submitReview(
      [pop1, PRODUCT_ID, "bafybeig_ds_first", 4],
      { account: voter.account },
    );
    const pop2 = await buildPoP(voter.account.address, PRODUCT_ID, nullifier);
    // AlreadySpent is defined on NullifierRegistry and propagated through
    // ReviewContract. Since it's not in ReviewContract's ABI, viem cannot
    // decode it when called via reviewContract.write. We use assert.rejects
    // to check the call reverts, then verify the nullifier is spent on-chain.
    await assert.rejects(
      () => reviewContract.write.submitReview(
        [pop2, PRODUCT_ID, "bafybeig_ds_replay", 4],
        { account: voter.account },
      ),
    );
    // Supporting evidence: nullifier is permanently marked spent on-chain
    const spent = await nullifierRegistry.read.isSpent([nullifier]);
    assert.ok(spent, "Nullifier should be marked spent in NullifierRegistry");
  });

  it("reverts WalletBindingMismatch when PoP is bound to a different address", async function () {
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview(
        [pop, PRODUCT_ID, "bafybeig_wbm", 3],
        { account: voter.account }, // wrong sender
      ),
      reviewContract, "WalletBindingMismatch",
    );
  });

  it("reverts UntrustedIssuer when signer is not in IdentityRegistry", async function () {
    const fakeIssuer = privateKeyToAccount(
      "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" as `0x${string}`
    );
    const productIdHash = keccak256(
      new TextEncoder().encode(PRODUCT_ID) as Uint8Array
    ) as `0x${string}`;
    const nullifier = randomNullifier();
    const encoded = encodeAbiParameters(
      parseAbiParameters("address, bytes32, bytes32, bytes32[]"),
      [other.account.address, productIdHash, nullifier, []],
    );
    const sig = await fakeIssuer.sign({ hash: keccak256(encoded) });
    const pop = {
      issuerWallet:      fakeIssuer.address,
      userWalletAddress: other.account.address,
      productIdHash, nullifier, sdDigests: [] as `0x${string}`[],
      v: parseInt(sig.slice(130, 132), 16),
      r: `0x${sig.slice(2, 66)}`   as `0x${string}`,
      s: `0x${sig.slice(66, 130)}` as `0x${string}`,
    };
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview(
        [pop, PRODUCT_ID, "bafybeig_fake", 3],
        { account: other.account },
      ),
      reviewContract, "UntrustedIssuer",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2.4 — Modification (isolated network per test for time/state independence)
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.4 — modifyReview", async function () {

  it("allows a single modification within the 3-hour window", async function () {
    const { viem } = await network.create();
    const { reviewContract, reviewer } = await deployAll(viem);
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await reviewContract.write.submitReview(
      [pop, PRODUCT_ID, "bafybeig_orig", 4], { account: reviewer.account });
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
    const { reviewContract, reviewer } = await deployAll(viem);
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await reviewContract.write.submitReview(
      [pop, PRODUCT_ID, "bafybeig_base", 4], { account: reviewer.account });
    const reviewId = await reviewContract.read.reviewCount();
    await reviewContract.write.modifyReview(
      [reviewId, "bafybeig_once"], { account: reviewer.account });
    await viem.assertions.revertWithCustomError(
      reviewContract.write.modifyReview(
        [reviewId, "bafybeig_twice"], { account: reviewer.account }),
      reviewContract, "ModificationLimitReached",
    );
  });

  it("reverts ModificationWindowElapsed after 3 hours", async function () {
    const { viem, networkHelpers } = await network.create();
    const { reviewContract, reviewer } = await deployAll(viem);
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await reviewContract.write.submitReview(
      [pop, PRODUCT_ID, "bafybeig_late", 3], { account: reviewer.account });
    const reviewId = await reviewContract.read.reviewCount();
    await networkHelpers.time.increase(3 * 60 * 60 + 1);
    await viem.assertions.revertWithCustomError(
      reviewContract.write.modifyReview(
        [reviewId, "bafybeig_toolate"], { account: reviewer.account }),
      reviewContract, "ModificationWindowElapsed",
    );
  });

  it("reverts NotReviewer when a non-author attempts modification", async function () {
    const { viem } = await network.create();
    const { reviewContract, reviewer, voter } = await deployAll(viem);
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await reviewContract.write.submitReview(
      [pop, PRODUCT_ID, "bafybeig_auth", 4], { account: reviewer.account });
    const reviewId = await reviewContract.read.reviewCount();
    await viem.assertions.revertWithCustomError(
      reviewContract.write.modifyReview(
        [reviewId, "bafybeig_steal"], { account: voter.account }),
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
    const { reviewContract, reviewer } = await deployAll(viem);
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await reviewContract.write.submitReview(
      [pop, PRODUCT_ID, "bafybeig_revoke", 2], { account: reviewer.account });
    const reviewId = await reviewContract.read.reviewCount();

    await viem.assertions.emit(
      reviewContract.write.revokeReview([reviewId], { account: reviewer.account }),
      reviewContract, "ReviewRevoked",
    );
    const r = await reviewContract.read.reviews([reviewId]);
    // Review struct field order: reviewer[0], productIdHash[1], vendor[2],
    // cid[3], score[4], submittedAt[5], windowStart[6], modified[7],
    // revoked[8], curationClosed[9], ...
    assert.ok(r[8] === true, "revoked flag (index 8) should be true");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2.4 — Vendor Reply
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2.4 — submitVendorReply", async function () {
  const { viem } = await network.create();
  const { reviewContract, reviewer, vendor } = await deployAll(viem);
  const REVIEW_CID = "bafybeig_vr_target";

  before(async function () {
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await reviewContract.write.submitReview(
      [pop, PRODUCT_ID, REVIEW_CID, 2], { account: reviewer.account });
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
  const { reviewContract, reputationToken, reviewer, voter, productIdHash, vendor } = ctx;
  let reviewId: bigint;

  before(async function () {
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await reviewContract.write.submitReview(
      [pop, PRODUCT_ID, "bafybeig_curation", 5],
      { account: reviewer.account },
    );
    reviewId = await reviewContract.read.reviewCount();
  });

  it("voter casts an upvote with a valid PoP for the same product", async function () {
    const pop = await buildPoP(voter.account.address, PRODUCT_ID, randomNullifier());
    await viem.assertions.emit(
      reviewContract.write.voteOnReview([reviewId, pop, true], { account: voter.account }),
      reviewContract, "VoteCast",
    );
  });

  it("reverts AlreadyVoted on a duplicate vote from the same address", async function () {
    const pop = await buildPoP(voter.account.address, PRODUCT_ID, randomNullifier());
    await viem.assertions.revertWithCustomError(
      reviewContract.write.voteOnReview([reviewId, pop, false], { account: voter.account }),
      reviewContract, "AlreadyVoted",
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
    // welcome (1e18) + reviewer reward (Δ+ * R * k / 1e18 = 1 * 1 * 1e18/1e18 = 1 unit)
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
    const vendorRep = await reviewContract.read.vendorReputation([vendor.account.address]);
    const productRep = await reviewContract.read.productReputation([productIdHash]);
    // Both should be non-zero (vendorRep = 0 only if vendor wasn't resolved at submit time)
    console.log(`  [evidence] productRep=${productRep}, vendorRep=${vendorRep}`);
    assert.ok(productRep > 0n, "Product reputation should be positive");
    assert.ok(vendorRep > 0n, `Vendor reputation should be > 0, got ${vendorRep}`);
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
  const { reviewContract, reputationToken, reviewer, other } = await deployAll(viem);
  const DEAD = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

  it("reverts BalanceBelowThreshold for a user below T_min", async function () {
    await viem.assertions.revertWithCustomError(
      reviewContract.write.redeemTokens([DEAD, 1n], { account: other.account }),
      reviewContract, "BalanceBelowThreshold",
    );
  });

  it("burns tokens and emits TokensRedeemed when balance meets threshold", async function () {
    // Lower threshold to 1 RWT so welcome token qualifies
    await reviewContract.write.setRedemptionThreshold([1n * 10n ** 18n]);
    const pop = await buildPoP(reviewer.account.address, PRODUCT_ID, randomNullifier());
    await reviewContract.write.submitReview(
      [pop, PRODUCT_ID, "bafybeig_redeem", 3], { account: reviewer.account });

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

  // transfer / transferFrom / approve are `pure` in Solidity → exposed as read
  it("reverts on transfer()", async function () {
    await assert.rejects(
      () => reputationToken.read.transfer([voter.account.address, 1n]),
      (err: Error) => err.message.includes("SoulboundTokenNonTransferable"),
    );
  });

  it("reverts on transferFrom()", async function () {
    await assert.rejects(
      () => reputationToken.read.transferFrom(
        [reviewer.account.address, voter.account.address, 1n]),
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
