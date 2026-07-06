/**
 * frontend/serve.js
 *
 * Micro-server HTTP per i file statici del frontend.
 * Risolve il problema CORS del fetch di deployment.json da file:// locale
 * servendo tutto da http://localhost:8080.
 *
 * Routing:
 *   GET /               → frontend/index.html
 *   GET /app.js         → frontend/app.js
 *   GET /deployment.json → ../deployment.json  (dalla root del progetto)
 *   GET /*              → qualsiasi altro file in frontend/
 *
 * Nessuna dipendenza esterna: solo Node.js built-in.
 *
 * Uso:
 *   node frontend/serve.js
 */

import { createServer }       from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, extname, dirname } from "path";
import { fileURLToPath }      from "url";

const __dirname    = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const PORT         = 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".woff2":"font/woff2",
};

const server = createServer((req, res) => {
  // Strip query string and decode URI
  const url = decodeURIComponent(req.url.split("?")[0]);

  // CORS — consente le chiamate da MetaMask/Dapp e dallo stesso origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache, no-store");

  let filePath;

  if (url === "/" || url === "/index.html") {
    filePath = resolve(__dirname, "index.html");
  } else if (url === "/deployment.json") {
    // deployment.json viene dalla root del progetto, non dalla cartella frontend
    filePath = resolve(PROJECT_ROOT, "deployment.json");
  } else {
    filePath = resolve(__dirname, url.slice(1));
  }

  // Serve il file
  try {
    if (!existsSync(filePath)) throw new Error("Not Found");
    const content = readFileSync(filePath);
    const mime    = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`404 Not Found: ${url}\n`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log();
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║    TechRate dApp — Frontend Development Server   ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(`  🌐  App       →  http://localhost:${PORT}`);
  console.log(`  📄  Serving   →  ${__dirname}`);
  console.log(`  🗂️   Deployment →  ${resolve(PROJECT_ROOT, "deployment.json")}`);
  console.log();
  console.log("  Prerequisiti (terminali separati):");
  console.log("    1. npx hardhat node");
  console.log("    2. npx hardhat run scripts/deploy.js --network localhost");
  console.log("    3. cd issuer-server && node server.js");
  console.log();
});
