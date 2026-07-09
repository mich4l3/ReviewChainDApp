/**
 * issuer-server/server.js
 *
 * Micro-server che svolge due ruoli distinti nel protocollo TechRate:
 *
 *   1. ISSUER (e-commerce): endpoint POST /request-pop
 *      Riceve l'indirizzo dell'utente e un productId, costruisce una
 *      SD-JWT Proof of Purchase off-chain e la firma con ES256K (secp256k1).
 *      La SD-JWT non viene mai inviata direttamente al contratto.
 *
 *   2. DAPP RELAYER: endpoint POST /submit-review
 *      Riceve la SD-JWT già firmata + i dati della recensione dal frontend,
 *      verifica la SD-JWT off-chain (firma issuer + selective disclosure),
 *      e invia la transazione submitReview() al contratto usando il wallet
 *      del relayer (deployer). Il frontend non tocca mai il contratto.
 *
 * Architettura:
 *   Frontend → POST /request-pop → (SD-JWT off-chain) → Frontend
 *   Frontend → POST /submit-review → verifica SD-JWT → tx on-chain
 *
 * NOTA ACCADEMICA (WP4):
 *   La "SD-JWT classica" qui è simulata tramite abi.encode + firma secp256k1
 *   per compatibilità con la rete Hardhat locale. In produzione si userebbe
 *   il formato JWT testuale (jose library) con firma RS256 o ES256 (P-256).
 *   L'architettura è identica: l'issuer firma off-chain, il relayer verifica
 *   off-chain, il contratto riceve solo address + nullifier già estratti.
 *
 * Uso:
 *   cd issuer-server && npm install && node server.js
 */

import express         from "express";
import cors            from "cors";
import { ethers }      from "ethers";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath }    from "url";

// ─── Percorsi ────────────────────────────────────────────────────────────────

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, "..");
const DEPLOY_PATH = resolve(ROOT, "deployment.json");

// ─── Carica deployment.json ───────────────────────────────────────────────────

let deployment;
try {
  deployment = JSON.parse(readFileSync(DEPLOY_PATH, "utf8"));
} catch (err) {
  console.error(
    `❌  Impossibile leggere ${DEPLOY_PATH}.\n` +
    `    Esegui prima: npx hardhat run scripts/deploy.js --network localhost\n`,
    err.message
  );
  process.exit(1);
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

// Il wallet dell'ISSUER (e-commerce) firma le SD-JWT off-chain.
// Non ha bisogno di un provider: firma solo in memoria.
const issuerWallet = new ethers.Wallet(deployment.issuer.privateKey);

// Il wallet del RELAYER (DApp backend) invia le transazioni on-chain.
// Ha bisogno del provider per connettersi al nodo Hardhat.
const provider       = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const relayerWallet  = new ethers.Wallet(deployment.relayer.privateKey, provider);
const relayer        = new ethers.NonceManager(relayerWallet);

// Verifica di integrità
if (issuerWallet.address.toLowerCase() !== deployment.issuer.address.toLowerCase()) {
  console.error("❌  Mismatch tra issuer.privateKey e issuer.address in deployment.json");
  process.exit(1);
}
if (relayerWallet.address.toLowerCase() !== deployment.relayer.address.toLowerCase()) {
  console.error("❌  Mismatch tra relayer.privateKey e relayer.address in deployment.json");
  process.exit(1);
}

// ─── ABI ─────────────────────────────────────────────────────────────────────

const REVIEW_CONTRACT_ABI = [
  `function submitReview(address reviewer, string productID, string cid, uint8 score, bytes32 nullifier) returns (uint256)`,
  `function reviewCount() view returns (uint256)`,
  `function reputationScore(address) view returns (uint256)`,
  `event ReviewSubmitted(uint256 indexed reviewId, address indexed reviewerAddress, string productID, uint8 score, string cid, uint256 timestamp)`,
];

const reviewContract = new ethers.Contract(
  deployment.contracts.ReviewContract,
  REVIEW_CONTRACT_ABI,
  relayer  // il relayer firma tutte le transazioni
);

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

// ─── Helper: costruisce la firma dell'Issuer sulla SD-JWT ────────────────────

/**
 * Costruisce il "payload" della SD-JWT (versione EVM-compatibile) e lo firma.
 *
 * In un sistema SD-JWT standard (RFC):
 *   - I claim segreti vengono hashati con un salt: H(salt || valore)
 *   - Il payload JWT contiene un array "_sd" con tutti gli hash
 *   - I claim rivelati vengono allegati come "disclosures" in chiaro
 *
 * Qui usiamo lo stesso schema matematico ma con abi.encode invece di JSON:
 *   - sdDigests = array di H(claim_segreto) (shipping address, importo, ecc.)
 *   - Il payload firmato contiene i claim rivelati + sdDigests
 *
 * @param {string} userAddress   Indirizzo Ethereum del reviewer
 * @param {string} productId     ID prodotto acquistato
 * @returns {{ payload, nullifier, sdDigests, sig }}
 */
function buildSDJWT(userAddress, productId) {
  const trimmedProductId = productId.trim();
  const productIdHash    = ethers.keccak256(ethers.toUtf8Bytes(trimmedProductId));

  // Nullifier deterministico: H(user || product || salt)
  // In produzione sarebbe un valore casuale monouso memorizzato nel DB.
  const SECRET_SALT = "TechRate_Issuer_Secret_Salt_v1";
  const nullifier   = ethers.keccak256(
    ethers.toUtf8Bytes(userAddress.toLowerCase() + trimmedProductId + SECRET_SALT)
  );

  // SD-JWT digests: claim sensibili non rivelati on-chain
  // (indirizzo di spedizione, importo pagato, data acquisto, ecc.)
  const sdDigests = [
    ethers.keccak256(ethers.toUtf8Bytes(`shipping_address:${userAddress}:${trimmedProductId}`)),
    ethers.keccak256(ethers.toUtf8Bytes(`payment_amount:${trimmedProductId}:demo`)),
    ethers.keccak256(ethers.toUtf8Bytes(`purchase_date:${Date.now()}`)),
  ];

  // Hash del payload completo (equivalente al "protected header" del JWT)
  // Contiene sia i claim rivelati che gli hash dei claim nascosti.
  const encoded = abiCoder.encode(
    ["address", "bytes32", "bytes32", "bytes32[]"],
    [userAddress, productIdHash, nullifier, sdDigests]
  );
  const payloadHash = ethers.keccak256(encoded);

  // Firma grezza (no prefisso EIP-191) con la chiave privata dell'Issuer
  const sig = issuerWallet.signingKey.sign(payloadHash);

  return {
    userAddress,
    productIdHash,
    nullifier,
    sdDigests,
    payloadHash,
    sig: { v: sig.v, r: sig.r, s: sig.s },
    issuerAddress: issuerWallet.address,
  };
}

/**
 * Verifica la SD-JWT off-chain:
 *   1. Ricostruisce il payload hash dai claim rivelati + sdDigests
 *   2. Controlla che la firma corrisponda a un Issuer fidato
 *
 * Questa è la funzione che in produzione chiamerebbe jose.compactVerify()
 * con la chiave pubblica RSA/P-256 dell'Issuer.
 *
 * @returns {{ valid: boolean, reviewerAddress: string, nullifier: string }}
 */
function verifySDJWT(sdjwt) {
  const { userAddress, productIdHash, nullifier, sdDigests, sig } = sdjwt;

  // Ricostruisci il payload hash
  const encoded = abiCoder.encode(
    ["address", "bytes32", "bytes32", "bytes32[]"],
    [userAddress, productIdHash, nullifier, sdDigests]
  );
  const payloadHash = ethers.keccak256(encoded);

  // Recupera l'indirizzo del firmatario
  const recovered = ethers.recoverAddress(payloadHash, {
    v: sig.v, r: sig.r, s: sig.s,
  });

  // Controlla che il firmatario sia un Issuer fidato
  const isTrustedIssuer =
    recovered.toLowerCase() === deployment.issuer.address.toLowerCase();

  return {
    valid:           isTrustedIssuer,
    recoveredIssuer: recovered,
    reviewerAddress: userAddress,
    nullifier,
  };
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ─── Endpoint: POST /request-pop ─────────────────────────────────────────────
/**
 * L'e-commerce emette una SD-JWT Proof of Purchase e la restituisce al
 * frontend (Holder). La SD-JWT non viene inviata al contratto: verrà
 * presentata al /submit-review endpoint insieme alla recensione.
 *
 * Body:   { userAddress: "0x...", productId: "SKU-123" }
 * Risposta: { sdjwt: { ...payload + firma }, issuerAddress: "0x..." }
 */
app.post("/request-pop", async (req, res) => {
  try {
    const { userAddress, productId } = req.body;

    if (!userAddress || !ethers.isAddress(userAddress)) {
      return res.status(400).json({ error: "Campo 'userAddress' mancante o non valido." });
    }
    if (!productId || typeof productId !== "string" || productId.trim() === "") {
      return res.status(400).json({ error: "Campo 'productId' mancante o vuoto." });
    }

    const sdjwt = buildSDJWT(userAddress, productId);

    console.log(
      `📝  SD-JWT emessa | user=${userAddress} | product="${productId.trim()}" | nullifier=${sdjwt.nullifier.slice(0, 10)}...`
    );

    res.json({
      sdjwt,
      issuerAddress: issuerWallet.address,
      productId:     productId.trim(),
    });

  } catch (err) {
    console.error("❌  Errore in /request-pop:", err);
    res.status(500).json({ error: err.message ?? "Errore interno del server." });
  }
});

// ─── Endpoint: POST /submit-review ────────────────────────────────────────────
/**
 * Il DAPP RELAYER riceve la SD-JWT + la recensione dal frontend,
 * verifica la SD-JWT off-chain, e invia la transazione on-chain.
 *
 * Il frontend NON chiama più ReviewContract direttamente.
 * Solo il relayer (questo server) ha il wallet che può chiamare submitReview().
 *
 * Body:
 *   {
 *     sdjwt:      { ...SD-JWT object from /request-pop },
 *     productId:  "SKU-123",
 *     cid:        "bafybeig...",
 *     score:      5,
 *   }
 *
 * Risposta:
 *   { success: true, txHash: "0x...", reviewId: 1 }
 */
app.post("/submit-review", async (req, res) => {
  try {
    const { sdjwt, productId, cid, score } = req.body;

    // ── Validazione input ────────────────────────────────────────────────────
    if (!sdjwt || !sdjwt.userAddress || !sdjwt.nullifier) {
      return res.status(400).json({ error: "Campo 'sdjwt' mancante o incompleto." });
    }
    if (!productId || typeof productId !== "string") {
      return res.status(400).json({ error: "Campo 'productId' mancante." });
    }
    if (!cid || typeof cid !== "string") {
      return res.status(400).json({ error: "Campo 'cid' mancante." });
    }
    if (!score || score < 1 || score > 5) {
      return res.status(400).json({ error: "Campo 'score' deve essere tra 1 e 5." });
    }

    // ── Verifica SD-JWT off-chain ────────────────────────────────────────────
    console.log(`🔍  Verifica SD-JWT per user=${sdjwt.userAddress}...`);
    const { valid, recoveredIssuer, reviewerAddress, nullifier } = verifySDJWT(sdjwt);

    if (!valid) {
      console.warn(`⚠️  SD-JWT non valida! Recovered issuer: ${recoveredIssuer}`);
      return res.status(401).json({
        error: `SD-JWT non valida. Issuer recuperato: ${recoveredIssuer}, atteso: ${deployment.issuer.address}`,
      });
    }

    console.log(`✅  SD-JWT valida | Issuer: ${recoveredIssuer} | Reviewer: ${reviewerAddress}`);

    // ── Invio transazione on-chain (come Relayer) ────────────────────────────
    console.log(`⛓️  Invio submitReview() on-chain come relayer (${relayerWallet.address})...`);

    const tx = await reviewContract.submitReview(
      reviewerAddress,
      productId.trim(),
      cid,
      score,
      nullifier
    );

    console.log(`📤  TX inviata: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅  TX confermata nel blocco ${receipt.blockNumber}`);

    // Estrai reviewId dall'evento ReviewSubmitted
    let reviewId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = reviewContract.interface.parseLog({
          topics: log.topics,
          data:   log.data,
        });
        if (parsed?.name === "ReviewSubmitted") {
          reviewId = parsed.args.reviewId.toString();
          break;
        }
      } catch { /* log non pertinente */ }
    }

    console.log(`🏆  Review #${reviewId} pubblicata on-chain!`);

    res.json({
      success:  true,
      txHash:   tx.hash,
      reviewId,
      reviewer: reviewerAddress,
    });

  } catch (err) {
    console.error("❌  Errore in /submit-review:", err);

    // Restituisce errori Solidity leggibili
    const message = err.reason ?? err.data?.message ?? err.message ?? "Errore interno";
    const status  = message.includes("AlreadySpent") ? 409 : 500;
    res.status(status).json({ error: message });
  }
});

// ─── Endpoint: GET /health ────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status:   "ok",
    issuer:   issuerWallet.address,
    relayer:  relayerWallet.address,
    network:  deployment.network,
    chainId:  deployment.chainId,
    contracts: deployment.contracts,
  });
});

// ─── Avvio ────────────────────────────────────────────────────────────────────

const PORT = 3000;

app.listen(PORT, () => {
  console.log();
  console.log(`🏪  TechRate DApp Server — http://localhost:${PORT}`);
  console.log(`📧  Issuer (e-commerce) : ${issuerWallet.address}`);
  console.log(`🚀  Relayer (DApp)       : ${relayerWallet.address}`);
  console.log(`🌐  Rete                 : ${deployment.network} (chainId=${deployment.chainId})`);
  console.log();
  console.log("📋  Contratti:");
  for (const [name, addr] of Object.entries(deployment.contracts)) {
    console.log(`    ${name.padEnd(22)} ${addr}`);
  }
  console.log();
  console.log("📡  Endpoint:");
  console.log(`    POST http://localhost:${PORT}/request-pop      ← Issuer emette SD-JWT`);
  console.log(`    POST http://localhost:${PORT}/submit-review    ← Relayer verifica + invia tx`);
  console.log(`    GET  http://localhost:${PORT}/health`);
  console.log();
});
