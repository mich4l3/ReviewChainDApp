/**
 * scripts/deploy.js
 *
 * Deploya tutti i contratti del protocollo TechRate sulla rete locale
 * Hardhat, esegue il wiring post-deploy e salva indirizzi + credenziali
 * in deployment.json.
 *
 * Modifiche rispetto alla versione precedente:
 *   - Aggiunto deploy di DIDRegistry
 *   - VendorRegistry ora riceve anche didRegistry come argomento
 *   - ReviewContract ora riceve didRegistry e trustedRelayer (= deployer)
 *     invece di identityRegistry (la verifica PoP è ora off-chain)
 *   - Post-deploy: registra i DID per issuer, CA e un vendor di esempio
 *   - deployment.json include l'indirizzo di DIDRegistry e del relayer
 *
 * Uso:
 *   npx hardhat node            (in un terminale separato)
 *   npx hardhat run scripts/deploy.js --network localhost
 */

import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Percorsi ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── Account di test Hardhat (chiavi deterministiche, ben note) ───────────────
// Account[0] → deployer / trustedRelayer   (owner + DApp backend relayer)
// Account[1] → issuer                      (backend e-commerce che emette SD-JWT)
// Account[2] → ca                          (Certification Authority per Vendor VC)
// Account[3] → vendor                      (venditore di esempio)

const HARDHAT_ACCOUNTS = [
  {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey:
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
  {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    privateKey:
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  },
];

// ─── Parametri di curation (WP2 S2.6) ────────────────────────────────────────

const CURATION_PARAMS = {
  deltaPlus:           1n,
  deltaMinus:          2n,
  thetaFixedPoint:     ethers.parseEther("0.5"),
  kScaling:            ethers.parseUnits("1", 15),
  redemptionThreshold: ethers.parseEther("5"),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadArtifact(contractName) {
  const artifactPath = resolve(
    ROOT,
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`
  );
  const raw = readFileSync(artifactPath, "utf8");
  return JSON.parse(raw);
}

async function deploy(signer, contractName, constructorArgs = []) {
  const artifact = loadArtifact(contractName);
  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    signer
  );
  const contract = await factory.deploy(...constructorArgs);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`  ✅  ${contractName.padEnd(22)} → ${address}`);
  return contract;
}

/** Restituisce il DID canonico per un indirizzo Ethereum. */
const makeDID = (address) => `did:ethr:${address.toLowerCase()}`;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

  const network = await provider.getNetwork();
  console.log(`\n🌐  Connesso alla rete: chainId=${network.chainId}\n`);

  const deployerWallet = new ethers.Wallet(HARDHAT_ACCOUNTS[0].privateKey, provider);
  const deployer       = new ethers.NonceManager(deployerWallet);
  const issuer         = new ethers.Wallet(HARDHAT_ACCOUNTS[1].privateKey, provider);
  const ca             = new ethers.Wallet(HARDHAT_ACCOUNTS[2].privateKey, provider);
  const vendorWallet   = new ethers.Wallet(HARDHAT_ACCOUNTS[3].privateKey, provider);
  const vendor         = new ethers.NonceManager(vendorWallet);

  console.log(`👤  Deployer / Relayer : ${deployerWallet.address}`);
  console.log(`📧  Issuer (e-commerce) : ${issuer.address}`);
  console.log(`🏛️   CA                  : ${ca.address}`);
  console.log(`🏪  Vendor esempio       : ${vendorWallet.address}\n`);

  console.log("📦  Deploy dei contratti...\n");

  // ── 1. DIDRegistry ────────────────────────────────────────────────────────
  const didRegistry = await deploy(deployer, "DIDRegistry", []);

  // ── 2. IdentityRegistry ───────────────────────────────────────────────────
  const identityRegistry = await deploy(deployer, "IdentityRegistry", [
    ca.address,     // genesisCA
    issuer.address, // genesisIssuer (usato solo dal DApp backend off-chain)
  ]);

  // ── 3. VendorRegistry ─────────────────────────────────────────────────────
  // Ora riceve anche didRegistry: i vendor devono avere un DID attivo.
  const vendorRegistry = await deploy(deployer, "VendorRegistry", [
    await identityRegistry.getAddress(),
    await didRegistry.getAddress(),
  ]);

  // ── 4. NullifierRegistry ──────────────────────────────────────────────────
  const nullifierRegistry = await deploy(deployer, "NullifierRegistry", []);

  // ── 5. ReputationToken ────────────────────────────────────────────────────
  const reputationToken = await deploy(deployer, "ReputationToken", []);

  // ── 6. ReviewContract ─────────────────────────────────────────────────────
  // Non riceve più IdentityRegistry (verifica PoP ora off-chain).
  // Riceve didRegistry e trustedRelayer (= deployer = DApp backend wallet).
  const reviewContract = await deploy(deployer, "ReviewContract", [
    await nullifierRegistry.getAddress(),
    await vendorRegistry.getAddress(),
    await reputationToken.getAddress(),
    await didRegistry.getAddress(),
    deployerWallet.address,           // trustedRelayer = deployer per la demo
    CURATION_PARAMS.deltaPlus,
    CURATION_PARAMS.deltaMinus,
    CURATION_PARAMS.thetaFixedPoint,
    CURATION_PARAMS.kScaling,
    CURATION_PARAMS.redemptionThreshold,
  ]);

  const reviewContractAddress = await reviewContract.getAddress();

  // ── 7. Wiring post-deploy ─────────────────────────────────────────────────
  console.log("\n🔗  Wiring post-deploy...\n");

  const nullifierArtifact = loadArtifact("NullifierRegistry");
  const nullifierInstance = new ethers.Contract(
    await nullifierRegistry.getAddress(),
    nullifierArtifact.abi,
    deployer
  );
  const tx1 = await nullifierInstance.setReviewContract(reviewContractAddress);
  await tx1.wait();
  console.log(`  ✅  NullifierRegistry.setReviewContract → ${reviewContractAddress}`);

  const reputationArtifact = loadArtifact("ReputationToken");
  const reputationInstance = new ethers.Contract(
    await reputationToken.getAddress(),
    reputationArtifact.abi,
    deployer
  );
  const tx2 = await reputationInstance.setReviewContract(reviewContractAddress);
  await tx2.wait();
  console.log(`  ✅  ReputationToken.setReviewContract   → ${reviewContractAddress}`);

  // ── 8. Registrazione DID degli attori principali ──────────────────────────
  // Nella demo, il deployer registra i DID per conto degli attori di test.
  // In produzione ogni utente registra il proprio DID dalla DApp.
  console.log("\n🆔  Registrazione DID degli attori di test...\n");

  const didArtifact = loadArtifact("DIDRegistry");
  const didInstance = new ethers.Contract(
    await didRegistry.getAddress(),
    didArtifact.abi,
    provider
  );

  // Issuer registra il proprio DID
  const issuerDID = makeDID(issuer.address);
  const txDIDIssuer = await didInstance.connect(issuer).registerDID(
    issuerDID, "issuer-pubkey-demo", "http://localhost:3000"
  );
  await txDIDIssuer.wait();
  console.log(`  ✅  DID registrato (Issuer)  : ${issuerDID}`);

  // CA registra il proprio DID
  const caDID = makeDID(ca.address);
  const txDIDCA = await didInstance.connect(ca).registerDID(
    caDID, "ca-pubkey-demo", ""
  );
  await txDIDCA.wait();
  console.log(`  ✅  DID registrato (CA)      : ${caDID}`);

  // Vendor registra il proprio DID (necessario prima di registerVendor)
  const vendorDID = makeDID(vendorWallet.address);
  const txDIDVendor = await didInstance.connect(vendor).registerDID(
    vendorDID, "vendor-pubkey-demo", "https://techco.example.com"
  );
  await txDIDVendor.wait();
  console.log(`  ✅  DID registrato (Vendor)  : ${vendorDID}`);

  // ── 9. Registrazione Vendor di esempio ───────────────────────────────────
  // La CA firma il Vendor VC e il vendor si registra on-chain.
  console.log("\n🏪  Registrazione Vendor di esempio...\n");

  const LEGAL_NAME = "TechCo S.r.l.";
  const VAT_NUMBER = "IT12345678901";
  const PRODUCT_ID = "LAPTOP-XPS-9510";

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const credentialHash = ethers.keccak256(
    abiCoder.encode(
      ["address", "string", "string"],
      [vendorWallet.address, LEGAL_NAME, VAT_NUMBER]
    )
  );
  const caSig = ca.signingKey.sign(credentialHash);

  const vendorArtifact = loadArtifact("VendorRegistry");
  const vendorInstance = new ethers.Contract(
    await vendorRegistry.getAddress(),
    vendorArtifact.abi,
    provider
  );

  const txVendor = await vendorInstance.connect(vendor).registerVendor(
    vendorWallet.address, LEGAL_NAME, VAT_NUMBER,
    caSig.v, caSig.r, caSig.s
  );
  await txVendor.wait();
  console.log(`  ✅  Vendor registrato: ${LEGAL_NAME} (${vendorWallet.address})`);

  const txProduct = await vendorInstance.connect(vendor).registerProduct(PRODUCT_ID);
  await txProduct.wait();
  console.log(`  ✅  Prodotto registrato: "${PRODUCT_ID}"`);

  // ── 10. Verifica wiring ───────────────────────────────────────────────────
  const nullifierRC  = await nullifierInstance.reviewContract();
  const reputationRC = await reputationInstance.reviewContract();
  if (
    nullifierRC.toLowerCase()  !== reviewContractAddress.toLowerCase() ||
    reputationRC.toLowerCase() !== reviewContractAddress.toLowerCase()
  ) {
    throw new Error("❌  Verifica wiring fallita: gli indirizzi non corrispondono!");
  }
  console.log("\n  ✔   Verifica wiring on-chain: OK");

  // ── 11. Salva deployment.json ─────────────────────────────────────────────
  const deployment = {
    network:    "localhost",
    chainId:    Number(network.chainId),
    deployedAt: new Date().toISOString(),
    contracts: {
      DIDRegistry:       await didRegistry.getAddress(),
      IdentityRegistry:  await identityRegistry.getAddress(),
      VendorRegistry:    await vendorRegistry.getAddress(),
      NullifierRegistry: await nullifierRegistry.getAddress(),
      ReputationToken:   await reputationToken.getAddress(),
      ReviewContract:    reviewContractAddress,
    },
    curationParams: {
      deltaPlus:           CURATION_PARAMS.deltaPlus.toString(),
      deltaMinus:          CURATION_PARAMS.deltaMinus.toString(),
      thetaFixedPoint:     CURATION_PARAMS.thetaFixedPoint.toString(),
      kScaling:            CURATION_PARAMS.kScaling.toString(),
      redemptionThreshold: CURATION_PARAMS.redemptionThreshold.toString(),
    },
    // Il wallet del relayer (deployer) — il DApp backend usa questa chiave
    // per firmare le transazioni on-chain dopo aver verificato le SD-JWT.
    relayer: {
      address:    deployerWallet.address,
      privateKey: HARDHAT_ACCOUNTS[0].privateKey,
    },
    // L'issuer firma le SD-JWT off-chain (non interagisce col contratto)
    issuer: {
      address:    issuer.address,
      privateKey: HARDHAT_ACCOUNTS[1].privateKey,
    },
    ca: {
      address:    ca.address,
      privateKey: HARDHAT_ACCOUNTS[2].privateKey,
    },
    vendor: {
      address:    vendorWallet.address,
      privateKey: HARDHAT_ACCOUNTS[3].privateKey,
      legalName:  LEGAL_NAME,
      vatNumber:  VAT_NUMBER,
      productId:  PRODUCT_ID,
    },
  };

  const outputPath = resolve(ROOT, "deployment.json");
  writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

  console.log(`\n📄  deployment.json scritto in: ${outputPath}`);
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  CONTRATTI DEPLOYATI");
  console.log("═══════════════════════════════════════════════════════");
  for (const [name, address] of Object.entries(deployment.contracts)) {
    console.log(`  ${name.padEnd(22)} ${address}`);
  }
  console.log("═══════════════════════════════════════════════════════");
  console.log("\n🆔  DID registrati:");
  console.log(`  Issuer : ${issuerDID}`);
  console.log(`  CA     : ${caDID}`);
  console.log(`  Vendor : ${vendorDID}`);
  console.log("\n🚀  Prossimi passi:");
  console.log("  1. cd issuer-server && node server.js");
  console.log("  2. node frontend/serve.js");
  console.log("  3. Apri http://localhost:8080\n");
}

main().catch((err) => {
  console.error("\n❌  Deploy fallito:", err.message ?? err);
  process.exit(1);
});
