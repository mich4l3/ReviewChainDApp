/**
 * scripts/deploy.js
 *
 * Deploya tutti e 5 i contratti del protocollo TechRate sulla rete locale
 * Hardhat, esegue il wiring post-deploy (setReviewContract) e salva tutti
 * gli indirizzi + le credenziali degli account di test in deployment.json.
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
// Account[0] → deployer   (owner di tutti i contratti)
// Account[1] → issuer     (backend e-commerce che firma le PoP)
// Account[2] → ca         (Certification Authority che firma i Vendor_VC)

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
];

// ─── Parametri di curation (WP2 S2.6) ────────────────────────────────────────

const CURATION_PARAMS = {
  // Δ+ = 1 punto reputazione per ogni voto concordante col consensus
  deltaPlus: 1n,
  // Δ- = 2 punti persi per voto discordante (deve essere > Δ+, invariante contrattuale)
  deltaMinus: 2n,
  // θ = 0.5 in fixed-point 1e18: zona di neutralità del 50% intorno al consensus
  thetaFixedPoint: ethers.parseEther("0.5"),
  // k = 1e-3: scaling factor per il token reward (importo moderato per la demo)
  kScaling: ethers.parseUnits("1", 15),
  // T_min = 5 token: soglia minima per il Burn-to-Redeem
  redemptionThreshold: ethers.parseEther("5"),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Legge il JSON dell'artifact compilato da Hardhat.
 * La struttura degli artifact è: artifacts/contracts/<Name>.sol/<Name>.json
 */
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

/**
 * Deploya un contratto tramite ethers v6 ContractFactory.
 * Legge il nonce "pending" da remoto prima di ogni transazione per evitare
 * la race-condition di nonce stale che si manifesta con il nodo Hardhat
 * in automining quando ethers v6 usa la cache interna.
 */
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
  console.log(`  ✅  ${contractName.padEnd(20)} → ${address}`);
  return contract;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

  // Verifica connessione al nodo
  const network = await provider.getNetwork();
  console.log(
    `\n🌐  Connesso alla rete: chainId=${network.chainId}\n`
  );

  // Signer: il deployer è wrappato con NonceManager che mantiene un
  // contatore locale incrementale. Questo evita la race-condition con
  // eth_getTransactionCount che si manifesta su Hardhat in automining:
  // il nodo mina la tx istantaneamente ma il provider interrogato con
  // "pending" potrebbe restituire un nonce obsoleto.
  const deployerWallet = new ethers.Wallet(HARDHAT_ACCOUNTS[0].privateKey, provider);
  const deployer = new ethers.NonceManager(deployerWallet);
  const issuer   = new ethers.Wallet(HARDHAT_ACCOUNTS[1].privateKey, provider);
  const ca       = new ethers.Wallet(HARDHAT_ACCOUNTS[2].privateKey, provider);

  console.log(`👤  Deployer : ${deployerWallet.address}`);
  console.log(`🔑  Issuer   : ${issuer.address}   (genesisIssuer → IdentityRegistry)`);
  console.log(`🏛️   CA       : ${ca.address}   (genesisCA → IdentityRegistry)\n`);

  // ── 1. IdentityRegistry ───────────────────────────────────────────────────
  // Il costruttore accetta opzionalmente un CA e un Issuer pre-registrati;
  // passiamo entrambi per evitare transazioni admin aggiuntive nella demo.
  console.log("📦  Deploy dei contratti...\n");
  const identityRegistry = await deploy(deployer, "IdentityRegistry", [
    ca.address,      // genesisCA
    issuer.address,  // genesisIssuer
  ]);

  // ── 1.5 DIDRegistry ───────────────────────────────────────────────────────
  const didRegistry = await deploy(deployer, "DIDRegistry", [
    await identityRegistry.getAddress(),
  ]);

  // ── 2. VendorRegistry ─────────────────────────────────────────────────────
  const vendorRegistry = await deploy(deployer, "VendorRegistry", [
    await identityRegistry.getAddress(),
  ]);

  // ── 3. NullifierRegistry ──────────────────────────────────────────────────
  // Nessun argomento; il reviewer contract viene collegato post-deploy
  // tramite setReviewContract() per evitare la dipendenza circolare.
  const nullifierRegistry = await deploy(deployer, "NullifierRegistry", []);

  // ── 4. ReputationToken ────────────────────────────────────────────────────
  // Stesso pattern di NullifierRegistry.
  const reputationToken = await deploy(deployer, "ReputationToken", []);

  // ── 5. ReviewContract ─────────────────────────────────────────────────────
  const reviewContract = await deploy(deployer, "ReviewContract", [
    await nullifierRegistry.getAddress(),
    await vendorRegistry.getAddress(),
    await reputationToken.getAddress(),
    await didRegistry.getAddress(),
    await identityRegistry.getAddress(),
    CURATION_PARAMS.deltaPlus,
    CURATION_PARAMS.deltaMinus,
    CURATION_PARAMS.thetaFixedPoint,
    CURATION_PARAMS.kScaling,
    CURATION_PARAMS.redemptionThreshold,
  ]);

  const reviewContractAddress = await reviewContract.getAddress();

  // ── 5.5 Registrazione DID per il Deployer (Account 0) ─────────────────────
  console.log("\n👤  Registrazione DID per il Deployer...");
  const didArtifact = loadArtifact("DIDRegistry");
  const didInstance = new ethers.Contract(
    await didRegistry.getAddress(),
    didArtifact.abi,
    deployer
  );
  const deployerDID = "did:ethr:" + deployerWallet.address.toLowerCase();
  const txDID = await didInstance.registerDID(deployerDID, "pubkey-deployer", "");
  await txDID.wait();
  console.log(`  ✅  Deployer DID registrato: ${deployerDID}`);

  // ── 6. Wiring post-deploy ─────────────────────────────────────────────────
  // NullifierRegistry e ReputationToken espongono setReviewContract(),
  // da chiamare una volta sola; il contratto reverte con AlreadyInitialized
  // se chiamato di nuovo (protezione built-in).
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

  // ── 7. Verifica on-chain del wiring ───────────────────────────────────────
  const nullifierReviewContract = await nullifierInstance.reviewContract();
  const reputationReviewContract = await reputationInstance.reviewContract();

  if (
    nullifierReviewContract.toLowerCase() !== reviewContractAddress.toLowerCase() ||
    reputationReviewContract.toLowerCase() !== reviewContractAddress.toLowerCase()
  ) {
    throw new Error("❌  Verifica wiring fallita: gli indirizzi non corrispondono!");
  }
  console.log("\n  ✔   Verifica wiring on-chain: OK");

  // ── 7.5 Vendor Onboarding Demo ───────────────────────────────────────────
  console.log("\n🏬  Registrazione Vendor (Demo)...");
  const vendorWallet = new ethers.Wallet(HARDHAT_ACCOUNTS[3].privateKey, provider);
  const vendorDID = "did:ethr:" + vendorWallet.address.toLowerCase();
  
  const vendorRegistryArtifact = loadArtifact("VendorRegistry");
  const vendorRegistryInstance = new ethers.Contract(
    await vendorRegistry.getAddress(),
    vendorRegistryArtifact.abi,
    issuer // Issuer is the sponsor
  );
  
  const txVendor = await vendorRegistryInstance.issuerRegisterVendor(vendorWallet.address, "Demo Vendor S.r.l.", "IT00000000000");
  await txVendor.wait();
  
  const txVendorDID = await didInstance.connect(issuer).issuerRegisterDID(
    vendorWallet.address, vendorDID, "pubkey-vendor", ""
  );
  await txVendorDID.wait();
  
  console.log(`  ✅  Vendor registrato: ${vendorWallet.address}`);
  console.log(`  ✅  Vendor DID: ${vendorDID}`);

  // ── 8. Salva deployment.json ──────────────────────────────────────────────
  const deployment = {
    network: "localhost",
    chainId: Number(network.chainId),
    deployedAt: new Date().toISOString(),
    contracts: {
      IdentityRegistry: await identityRegistry.getAddress(),
      VendorRegistry:   await vendorRegistry.getAddress(),
      NullifierRegistry: await nullifierRegistry.getAddress(),
      ReputationToken:  await reputationToken.getAddress(),
      DIDRegistry:      await didRegistry.getAddress(),
      ReviewContract:   reviewContractAddress,
    },
    curationParams: {
      deltaPlus:            CURATION_PARAMS.deltaPlus.toString(),
      deltaMinus:           CURATION_PARAMS.deltaMinus.toString(),
      thetaFixedPoint:      CURATION_PARAMS.thetaFixedPoint.toString(),
      kScaling:             CURATION_PARAMS.kScaling.toString(),
      redemptionThreshold:  CURATION_PARAMS.redemptionThreshold.toString(),
    },
    issuer: {
      address:    issuer.address,
      privateKey: HARDHAT_ACCOUNTS[1].privateKey,
    },
    ca: {
      address:    ca.address,
      privateKey: HARDHAT_ACCOUNTS[2].privateKey,
    },
    deployer: {
      address:    deployerWallet.address,
      privateKey: HARDHAT_ACCOUNTS[0].privateKey,
    },
    vendor: {
      address:    vendorWallet.address,
      did:        vendorDID,
    },
  };

  const outputPath = resolve(ROOT, "deployment.json");
  writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

  console.log(`\n📄  deployment.json scritto in: ${outputPath}`);
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  CONTRATTI DEPLOYATI");
  console.log("═══════════════════════════════════════════════════════");
  for (const [name, address] of Object.entries(deployment.contracts)) {
    console.log(`  ${name.padEnd(20)} ${address}`);
  }
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\n❌  Deploy fallito:", err.message ?? err);
  process.exit(1);
});
