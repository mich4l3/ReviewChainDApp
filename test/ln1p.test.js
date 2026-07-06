const solc = require('solc');
const fs = require('fs');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');

const contractsDir = path.join(__dirname, '..', 'contracts');
const testDir = __dirname;

function loadSources() {
  const sources = {};
  for (const f of fs.readdirSync(contractsDir)) {
    if (f.endsWith('.sol')) sources[f] = { content: fs.readFileSync(path.join(contractsDir, f), 'utf8') };
  }
  for (const f of fs.readdirSync(path.join(contractsDir, 'solady'))) {
    sources['solady/' + f] = { content: fs.readFileSync(path.join(contractsDir, 'solady', f), 'utf8') };
  }
  sources['test/FixedPointMathHarness.sol'] = {
    content: fs.readFileSync(path.join(testDir, 'FixedPointMathHarness.sol'), 'utf8'),
  };
  return sources;
}

function findImports(importPath) {
  // Handles the harness's "../contracts/FixedPointMath.sol" relative import.
  const normalized = importPath.replace(/^(\.\.\/)*contracts\//, '');
  const candidates = [
    path.join(contractsDir, normalized),
    path.join(contractsDir, importPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { contents: fs.readFileSync(c, 'utf8') };
  }
  return { error: 'File not found: ' + importPath };
}

async function main() {
  const input = {
    language: 'Solidity',
    sources: loadSources(),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    errors.forEach((e) => console.error(e.formattedMessage));
    process.exit(1);
  }

  const artifact = output.contracts['test/FixedPointMathHarness.sol']['FixedPointMathHarness'];
  const abi = artifact.abi;
  const bytecode = '0x' + artifact.evm.bytecode.object;

  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true } }));
  const signer = await provider.getSigner();

  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const harness = await factory.deploy();
  await harness.waitForDeployment();

  const cases = [0, 1, 2, 4, 5, 10, 50, 100, 1000];
  console.log('R\tcontract ln(1+R)\tMath.log(1+R) (JS ref)\trel. error');
  for (const r of cases) {
    const raw = await harness.ln1p(r);
    const contractValue = Number(raw) / 1e18;
    const reference = Math.log(1 + r);
    const relError = reference === 0 ? 0 : Math.abs(contractValue - reference) / reference;
    console.log(
      `${r}\t${contractValue.toFixed(6)}\t\t${reference.toFixed(6)}\t\t${(relError * 100).toFixed(4)}%`
    );
  }

  // Monotonicity check, the actual property WP3 S3.3.5 relies on.
  let prev = -1n;
  let monotonic = true;
  for (const r of [0, 1, 2, 3, 5, 10, 20, 50, 100, 500, 1000]) {
    const v = await harness.ln1p(r);
    if (v <= prev) monotonic = false;
    prev = v;
  }
  console.log('\nStrictly increasing in R over the sampled range:', monotonic);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
