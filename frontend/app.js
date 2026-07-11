/**
 * frontend/app.js
 *
 * Logica completa della dApp TechRate.
 * Dipende da window.ethers (caricato via CDN UMD in index.html).
 *
 * Flusso principale:
 *   1. init()          → carica deployment.json, verifica MetaMask
 *   2. connectWallet() → BrowserProvider, getSigner, verifica chainId 31337
 *   3. submitReview()  → POST /request-pop → uploadToIPFS → reviewContract.submitReview()
 *   4. timeTravel()    → evm_increaseTime(31d) + evm_mine via JSON-RPC diretto
 *   5. finalizeCuration() → reviewContract.finalizeCuration(lastReviewId)
 */

"use strict";

// ─── Costanti ─────────────────────────────────────────────────────────────────

const ISSUER_URL        = "http://localhost:3000";
const HARDHAT_NODE_URL  = "http://127.0.0.1:8545";
const HARDHAT_CHAIN_ID  = 31337;
const SECONDS_31_DAYS   = 31 * 24 * 60 * 60; // 2 678 400

// ─── ABI minimali ────────────────────────────────────────────────────────────
// Definiti come Human-Readable ABI (ethers v6). Il tipo struct SDJWTPresentation
// viene espresso come tuple() per compatibilità con l'encoder ABI di ethers.

const REVIEW_CONTRACT_ABI = [
  // ── Funzioni write ──
  `function submitReview(
     string reviewerDID,
     string productID,
     string cid,
     uint8  score,
     bytes32 nullifier,
     bytes32[] sdDigests,
     uint8 v,
     bytes32 r,
     bytes32 s
   ) returns (uint256)`,

  `function finalizeCuration(uint256 reviewId)`,

  `function voteOnReview(
     uint256 reviewId,
     string voterDID,
     string productID,
     bytes32 nullifier,
     bytes32[] sdDigests,
     uint8 v,
     bytes32 r,
     bytes32 s,
     bool useful
   )`,

  // ── Funzioni view ──
  `function reviewCount() view returns (uint256)`,
  `function reputationScore(address) view returns (uint256)`,
  `function registered(address) view returns (bool)`,
  `function CURATION_WINDOW() view returns (uint256)`,

  // ── Review struct (lettura singola) ──
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

  // ── Events ──
  `event ReviewSubmitted(uint256 indexed reviewId, address indexed reviewerAddress, string productID, uint8 score, string cid, uint256 timestamp)`,
  `event CurationFinalized(uint256 indexed reviewId, uint256 consensus, uint256 upvoteWeight, uint256 downvoteWeight)`,
  `event ReviewerRewarded(uint256 indexed reviewId, address indexed reviewer, uint256 tokens)`,
  `event VoteCast(uint256 indexed reviewId, address indexed voter, bool useful, uint256 weight)`,
];

const REPUTATION_TOKEN_ABI = [
  `function balanceOf(address) view returns (uint256)`,
  `function symbol() view returns (string)`,
  `function totalSupply() view returns (uint256)`,
];

const DID_REGISTRY_ABI = [
  `function registerDID(string did, string publicKey, string serviceEndpoint)`,
  `function isActiveByOwner(address) view returns (bool)`
];

// ─── Stato applicazione ───────────────────────────────────────────────────────

let provider, signer, userAddress;
let deployment;
let reviewContract, reputationToken, didRegistry;
let lastReviewId = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Carica deployment.json servito da serve.js
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

  // Controlla MetaMask
  if (!window.ethereum) {
    showToast("🦊 MetaMask non trovato. Installalo su https://metamask.io/", "error");
    logActivity("❌ window.ethereum non disponibile.", "error");
    document.getElementById("btn-connect").textContent = "MetaMask non trovato";
    document.getElementById("btn-connect").disabled = true;
    return;
  }

  // Ascolta cambi account e rete
  window.ethereum.on("accountsChanged", (accounts) => {
    if (accounts.length === 0) {
      window.location.reload();
    } else {
      userAddress = ethers.getAddress(accounts[0]);
      document.getElementById("wallet-address").textContent = shortAddr(userAddress);
      refreshStats();
      logActivity("🔄 Account cambiato: " + userAddress);
    }
  });

  window.ethereum.on("chainChanged", () => window.location.reload());
}

// ─── Connessione Wallet ───────────────────────────────────────────────────────

async function connectWallet() {
  const btn = document.getElementById("btn-connect");
  btn.disabled = true;
  btn.textContent = "Connessione...";

  try {
    provider = new ethers.BrowserProvider(window.ethereum);

    // Richiedi permesso (apre popup MetaMask)
    await provider.send("eth_requestAccounts", []);

    // Verifica chainId
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== HARDHAT_CHAIN_ID) {
      throw new Error(
        `Rete sbagliata! chainId attuale: ${network.chainId}. ` +
        `Aggiungi la rete Hardhat Local (chainId 31337, RPC http://127.0.0.1:8545) a MetaMask.`
      );
    }

    signer      = await provider.getSigner();
    userAddress = await signer.getAddress();

    // Istanzia i contratti
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

    // Controlla registrazione DID
    const isActive = await didRegistry.isActiveByOwner(userAddress);
    if (!isActive) {
      logActivity("👤 Registrazione DID in corso...", "loading");
      const userDid = "did:ethr:" + userAddress.toLowerCase();
      const tx = await didRegistry.registerDID(userDid, "pubkey-" + userAddress.slice(0, 6), "");
      await tx.wait();
      logActivity("✅ DID registrato on-chain!", "success");
    }

    // Aggiorna UI
    updateWalletUI();
    await refreshStats();

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

// ─── IPFS Upload (Mock) ───────────────────────────────────────────────────────
//
// In produzione: integrare Helia (https://github.com/ipfs/helia) per un
// nodo IPFS in-memory nel browser. Per la demo, generiamo un CIDv1
// deterministico basato su SHA-256 del contenuto.
//
// CIDv1 autentico: bafybeig + base32(sha256(content))
// Il mock produce lo stesso formato e la stessa lunghezza (59 char).

async function uploadToIPFS(text) {
  logActivity("🌐 Generazione CID IPFS...", "loading");

  const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

  const data    = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const bytes   = new Uint8Array(hashBuf);

  // Converti in base32 (IPFS-style)
  let b32 = "";
  for (let i = 0; i < bytes.length; i++) {
    b32 += BASE32[bytes[i] & 31];
    b32 += BASE32[(bytes[i] >> 3) & 31];
  }

  // CIDv1 mock: "bafybeig" (8 char) + 51 char base32 = 59 char totali
  const cid = "bafybeig" + b32.slice(0, 51);

  // Simula latenza rete
  await delay(600);

  logActivity(`📎 CID: ${cid.slice(0, 24)}...`, "success");
  return cid;
}

// ─── Invio Recensione ─────────────────────────────────────────────────────────

async function submitReview() {
  const userDid    = "did:ethr:" + userAddress.toLowerCase();
  const productId  = document.getElementById("productId").value.trim();
  const reviewText = document.getElementById("reviewText").value.trim();
  const scoreEl    = document.querySelector('input[name="score"]:checked');
  const score      = scoreEl ? parseInt(scoreEl.value, 10) : 3;

  // Validazione client-side
  if (!productId) {
    showToast("⚠️ Inserisci un Product ID.", "warning"); return;
  }
  if (reviewText.length < 10) {
    showToast("⚠️ La recensione è troppo breve (min 10 caratteri).", "warning"); return;
  }
  if (score < 1 || score > 5) {
    showToast("⚠️ Seleziona una valutazione da 1 a 5 stelle.", "warning"); return;
  }

  setSubmitLoading(true);

  try {
    // ── Step 2: Richiesta PoP all'Issuer ───────────────────────────────────
    setStep(2, "active");
    logActivity(`📬 Richiesta PoP all'Issuer per "${productId}"...`);

    const popRes = await fetch(`${ISSUER_URL}/request-pop`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ did: userDid, productId }),
    }).catch(() => {
      throw new Error(
        "Impossibile contattare il server Issuer su " + ISSUER_URL +
        ". Assicurati che sia in esecuzione con: cd issuer-server && node server.js"
      );
    });

    if (!popRes.ok) {
      const errBody = await popRes.json().catch(() => ({}));
      throw new Error("Issuer error: " + (errBody.error ?? popRes.statusText));
    }

    const pop = await popRes.json();
    setStep(2, "done");
    logActivity(
      `✅ PoP ricevuto | nullifier: ${pop.nullifier.slice(0, 10)}...`,
      "success"
    );

    // ── Step 3: Caricamento IPFS ────────────────────────────────────────────
    setStep(3, "active");
    const cid = await uploadToIPFS(reviewText);
    setStep(3, "done");

    // ── Step 4: Transazione on-chain ────────────────────────────────────────
    setStep(4, "active");
    logActivity(`⛓️ Invio transazione a ReviewContract...`);

    const tx = await reviewContract.submitReview(
      userDid,
      productId,
      cid,
      score,
      pop.nullifier,
      pop.sdDigests,
      pop.v,
      pop.r,
      pop.s
    );

    logActivity(`📤 TX inviata: ${tx.hash.slice(0, 18)}...`);

    const receipt = await tx.wait();
    setStep(4, "done");

    // Estrae reviewId dall'evento ReviewSubmitted
    for (const log of receipt.logs) {
      try {
        const parsed = reviewContract.interface.parseLog({
          topics: log.topics,
          data:   log.data,
        });
        if (parsed?.name === "ReviewSubmitted") {
          lastReviewId = parsed.args.reviewId;
          document.getElementById("last-review-id").textContent = lastReviewId.toString();
          document.getElementById("btn-finalize").disabled = false;
          logActivity(
            `✅ Review #${lastReviewId} pubblicata! Score: ${"★".repeat(score)} | CID: ${cid.slice(0, 20)}...`,
            "success"
          );
          break;
        }
      } catch { /* log non pertinente, skip */ }
    }

    showToast(`✅ Recensione inviata! (${score}/5 stelle, Review #${lastReviewId})`, "success");
    await refreshStats();

    // Reset form (ma mantieni productId per comodità)
    document.getElementById("reviewText").value = "";
    document.getElementById("char-count").textContent = "0";

  } catch (err) {
    console.error("[submitReview]", err);
    const msg = parseContractError(err);
    showToast("❌ " + msg, "error");
    logActivity("❌ Errore invio: " + msg, "error");
    // Resetta progress agli step già completati
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

    // Invio diretto al nodo Hardhat (non attraverso MetaMask che potrebbe
    // bloccare metodi di sviluppo non standard).
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

    // Leggi il nuovo timestamp per conferma
    const block     = await rpc("eth_getBlockByNumber", ["latest", false]);
    const ts        = parseInt(block.timestamp, 16);
    const dateStr   = new Date(ts * 1000).toLocaleString("it-IT");

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

    let consensusStr  = "n/a";
    let rewardStr     = null;

    for (const log of receipt.logs) {
      try {
        const parsed = reviewContract.interface.parseLog({
          topics: log.topics,
          data:   log.data,
        });
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
      : `✅ Curation chiusa! (consensus: ${consensusStr}, nessun voto ricevuto)`;

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
    AlreadySpent:              "Proof of Purchase già utilizzato (nullifier speso). Richiedi un nuovo PoP.",
    UntrustedIssuer:           "L'indirizzo Issuer non è registrato nell'IdentityRegistry.",
    WalletBindingMismatch:     "Il wallet MetaMask non corrisponde a quello nel PoP. Usa lo stesso account.",
    SignatureIssuerMismatch:   "La firma del PoP non è valida. Controlla che l'Issuer Server sia in esecuzione.",
    InvalidScore:              "Il punteggio deve essere tra 1 e 5.",
    ProductIdMismatch:         "Il productId non corrisponde all'hash nel PoP. Controlla di aver scritto lo stesso ID.",
    CurationWindowStillOpen:   "La Curation Window è ancora aperta. Usa prima «Salta 31 Giorni».",
    AlreadyFinalized:          "Questa recensione è già stata finalizzata.",
    NotReviewer:               "Solo il reviewer originale può compiere questa azione.",
    ReviewAlreadyRevoked:      "La recensione è già stata revocata.",
    AlreadyVoted:              "Hai già votato su questa recensione.",
    UnknownReview:             "Recensione non trovata. reviewId non esiste.",
    AsymmetryRequired:         "Errore parametri: deltaMinus deve essere maggiore di deltaPlus.",
    NotOwner:                  "Solo il proprietario del contratto può eseguire questa funzione.",
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

  const btn  = document.getElementById("btn-submit");
  const text = document.getElementById("btn-submit-text");
  btn.disabled   = false;
  text.textContent = "🚀 Invia Recensione";
}

function setStep(active, status = "active") {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    el.classList.remove("active", "done", "pending");
    if (i < active)       el.classList.add("done");
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
  if (!deployment?.contracts) { list.innerHTML = "<div class='loading-placeholder'>Nessun contratto trovato.</div>"; return; }
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

  const icons = { info:"ℹ️", success:"✅", error:"❌", loading:"⏳", warning:"⚠️" };
  const time  = new Date().toLocaleTimeString("it-IT");

  const item = document.createElement("div");
  item.className = `log-item log-${type}`;
  item.innerHTML = `
    <span class="log-icon" aria-hidden="true">${icons[type] ?? "ℹ️"}</span>
    <span class="log-message">${escHtml(message)}</span>
    <span class="log-time">${time}</span>
  `;
  log.insertBefore(item, log.firstChild);

  // Mantieni max 60 elementi nel log
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

// Toggle pannello dev
document.getElementById("dev-panel-toggle").addEventListener("click", () => {
  const body    = document.getElementById("dev-panel-body");
  const chevron = document.getElementById("dev-chevron");
  const toggle  = document.getElementById("dev-panel-toggle");
  const collapsed = body.classList.toggle("collapsed");
  chevron.textContent        = collapsed ? "▶" : "▼";
  toggle.setAttribute("aria-expanded", !collapsed);
});

// Keyboard support per il toggle dev panel
document.getElementById("dev-panel-toggle").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    document.getElementById("dev-panel-toggle").click();
  }
});

// ─── Avvio ────────────────────────────────────────────────────────────────────

init();
