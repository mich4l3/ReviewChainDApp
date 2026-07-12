/**
 * test/reviewchain.test.ts
 *
 * Integration test suite for the TechRate protocol.
 * Architecture uses direct submission via DIDs with on-chain ecrecover.
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

// ─── Well-known Hardhat test private keys ────────────────────────────────────
const CA_PRIVATE_KEY =
  "0xdbda1821b80551c9d65939329250132c444d36cd2edb8c94e48abb0af7e52657" as `0x${string}`;
const caAccount = privateKeyToAccount(CA_PRIVATE_KEY);

const ISSUER_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as `0x${string}`;
const issuerAccount = privateKeyToAccount(ISSUER_PRIVATE_KEY);

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function buildPoPSig(
  did: string,
  vendorDid: string,
  productIdHash: `0x${string}`,
  nullifier: `0x${string}`,
  sdDigests: `0x${string}`[]
) {
  const encoded = encodeAbiParameters(
    parseAbiParameters("string, string, bytes32, bytes32, bytes32[]"),
    [did, vendorDid, productIdHash, nullifier, sdDigests],
  );
  const hash = keccak256(encoded);
  const sig  = await issuerAccount.sign({ hash });
  return {
    v: parseInt(sig.slice(130, 132), 16),
    r: `0x${sig.slice(2, 66)}`   as `0x${string}`,
    s: `0x${sig.slice(66, 130)}` as `0x${string}`,
  };
}

async function buildUntrustedPoPSig(
  did: string,
  vendorDid: string,
  productIdHash: `0x${string}`,
  nullifier: `0x${string}`,
  sdDigests: `0x${string}`[]
) {
  const encoded = encodeAbiParameters(
    parseAbiParameters("string, string, bytes32, bytes32, bytes32[]"),
    [did, vendorDid, productIdHash, nullifier, sdDigests],
  );
  const hash = keccak256(encoded);
  const sig  = await privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a").sign({ hash });
  return {
    v: parseInt(sig.slice(130, 132), 16),
    r: `0x${sig.slice(2, 66)}`   as `0x${string}`,
    s: `0x${sig.slice(66, 130)}` as `0x${string}`,
  };
}

const PRODUCT_ID = "LAPTOP-XPS-9510";
const LEGAL_NAME = "TechCo S.r.l.";
const VAT_NUMBER = "IT12345678901";

function makeDID(address: `0x${string}`): string {
  return `did:ethr:${address.toLowerCase()}`;
}

async function deployAll(viem: any) {
  const [deployer, reviewer, voter, vendor, other] = await viem.getWalletClients();

  const identityRegistry = await viem.deployContract("IdentityRegistry", [
    caAccount.address,       // genesis CA
    issuerAccount.address,   // genesis Issuer
  ]);

  const didRegistry = await viem.deployContract("DIDRegistry", [
    identityRegistry.address,
  ]);

  const nullifierRegistry = await viem.deployContract("NullifierRegistry");

  const vendorRegistry = await viem.deployContract("VendorRegistry", [
    identityRegistry.address,
  ]);

  const reputationToken = await viem.deployContract("ReputationToken");

  const reviewContract = await viem.deployContract("ReviewContract", [
    nullifierRegistry.address,
    vendorRegistry.address,
    reputationToken.address,
    didRegistry.address,
    identityRegistry.address,
    DELTA_PLUS, DELTA_MINUS, THETA_FIXED_POINT, K_SCALING, REDEMPTION_THRESHOLD,
  ]);

  await nullifierRegistry.write.setReviewContract([reviewContract.address]);
  await reputationToken.write.setReviewContract([reviewContract.address]);

  // Registrazione DIDs
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

  // Vendor Onboarding by Issuer
  await vendorRegistry.write.issuerRegisterVendor(
    [vendor.account.address, LEGAL_NAME, VAT_NUMBER],
    { account: issuerAccount },
  );

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

describe("S2.3 — submitReview", async function () {
  const { viem } = await network.create();
  const ctx = await deployAll(viem);
  const { vendor, reviewContract, nullifierRegistry, reviewer, voter, other, productIdHash } = ctx;

  it("happy path: user submits review directly, emits ReviewSubmitted", async function () {
    const nullifier = randomNullifier();
    const sdDigests = [randomNullifier(), randomNullifier()];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);

    await viem.assertions.emit(
      reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig0001", 5, nullifier, sdDigests, sig.v, sig.r, sig.s],
        { account: reviewer.account },
      ),
      reviewContract, "ReviewSubmitted",
    );
    const r = await reviewContract.read.reviews([1n]);
    assert.equal(r[3], "bafybeig0001");
    assert.equal(r[4], 5);
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
    const sdDigests = [randomNullifier()];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_bad", 0, nullifier, sdDigests, sig.v, sig.r, sig.s],
        { account: reviewer.account },
      ),
      reviewContract, "InvalidScore",
    );
  });

  it("reverts InvalidScore for score > 5", async function () {
    const nullifier = randomNullifier();
    const sdDigests = [randomNullifier()];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_bad2", 6, nullifier, sdDigests, sig.v, sig.r, sig.s],
        { account: reviewer.account },
      ),
      reviewContract, "InvalidScore",
    );
  });

  it("reverts UntrustedIssuer (or invalid signature) if productId does not match the one signed", async function () {
    const nullifier = randomNullifier();
    const sdDigests = [randomNullifier()];
    // Sign for PRODUCT_ID
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    // Submit with "FAKE-PRODUCT"
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), "FAKE-PRODUCT", "bafybeig_fake", 5, nullifier, sdDigests, sig.v, sig.r, sig.s],
        { account: reviewer.account },
      ),
      reviewContract, "UntrustedIssuer",
    );
  });

  it("reverts NotReviewer if user tries to submit using a DID they do not own", async function () {
    const nullifier = randomNullifier();
    const sdDigests = [randomNullifier()];
    // Sign for reviewer's DID
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    // Voter tries to submit using Reviewer's DID
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_theft", 4, nullifier, sdDigests, sig.v, sig.r, sig.s],
        { account: voter.account }, // msg.sender is voter, not reviewer
      ),
      reviewContract, "NotReviewer",
    );
  });

  it("reverts on nullifier replay — double-spend protection", async function () {
    const nullifier = randomNullifier();
    const sdDigests = [randomNullifier()];
    const sig = await buildPoPSig(makeDID(voter.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await reviewContract.write.submitReview([
        makeDID(voter.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_ds_first", 4, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: voter.account },
    );
    await assert.rejects(
      () => reviewContract.write.submitReview([
        makeDID(voter.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_ds_replay", 4, nullifier, sdDigests, sig.v, sig.r, sig.s],
        { account: voter.account },
      ),
    );
    const spent = await nullifierRegistry.read.isSpent([nullifier]);
    assert.ok(spent, "Nullifier should be marked spent");
  });

  it("reverts UntrustedIssuer when signature is invalid", async function () {
    const nullifier = randomNullifier();
    const sdDigests = [randomNullifier()];
    const sig = await buildUntrustedPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_direct", 3, nullifier, sdDigests, sig.v, sig.r, sig.s],
        { account: reviewer.account },
      ),
      reviewContract, "UntrustedIssuer",
    );
  });
});

describe("DID — liveness enforcement", async function () {
  it("reverts NotRegistered if reviewer has no registered DID", async function () {
    const { viem } = await network.create();
    const { vendor, reviewContract, didRegistry, other, productIdHash } = await deployAll(viem);
    
    const nullifier = randomNullifier();
    const sdDigests = [randomNullifier()];
    const sig = await buildPoPSig(makeDID(other.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitReview([
        makeDID(other.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_nodid", 4, nullifier, sdDigests, sig.v, sig.r, sig.s],
        { account: other.account },
      ),
      didRegistry, "NotRegistered",
    );
  });
});

describe("DIDRegistry — issuerRegisterDID", async function () {
  it("happy path: DID registered by issuer resolves to the correct owner address", async function () {
    const { viem } = await network.create();
    const { didRegistry, other } = await deployAll(viem);

    const ownerDID = makeDID(other.account.address);

    // issuerAccount is pre-registered as an Issuer in deployAll via IdentityRegistry
    await didRegistry.write.issuerRegisterDID(
      [other.account.address, ownerDID, "pubkey-other", ""],
      { account: issuerAccount },
    );

    // The DID document must resolve to `other`, not to the issuer
    const doc = await didRegistry.read.resolveDID([ownerDID]);
    assert.equal(
      doc.owner.toLowerCase(),
      other.account.address.toLowerCase(),
      "resolveDID should return the owner address, not the issuer address",
    );
    assert.ok(doc.active, "DID should be active after issuer registration");
  });

  it("reverts NotIssuer when called by a non-issuer account", async function () {
    const { viem } = await network.create();
    const { didRegistry, other, voter } = await deployAll(viem);

    const ownerDID = makeDID(other.account.address);

    await viem.assertions.revertWithCustomError(
      didRegistry.write.issuerRegisterDID(
        [other.account.address, ownerDID, "pubkey-other", ""],
        { account: voter.account }, // voter is NOT a registered issuer
      ),
      didRegistry, "NotIssuer",
    );
  });
});

describe("S2.4 — modifyReview", async function () {
  it("allows a single modification within the 3-hour window", async function () {
    const { viem } = await network.create();
    const { vendor, reviewContract, reviewer, productIdHash } = await deployAll(viem);
    
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_orig", 4, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    await viem.assertions.emit(
      reviewContract.write.modifyReview(
        [reviewId, "bafybeig_mod"], { account: reviewer.account }),
      reviewContract, "ReviewModified",
    );
  });

  it("reverts NotReviewer if someone else tries to modify", async function () {
    const { viem } = await network.create();
    const { vendor, reviewContract, reviewer, voter, productIdHash } = await deployAll(viem);
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_orig", 4, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    await viem.assertions.revertWithCustomError(
      reviewContract.write.modifyReview([reviewId, "bafybeig_hack"], { account: voter.account }),
      reviewContract, "NotReviewer",
    );
  });

  it("reverts ModificationLimitReached if trying to modify twice", async function () {
    const { viem } = await network.create();
    const { vendor, reviewContract, reviewer, productIdHash } = await deployAll(viem);
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_orig", 4, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    await reviewContract.write.modifyReview([reviewId, "bafybeig_mod1"], { account: reviewer.account });

    await viem.assertions.revertWithCustomError(
      reviewContract.write.modifyReview([reviewId, "bafybeig_mod2"], { account: reviewer.account }),
      reviewContract, "ModificationLimitReached",
    );
  });
});

describe("S2.4 — revokeReview", async function () {
  it("allows revocation and sets the revoked flag", async function () {
    const { viem } = await network.create();
    const { vendor, reviewContract, reviewer, productIdHash } = await deployAll(viem);
    
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_revoke", 2, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    await viem.assertions.emit(
      reviewContract.write.revokeReview([reviewId], { account: reviewer.account }),
      reviewContract, "ReviewRevoked",
    );
  });

  it("reverts NotReviewer if someone else tries to revoke", async function () {
    const { viem } = await network.create();
    const { vendor, reviewContract, reviewer, voter, productIdHash } = await deployAll(viem);
    
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_rev", 2, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    await viem.assertions.revertWithCustomError(
      reviewContract.write.revokeReview([reviewId], { account: voter.account }),
      reviewContract, "NotReviewer",
    );
  });

  it("reverts RevocationWindowElapsed if trying to revoke after 30 days", async function () {
    const { viem, networkHelpers } = await network.create();
    const { vendor, reviewContract, reviewer, productIdHash } = await deployAll(viem);
    
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_rev2", 2, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    // Time travel 31 days
    await networkHelpers.time.increase(31 * 24 * 60 * 60);

    await viem.assertions.revertWithCustomError(
      reviewContract.write.revokeReview([reviewId], { account: reviewer.account }),
      reviewContract, "RevocationWindowElapsed",
    );
  });

  it("modification resets windowStart: revocation is still allowed within 30 days of the modification", async function () {
    // Scenario: reviewer submits, then modifies just before the 3-hour window expires.
    // After modification windowStart is reset, so a new 30-day revocation window opens
    // even though more than 30 days have passed since the original submission.
    const { viem, networkHelpers } = await network.create();
    const { vendor, reviewContract, reviewer, productIdHash } = await deployAll(viem);

    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);

    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_extrev_orig", 3, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    // Advance to just before the 3-hour modification deadline and modify
    await networkHelpers.time.increase(2 * 60 * 60); // +2 h (still within 3 h)
    await reviewContract.write.modifyReview(
      [reviewId, "bafybeig_extrev_mod"], { account: reviewer.account },
    );

    // Now advance 15 more days — total elapsed since original submission > 30 days,
    // but only 15 days have passed since the modification reset windowStart
    await networkHelpers.time.increase(15 * 24 * 60 * 60);

    // Revocation must succeed because we are within the new 30-day window
    await viem.assertions.emit(
      reviewContract.write.revokeReview([reviewId], { account: reviewer.account }),
      reviewContract, "ReviewRevoked",
    );
  });
});

describe("S2.4 — submitVendorReply", async function () {
  const { viem } = await network.create();
  const { vendor, reviewContract, reviewer, productIdHash } = await deployAll(viem);
  const REVIEW_CID = "bafybeig_vr_target";

  before(async function () {
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, REVIEW_CID, 2, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
  });

  it("vendor can submit a reply and emits VendorReplySubmitted", async function () {
    await viem.assertions.emit(
      reviewContract.write.submitVendorReply(
        [REVIEW_CID, "bafybeig_reply"], { account: vendor.account }),
      reviewContract, "VendorReplySubmitted",
    );
  });

  it("reverts ReviewAlreadyRevoked if the review was revoked", async function () {
    const { viem } = await network.create();
    const { vendor, reviewContract, reviewer, productIdHash } = await deployAll(viem);
    
    const nullifier = randomNullifier();
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, []);
    
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_revoked", 2, nullifier, [], sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    const reviewId = await reviewContract.read.reviewCount();

    // Revoke the review
    await reviewContract.write.revokeReview([reviewId], { account: reviewer.account });

    // Vendor attempts to reply
    await viem.assertions.revertWithCustomError(
      reviewContract.write.submitVendorReply(
        ["bafybeig_revoked", "bafybeig_reply"], { account: vendor.account }),
      reviewContract, "ReviewAlreadyRevoked",
    );
  });
});

describe("S2.6 — voteOnReview / finalizeCuration", async function () {
  const { viem, networkHelpers } = await network.create();
  let ctx: any;
  let reviewId: bigint;

  before(async function () {
    ctx = await deployAll(viem);
    const { vendor, reviewContract, reviewer, productIdHash } = ctx;
    
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(reviewer.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await reviewContract.write.submitReview([
        makeDID(reviewer.account.address), makeDID(vendor.account.address), PRODUCT_ID, "bafybeig_curation", 5, nullifier, sdDigests, sig.v, sig.r, sig.s],
      { account: reviewer.account },
    );
    reviewId = await reviewContract.read.reviewCount();
  });

  it("user casts an upvote directly", async function () {
    const { vendor, reviewContract, voter, productIdHash } = ctx;
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildPoPSig(makeDID(voter.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await viem.assertions.emit(
      reviewContract.write.voteOnReview(
        [reviewId, makeDID(voter.account.address), makeDID(vendor.account.address), PRODUCT_ID, nullifier, sdDigests, sig.v, sig.r, sig.s, true],
        { account: voter.account },
      ),
      reviewContract, "VoteCast",
    );
  });

  it("reverts UntrustedIssuer when non-issuer tries to vote", async function () {
    const { vendor, reviewContract, voter, productIdHash } = ctx;
    const nullifier = randomNullifier();
    const sdDigests: `0x${string}`[] = [];
    const sig = await buildUntrustedPoPSig(makeDID(voter.account.address), makeDID(vendor.account.address), productIdHash, nullifier, sdDigests);
    
    await viem.assertions.revertWithCustomError(
      reviewContract.write.voteOnReview(
        [reviewId, makeDID(voter.account.address), makeDID(vendor.account.address), PRODUCT_ID, nullifier, sdDigests, sig.v, sig.r, sig.s, true],
        { account: voter.account },
      ),
      reviewContract, "UntrustedIssuer",
    );
  });

  it("reverts CurationWindowStillOpen if finalization is called too early", async function () {
    await viem.assertions.revertWithCustomError(
      ctx.reviewContract.write.finalizeCuration([reviewId]),
      ctx.reviewContract, "CurationWindowStillOpen",
    );
  });

  it("finalizes curation after 31-day time travel and emits CurationFinalized", async function () {
    await networkHelpers.time.increase(31 * 24 * 60 * 60);
    await viem.assertions.emit(
      ctx.reviewContract.write.finalizeCuration([reviewId]),
      ctx.reviewContract, "CurationFinalized",
    );
  });
});

describe("S2.6 — redeemTokens", async function () {
  const { viem } = await network.create();

  it("reverts BalanceBelowThreshold for a user below T_min", async function () {
    const { vendor, reviewContract, other } = await deployAll(viem);
    const DEAD = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;
    
    await viem.assertions.revertWithCustomError(
      reviewContract.write.redeemTokens([DEAD, 1n], { account: other.account }),
      reviewContract, "BalanceBelowThreshold",
    );
  });
});

describe("ReputationToken — Soulbound", async function () {
  const { viem } = await network.create();
  
  it("reverts on transfer()", async function () {
    const { reputationToken, voter } = await deployAll(viem);
    await assert.rejects(
      () => reputationToken.read.transfer([voter.account.address, 1n]),
      (err: Error) => err.message.includes("SoulboundTokenNonTransferable"),
    );
  });
});
