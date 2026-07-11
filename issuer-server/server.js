/**
 * issuer-server/server.js
 *
 * Micro-server che simula il backend di un e-commerce (l'"Issuer" nel
 * gergo del protocollo TechRate). Espone un endpoint POST /request-pop
 * che, ricevuto l'indirizzo dell'utente e un productId, firma
 * crittograficamente un Proof of Purchase (PoP) compatibile con la
 * funzione ReviewContract._verifyPresentation().
 *
 * === COME FUNZIONA LA FIRMA ===
 *
 * ReviewContract._verifyPresentation() esegue (Solidity):
 *
 *   bytes32 h = keccak256(
 *       abi.encode(
 *           p.userWalletAddress,   // address
 *           p.productIdHash,       // bytes32  = keccak256(bytes(productID))
 *           p.nullifier,           // bytes32  = random, anti-replay
 *           p.sdDigests            // bytes32[] = commitments SD-JWT
 *       )
 *   );
 *   address recovered = ecrecover(h, p.v, p.r, p.s);
 *
 * Quindi:
 *   1. Il payload usa abi.encode (padding completo a 32 byte), NON encodePacked.
 *   2. ecrecover riceve l'hash GREZZO (niente prefisso EIP-191).
 *      → dobbiamo firmare con signingKey.sign(), NON wallet.signMessage().
 *
 * Uso:
 *   cd issuer-server && npm install && npm start
 */

import express    from "express";
import cors       from "cors";
import { ethers } from "ethers";
import { readFileSync }    from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath }   from "url";

// ─── Percorsi ────────────────────────────────────────────────────────────────

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, "..");
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

// Il wallet dell'issuer non ha bisogno di un provider: firma solo offline.
const issuerWallet = new ethers.Wallet(deployment.issuer.privateKey);

// Verifica di integrità: l'indirizzo in deployment.json deve corrispondere
// alla chiave privata caricata.
if (issuerWallet.address.toLowerCase() !== deployment.issuer.address.toLowerCase()) {
  console.error("❌  Mismatch tra issuer.privateKey e issuer.address in deployment.json");
  process.exit(1);
}

// ─── ABI Coder (ethers v6) ────────────────────────────────────────────────────

// ethers.AbiCoder.defaultAbiCoder() produce la stessa codifica di abi.encode()
// in Solidity: ogni tipo primitivo è padded a 32 byte, i tipi dinamici
// (bytes32[]) sono codificati con offset + lunghezza + dati.
const abiCoder = ethers.AbiCoder.defaultAbiCoder();

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// ─── Endpoint: POST /request-pop ─────────────────────────────────────────────

/**
 * Body (JSON):
 *   {
 *     "userAddress": "0x...",    // indirizzo MetaMask del reviewer
 *     "productId":  "SKU-123"    // ID prodotto acquistato (stringa)
 *   }
 *
 * Risposta (JSON) — struttura 1:1 con SDJWTPresentation in Solidity:
 *   {
 *     "issuerWallet":      "0x...",
 *     "userWalletAddress": "0x...",
 *     "productIdHash":     "0x...",  // bytes32
 *     "nullifier":         "0x...",  // bytes32 random
 *     "sdDigests":         ["0x...", "0x..."],  // bytes32[]
 *     "v": 27,                        // uint8
 *     "r": "0x...",                   // bytes32
 *     "s": "0x..."                    // bytes32
 *   }
 */
app.post("/request-pop", async (req, res) => {
  try {
    const { userAddress, productId } = req.body;

    // ── Validazione input ────────────────────────────────────────────────────
    if (!userAddress || !ethers.isAddress(userAddress)) {
      return res.status(400).json({
        error: "Campo 'userAddress' mancante o non è un indirizzo Ethereum valido.",
      });
    }
    if (!productId || typeof productId !== "string" || productId.trim() === "") {
      return res.status(400).json({
        error: "Campo 'productId' mancante o vuoto.",
      });
    }

    const trimmedProductId = productId.trim();

    // ── 1. productIdHash = keccak256(bytes(productID)) ────────────────────────
    // Uguale a quanto fa VendorRegistry.registerProduct() e ReviewContract
    // nel controllo: keccak256(bytes(productID)) != pop.productIdHash
    const productIdHash = ethers.keccak256(ethers.toUtf8Bytes(trimmedProductId));

    // Anti-replay: NullifierRegistry.spend() reverte se questo valore è già
    // stato usato in una precedente submitReview(). Ogni PoP è monouso.
    // Conformemente al WP2/WP3, il nullifier è generato in modo deterministico:
    // Nullifier = Hash(User_ID + Universal_ProductID + Secret_Salt)
    const SECRET_SALT = "TechRate_Issuer_Secret_Salt_v1";
    const nullifier = ethers.keccak256(
      ethers.toUtf8Bytes(userAddress.toLowerCase() + trimmedProductId + SECRET_SALT)
    );

    // ── 3. SD-JWT selective disclosure digests (bytes32[]) ────────────────────
    // In un sistema SD-JWT reale questi sarebbero H(salt || valore_segreto)
    // per ogni claim non divulgato on-chain (indirizzo di spedizione, importo
    // pagato, ecc.). Il contratto non li interpreta: li include nell'hash
    // solo per garantire che non siano stati manomessi (WP2 S2.3 Check 3).
    // Per la demo generiamo digest deterministici ma opachi.
    const sdDigests = [
      // Simulazione del claim "shipping_address" (non divulgato on-chain)
      ethers.keccak256(
        ethers.toUtf8Bytes(`shipping_address:${userAddress}:${trimmedProductId}`)
      ),
      // Simulazione del claim "payment_amount" (non divulgato on-chain)
      ethers.keccak256(
        ethers.toUtf8Bytes(`payment_amount:${trimmedProductId}:demo`)
      ),
    ];

    // ── 4. Hash esatto di _verifyPresentation() ───────────────────────────────
    //
    //   bytes32 h = keccak256(
    //       abi.encode(userWalletAddress, productIdHash, nullifier, sdDigests)
    //   );
    //
    // ethers.AbiCoder.defaultAbiCoder().encode() replica fedelmente
    // abi.encode() di Solidity con padding a 32 byte per ogni tipo.
    const encoded = abiCoder.encode(
      ["address", "bytes32", "bytes32", "bytes32[]"],
      [userAddress, productIdHash, nullifier, sdDigests]
    );
    const hash = ethers.keccak256(encoded);

    // ── 5. Firma con signingKey.sign() (NESSUN prefisso EIP-191) ─────────────
    //
    // ecrecover in Solidity opera sull'hash grezzo, senza prefisso
    // "\x19Ethereum Signed Message\n32". Quindi:
    //   - wallet.signMessage()  → SBAGLIATO (aggiunge il prefisso)
    //   - signingKey.sign(hash) → CORRETTO  (firma il digest diretto)
    //
    // sig.v è già 27 o 28 (recovery id Ethereum-style), come richiesto da ecrecover.
    const sig = issuerWallet.signingKey.sign(hash);

    // ── 6. Risposta ───────────────────────────────────────────────────────────
    const pop = {
      issuerWallet:      issuerWallet.address,
      userWalletAddress: userAddress,
      productIdHash,
      nullifier,
      sdDigests,
      v: sig.v,   // uint8  → 27 | 28
      r: sig.r,   // bytes32
      s: sig.s,   // bytes32
    };

    console.log(
      `📝  PoP firmato | user=${userAddress} | product="${trimmedProductId}" | nullifier=${nullifier.slice(0, 10)}...`
    );
    res.json(pop);

  } catch (err) {
    console.error("❌  Errore in /request-pop:", err);
    res.status(500).json({ error: err.message ?? "Errore interno del server." });
  }
});

// ─── Endpoint: GET /health ────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status:    "ok",
    issuer:    issuerWallet.address,
    network:   deployment.network,
    chainId:   deployment.chainId,
    contracts: deployment.contracts,
  });
});

// ─── Avvio ────────────────────────────────────────────────────────────────────

const PORT = 3000;

app.listen(PORT, () => {
  console.log();
  console.log(`🏪  TechRate Issuer Server — http://localhost:${PORT}`);
  console.log(`🔑  Issuer address : ${issuerWallet.address}`);
  console.log(`🌐  Rete           : ${deployment.network} (chainId=${deployment.chainId})`);
  console.log();
  console.log("📋  Contratti (da deployment.json):");
  for (const [name, addr] of Object.entries(deployment.contracts)) {
    console.log(`    ${name.padEnd(20)} ${addr}`);
  }
  console.log();
  console.log("📡  Endpoint disponibili:");
  console.log(`    POST http://localhost:${PORT}/request-pop`);
  console.log(`    GET  http://localhost:${PORT}/health`);
  console.log();
});
