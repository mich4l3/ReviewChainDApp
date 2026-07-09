/**
 * frontend/app.js
 *
 * Logica della dApp TechRate — aggiornata per l'architettura con Relayer.
 *
 * ARCHITETTURA (post-refactoring):
 *
 *   PRIMA:
 *     Frontend → POST /request-pop (Issuer) → SDJWTPresentation
 *     Frontend → reviewContract.submitReview(SDJWTPresentation, ...)  ← tx firmata da MetaMask
 *
 *   ADESSO:
 *     Frontend → POST /request-pop (Issuer)   → SD-JWT object
 *     Frontend → POST /submit-review (Relayer) → il server verifica la SD-JWT off-chain
 *                                                  e invia la tx on-chain col wallet del relayer
 *
 * Il frontend NON firma più nessuna transazione smart contract per le recensioni.
 * MetaMask viene usato SOLO per:
 *   - Leggere il wallet address dell'utente
 *   - Registrare il DID dell'utente (operazione diretta, nessun relayer necessario)
 *
 * Dipende da window.ethers (caricato via CDN UMD in index.html).
 */

"use strict";

// ─── Costanti ─────────────────────────────────────────────────────────────────

const DAPP_SERVER_URL  = "http://localhost:3000";   // issuer-server (ora anche relayer)
const HARDHAT_NODE_URL = "http://127.0.0.1:8545";
const HARDHAT_CHAIN_ID = 31337;
const SECONDS_31_DAYS  = 31 * 24 * 60 * 60;

// ─── ABI minimali ────────────────────────────────────────────────────────────
// Il frontend ora usa il contratto SOLO per chiamate di lettura (view) e
// per la registrazione DID (che il reviewer fa con il suo wallet).
// submitReview() è chiamato solo dal relayer (server-side).

const REVIEW_CONTRACT_ABI = [
  // ── Funzioni view ──
  `function reviewCount() view returns (uint256)`,
  `function reputationScore(address) view returns (uint256)`,
  `function registered(address) view returns (bool)`,
  `function CURATION_WINDOW() view returns (uint256)`,
  `function reviews(uint256) view returns (
     address reviewer,
     bytes32 productIdHash,
     address vendor,
     string  cid,
     uint8   score,
     uint64  submittedAt,
     uint64  windowStart,
     bool    modified,
     bool    revoked,
     bool    curationClosed,
     bool    includedInAggregation,
     uint256 upvoteWeight,
     uint256 downvoteWeight,
     uint256 reputationAtSubmission
   )`,
  // ── finalizeCuration è ancora chiamato direttamente (chiunque può farlo) ──
  `function finalizeCuration(uint256 reviewId)`,
  // ── Events ──
  `event ReviewSubmitted(uint256 indexed reviewId, address indexed reviewerAddress, string productID, uint8 score, string cid, uint256 timestamp)`,
  `event CurationFinalized(uint256 indexed reviewId, uint256 consensus, uint256 upvoteWeight, uint256 downvoteWeight)`,
  `event ReviewerRewarded(uint256 indexed reviewId, address indexed reviewer, uint256 tokens)`,
];

const REPUTATION_TOKEN_ABI = [
  `function balanceOf(address) view returns (uint256)`,
  `function symbol() view returns (string)`,
  `function totalSupply() view returns (uint256)`,
];

const DID_REGISTRY_ABI = [
  `function registerDID(string did, string publicKey, string serviceEndpoint)`,
  `function isActiveByOwner(address owner) view returns (bool)`,
  `function documentOf(address owner) view returns (
     address owner,
     string publicKey,
     string serviceEndpoint,
     uint256 createdAt,
     uint256 updatedAt,
     bool active
   )`,
  `event DIDRegistered(address indexed owner, string did, string publicKey, uint256 timestamp)`,
];

// ─── Stato applicazione ───────────────────────────────────────────────────────

let provider, signer, userAddress;
let deployment;
let reviewContract, reputationToken, didRegistry;
let lastReviewId  = null;
let userHasDID    = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch("/deployment.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    deployment = await res.json();
    renderContractAddresses();
    logActivity("📄 deployment.json caricato correttamente.");
  } catch (err) {
    showToast(
      "❌ Impossibile caricare deployment.json. Avvia prima: " +
      "(1) npx hardhat node  (2) npx hardhat run scripts/deploy.js  (3) node frontend/serve.js",
      "error"
    );
    logActivity("❌ deployment.json non trovato: " + err.message, "error");
    return;
  }

  if (!window.ethereum) {
    showToast("🦊 MetaMask non trovato. Installalo su https://metamask.io/", "error");
    logActivity("❌ window.ethereum non disponibile.", "error");
    document.getElementById("btn-connect").textContent = "MetaMask non trovato";
    document.getElementById("btn-connect").disabled = true;
    return;
  }

  window.ethereum.on("accountsChanged", (accounts) => {
    if (accounts.length === 0) {
      window.location.reload();
    } else {
      userAddress = ethers.getAddress(accounts[0]);
      document.getElementById("wallet-address").textContent = shortAddr(userAddress);
      refreshStats();
      checkDIDStatus();
      logActivity("🔄 Account cambiato: " + userAddress);
    }
  });

  window.ethereum.on("chainChanged", () => window.location.reload());
}

// ─── Connessione Wallet ───────────────────────────────────────────────────────

async function connectWallet() {
  const btn = document.getElementById("btn-connect");
  btn.disabled  = true;
  btn.textContent = "Connessione...";

  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);

    const network = await provider.getNetwork();
    if (Number(network.chainId) !== HARDHAT_CHAIN_ID) {
      throw new Error(
        `Rete sbagliata! chainId attuale: ${network.chainId}. ` +
        `Aggiungi la rete Hardhat Local (chainId 31337, RPC http://127.0.0.1:8545) a MetaMask.`
      );
    }

    signer      = await provider.getSigner();
    userAddress = await signer.getAddress();

    // Istanzia i contratti (solo lettura + DID registration)
    reviewContract = new ethers.Contract(
      deployment.contracts.ReviewContract,
      REVIEW_CONTRACT_ABI,
      signer
    );
    reputationToken = new ethers.Contract(
      deployment.contracts.ReputationToken,
      REPUTATION_TOKEN_ABI,
      signer
    );
    didRegistry = new ethers.Contract(
      deployment.contracts.DIDRegistry,
      DID_REGISTRY_ABI,
      signer
    );

    updateWalletUI();
    await refreshStats();
    await checkDIDStatus();

    showToast("✅ Wallet connesso!", "success");
    logActivity(`🦊 Wallet connesso: ${userAddress}`, "success");
    setStep(1, "done");

  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<span>🦊</span> Connetti MetaMask';
    if (err.code === 4001) {
      showToast("❌ Connessione rifiutata dall'utente.", "warning");
    } else {
      showToast("❌ " + err.message, "error");
      logActivity("❌ Errore connessione: " + err.message, "error");
    }
  }
}

// ─── Controllo e Registrazione DID ───────────────────────────────────────────

async function checkDIDStatus() {
  if (!didRegistry || !userAddress) return;
  try {
    userHasDID = await didRegistry.isActiveByOwner(userAddress);
    const didBanner = document.getElementById("did-banner");
    const btnSubmit = document.getElementById("btn-submit");

    if (userHasDID) {
      if (didBanner) didBanner.classList.add("hidden");
      if (btnSubmit) btnSubmit.disabled = false;
      logActivity(`🆔 DID attivo per ${shortAddr(userAddress)}`, "success");
    } else {
      if (didBanner) didBanner.classList.remove("hidden");
      if (btnSubmit) {
        btnSubmit.disabled = true;
        document.getElementById("btn-submit-text").textContent =
          "Registra prima il tuo DID ↑";
      }
      logActivity("⚠️ Nessun DID attivo trovato. Registra il tuo DID per inviare recensioni.", "warning");
    }
  } catch (err) {
    console.warn("[checkDIDStatus]", err.message);
  }
}

async function registerDID() {
  const btn = document.getElementById("btn-register-did");
  btn.disabled = true;
  btn.textContent = "Registrazione...";

  try {
    const did = `did:ethr:${userAddress.toLowerCase()}`;
    logActivity(`🆔 Registrazione DID: ${did}...`);

    // La registrazione DID è l'unica tx che l'utente firma direttamente
    // con il suo wallet MetaMask (non passa dal relayer).
    const tx = await didRegistry.registerDID(did, "metamask-wallet-pubkey", "");
    logActivity(`📤 TX DID inviata: ${tx.hash.slice(0, 18)}...`);
    await tx.wait();

    userHasDID = true;
    logActivity(`✅ DID registrato con successo: ${did}`, "success");
    showToast("✅ DID registrato! Ora puoi inviare recensioni.", "success");
    await checkDIDStatus();

  } catch (err) {
    const msg = parseContractError(err);
    showToast("❌ " + msg, "error");
    logActivity("❌ Errore registrazione DID: " + msg, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🆔 Registra il mio DID";
  }
}

// ─── IPFS Upload (Mock) ───────────────────────────────────────────────────────

async function uploadToIPFS(text) {
  logActivity("🌐 Generazione CID IPFS...", "loading");

  const BASE32  = "abcdefghijklmnopqrstuvwxyz234567";
  const data    = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const bytes   = new Uint8Array(hashBuf);

  let b32 = "";
  for (let i = 0; i < bytes.length; i++) {
    b32 += BASE32[bytes[i] & 31];
    b32 += BASE32[(bytes[i] >> 3) & 31];
  }

  const cid = "bafybeig" + b32.slice(0, 51);
  await delay(400);
  logActivity(`📎 CID: ${cid.slice(0, 24)}...`, "success");
  return cid;
}

// ─── Invio Recensione (via Relayer) ──────────────────────────────────────────

async function submitReview() {
  const productId  = document.getElementById("productId").value.trim();
  const reviewText = document.getElementById("reviewText").value.trim();
  const scoreEl    = document.querySelector('input[name="score"]:checked');
  const score      = scoreEl ? parseInt(scoreEl.value, 10) : 3;

  if (!productId)             { showToast("⚠️ Inserisci un Product ID.", "warning"); return; }
  if (reviewText.length < 10) { showToast("⚠️ Recensione troppo breve (min 10 caratteri).", "warning"); return; }
  if (score < 1 || score > 5) { showToast("⚠️ Seleziona una valutazione da 1 a 5 stelle.", "warning"); return; }
  if (!userHasDID)            { showToast("⚠️ Registra prima il tuo DID.", "warning"); return; }

  setSubmitLoading(true);

  try {
    // ── Step 2: Richiesta SD-JWT all'Issuer (e-commerce) ──────────────────
    setStep(2, "active");
    logActivity(`📬 Richiesta SD-JWT all'Issuer per "${productId}"...`);

    const popRes = await fetch(`${DAPP_SERVER_URL}/request-pop`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userAddress, productId }),
    }).catch(() => {
      throw new Error(
        "Impossibile contattare il server su " + DAPP_SERVER_URL +
        ". Assicurati che sia in esecuzione con: cd issuer-server && node server.js"
      );
    });

    if (!popRes.ok) {
      const errBody = await popRes.json().catch(() => ({}));
      throw new Error("Issuer error: " + (errBody.error ?? popRes.statusText));
    }

    const { sdjwt } = await popRes.json();
    setStep(2, "done");
    logActivity(
      `✅ SD-JWT ricevuta | nullifier: ${sdjwt.nullifier.slice(0, 10)}...`,
      "success"
    );

    // ── Step 3: Caricamento IPFS ─────────────────────────────────────────
    setStep(3, "active");
    const cid = await uploadToIPFS(reviewText);
    setStep(3, "done");

    // ── Step 4: Invio al Relayer (DApp backend) ───────────────────────────
    // Il frontend NON firma nessuna transazione. Invia i dati al server
    // che verificherà la SD-JWT e invierà la tx on-chain come relayer.
    setStep(4, "active");
    logActivity(`🚀 Invio al DApp Relayer per verifica e relay on-chain...`);

    const relayRes = await fetch(`${DAPP_SERVER_URL}/submit-review`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sdjwt, productId, cid, score }),
    }).catch(() => {
      throw new Error("Impossibile contattare il Relayer su " + DAPP_SERVER_URL);
    });

    if (!relayRes.ok) {
      const errBody = await relayRes.json().catch(() => ({}));
      throw new Error("Relayer error: " + (errBody.error ?? relayRes.statusText));
    }

    const result = await relayRes.json();
    setStep(4, "done");

    lastReviewId = BigInt(result.reviewId);
    document.getElementById("last-review-id").textContent = result.reviewId;
    document.getElementById("btn-finalize").disabled = false;

    logActivity(
      `✅ Review #${result.reviewId} pubblicata! Score: ${"★".repeat(score)} | TX: ${result.txHash.slice(0, 18)}...`,
      "success"
    );
    showToast(`✅ Recensione inviata! (${score}/5 stelle, Review #${result.reviewId})`, "success");
    await refreshStats();

    document.getElementById("reviewText").value = "";
    document.getElementById("char-count").textContent = "0";

  } catch (err) {
    console.error("[submitReview]", err);
    const msg = parseContractError(err);
    showToast("❌ " + msg, "error");
    logActivity("❌ Errore invio: " + msg, "error");
    setStep(1, "done");
  } finally {
    setSubmitLoading(false);
  }
}

// ─── Time Travel ─────────────────────────────────────────────────────────────

async function timeTravel() {
  const btn = document.getElementById("btn-time-travel");
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Avanzando...';

  try {
    logActivity("⏩ evm_increaseTime(2678400) → Salto di 31 giorni...");

    const rpc = async (method, params = []) => {
      const res = await fetch(HARDHAT_NODE_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    };

    await rpc("evm_increaseTime", [SECONDS_31_DAYS]);
    await rpc("evm_mine");

    const block   = await rpc("eth_getBlockByNumber", ["latest", false]);
    const ts      = parseInt(block.timestamp, 16);
    const dateStr = new Date(ts * 1000).toLocaleString("it-IT");

    showToast(`⏩ Blockchain avanzata di 31 giorni! (${dateStr})`, "success");
    logActivity(`✅ Timestamp blockchain: ${dateStr} — Curation Window chiusa.`, "success");

    if (lastReviewId !== null) {
      document.getElementById("btn-finalize").disabled = false;
    }

  } catch (err) {
    const msg = err.message ?? err.toString();
    showToast("❌ Time travel fallito: " + msg, "error");
    logActivity("❌ Time travel error: " + msg, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>⏩</span> Salta 31 Giorni';
  }
}

// ─── Finalizza Curation ───────────────────────────────────────────────────────
// finalizeCuration può essere chiamata da chiunque (nessun privilegio speciale).
// Il frontend la chiama direttamente con MetaMask.

async function finalizeCuration() {
  if (lastReviewId === null) {
    showToast("⚠️ Nessuna recensione da finalizzare. Invia prima una recensione.", "warning");
    return;
  }

  const btn = document.getElementById("btn-finalize");
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Finalizzando...';

  try {
    logActivity(`🏆 Finalizzazione Review #${lastReviewId}...`);

    const tx = await reviewContract.finalizeCuration(lastReviewId);
    logActivity(`📤 TX: ${tx.hash.slice(0, 18)}...`);

    const receipt = await tx.wait();
    let consensusStr = "n/a";
    let rewardStr    = null;

    for (const log of receipt.logs) {
      try {
        const parsed = reviewContract.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "CurationFinalized") {
          const pct = Number(parsed.args.consensus) * 100 / 1e18;
          consensusStr = pct.toFixed(1) + "% upvotes";
          logActivity(`📊 Consensus: ${consensusStr}`, "success");
        }
        if (parsed?.name === "ReviewerRewarded") {
          rewardStr = ethers.formatEther(parsed.args.tokens);
          logActivity(`🏆 Reviewer ricompensato: ${rewardStr} RWT`, "success");
        }
      } catch { /* skip */ }
    }

    const toastMsg = rewardStr
      ? `✅ Curation chiusa! Reward: ${rewardStr} RWT (consensus: ${consensusStr})`
      : `✅ Curation chiusa! (consensus: ${consensusStr})`;

    showToast(toastMsg, "success");
    await refreshStats();

  } catch (err) {
    const msg = parseContractError(err);
    showToast("❌ " + msg, "error");
    logActivity("❌ Errore finalizzazione: " + msg, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>🏆</span> Finalizza Curation';
  }
}

// ─── Refresh Stats ────────────────────────────────────────────────────────────

async function refreshStats() {
  if (!signer || !reputationToken || !reviewContract) return;
  try {
    const [balance, rep] = await Promise.all([
      reputationToken.balanceOf(userAddress),
      reviewContract.reputationScore(userAddress),
    ]);
    document.getElementById("stat-rwt").textContent =
      parseFloat(ethers.formatEther(balance)).toFixed(3);
    document.getElementById("stat-reputation").textContent = rep.toString();
  } catch (err) {
    console.warn("[refreshStats]", err.message);
  }
}

// ─── Parsing errori Solidity ──────────────────────────────────────────────────

function parseContractError(err) {
  const raw = err.reason ?? err.data?.message ?? err.message ?? "";

  const knownErrors = {
    AlreadySpent:              "Proof of Purchase già utilizzato (nullifier speso).",
    NotRelayer:                "Solo il DApp Relayer può eseguire questa operazione.",
    DIDNotActive:              "Il tuo DID non è attivo. Registralo prima di inviare recensioni.",
    VendorDIDNotActive:        "Il vendor non ha un DID attivo registrato.",
    InvalidScore:              "Il punteggio deve essere tra 1 e 5.",
    CurationWindowStillOpen:   "La Curation Window è ancora aperta. Usa prima «Salta 31 Giorni».",
    AlreadyFinalized:          "Questa recensione è già stata finalizzata.",
    NotReviewer:               "Solo il reviewer originale può compiere questa azione.",
    ReviewAlreadyRevoked:      "La recensione è già stata revocata.",
    AlreadyVoted:              "Hai già votato su questa recensione.",
    UnknownReview:             "Recensione non trovata.",
    AsymmetryRequired:         "Errore parametri: deltaMinus deve essere > deltaPlus.",
    NotOwner:                  "Solo il proprietario del contratto può eseguire questa funzione.",
    AlreadyRegistered:         "Hai già registrato un DID per questo account.",
  };

  for (const [name, msg] of Object.entries(knownErrors)) {
    if (raw.includes(name)) return msg;
  }

  if (err.code === 4001 || raw.includes("user rejected")) {
    return "Transazione rifiutata dall'utente in MetaMask.";
  }
  if (err.code === -32603 || raw.includes("Internal JSON-RPC")) {
    return "Errore interno del nodo Hardhat. Verifica che sia in esecuzione su localhost:8545.";
  }

  return raw.length > 0 ? raw.slice(0, 200) : "Errore sconosciuto. Controlla la console.";
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function updateWalletUI() {
  document.getElementById("btn-connect").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("wallet-address").textContent = shortAddr(userAddress);
  document.getElementById("network-badge").classList.remove("hidden");
}

function setStep(active, status = "active") {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    el.classList.remove("active", "done", "pending");
    if (i < active)        el.classList.add("done");
    else if (i === active) el.classList.add(status === "done" ? "done" : "active");
    else                   el.classList.add("pending");
  }
}

function setSubmitLoading(loading) {
  const btn     = document.getElementById("btn-submit");
  const text    = document.getElementById("btn-submit-text");
  const spinner = document.getElementById("btn-submit-spinner");
  btn.disabled      = loading;
  spinner.classList.toggle("hidden", !loading);
  text.textContent  = loading ? "Elaborazione in corso..." : "🚀 Invia Recensione";
}

function renderContractAddresses() {
  const list = document.getElementById("contract-list");
  if (!deployment?.contracts) {
    list.innerHTML = "<div class='loading-placeholder'>Nessun contratto trovato.</div>";
    return;
  }
  list.innerHTML = Object.entries(deployment.contracts)
    .map(([name, addr]) => `
      <div class="contract-item">
        <span class="contract-name">${name}</span>
        <code class="contract-addr" title="${addr}" onclick="navigator.clipboard.writeText('${addr}')" style="cursor:pointer">
          ${addr.slice(0, 8)}...${addr.slice(-6)}
        </code>
      </div>
    `).join("");
}

function logActivity(message, type = "info") {
  const log   = document.getElementById("activity-log");
  const empty = log.querySelector(".log-empty");
  if (empty) empty.remove();

  const icons = { info: "ℹ️", success: "✅", error: "❌", loading: "⏳", warning: "⚠️" };
  const time  = new Date().toLocaleTimeString("it-IT");

  const item = document.createElement("div");
  item.className = `log-item log-${type}`;
  item.innerHTML = `
    <span class="log-icon" aria-hidden="true">${icons[type] ?? "ℹ️"}</span>
    <span class="log-message">${escHtml(message)}</span>
    <span class="log-time">${time}</span>
  `;
  log.insertBefore(item, log.firstChild);
  while (log.children.length > 60) log.removeChild(log.lastChild);
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");

  const bg = {
    success: "rgba(16,185,129,0.12)",
    error:   "rgba(239,68,68,0.12)",
    warning: "rgba(245,158,11,0.12)",
    info:    "rgba(99,102,241,0.12)",
  };
  const border = {
    success: "rgba(16,185,129,0.4)",
    error:   "rgba(239,68,68,0.4)",
    warning: "rgba(245,158,11,0.4)",
    info:    "rgba(99,102,241,0.4)",
  };

  const toast = document.createElement("div");
  toast.className    = "toast";
  toast.textContent  = message;
  toast.style.background  = bg[type]     ?? bg.info;
  toast.style.borderColor = border[type] ?? border.info;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add("visible"));
  });

  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 400);
  }, 4500);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

const shortAddr = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;
const delay     = (ms)   => new Promise(r => setTimeout(r, ms));
const escHtml   = (s)    => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// ─── Event Listeners ──────────────────────────────────────────────────────────

document.getElementById("btn-connect").addEventListener("click", connectWallet);
document.getElementById("btn-submit").addEventListener("click", submitReview);
document.getElementById("btn-time-travel").addEventListener("click", timeTravel);
document.getElementById("btn-finalize").addEventListener("click", finalizeCuration);

// Pulsante DID registration (aggiunto nell'index.html nel banner DID)
const btnDID = document.getElementById("btn-register-did");
if (btnDID) btnDID.addEventListener("click", registerDID);

document.getElementById("btn-refresh").addEventListener("click", async () => {
  await refreshStats();
  logActivity("🔄 Statistiche aggiornate.", "success");
  showToast("🔄 Statistiche aggiornate.", "info");
});

document.getElementById("btn-clear-log").addEventListener("click", () => {
  document.getElementById("activity-log").innerHTML =
    '<div class="log-empty">Log pulito.</div>';
});

document.getElementById("reviewText").addEventListener("input", (e) => {
  document.getElementById("char-count").textContent = e.target.value.length;
});

document.getElementById("dev-panel-toggle").addEventListener("click", () => {
  const body     = document.getElementById("dev-panel-body");
  const chevron  = document.getElementById("dev-chevron");
  const toggle   = document.getElementById("dev-panel-toggle");
  const collapsed = body.classList.toggle("collapsed");
  chevron.textContent       = collapsed ? "▶" : "▼";
  toggle.setAttribute("aria-expanded", !collapsed);
});

document.getElementById("dev-panel-toggle").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    document.getElementById("dev-panel-toggle").click();
  }
});

// ─── Avvio ────────────────────────────────────────────────────────────────────

init();
