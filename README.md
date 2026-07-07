# TechRate / ReviewChain DApp

This project implements the Proof of Concept for the decentralized reputation system defined in the Workpackages (WP2/WP3/WP4). It showcases a hybrid Web2.5 architecture, combining a native Node.js test runner (`node:test`), Hardhat 3, the `viem` library for EVM interactions, and a purely client-side frontend.

## Project Overview

This repository includes three main macro-components:

1. **Smart Contracts (`contracts/`)**: Solidity contracts defining the Identity Registries, Nullifier protection, Review lifecycle, and the Soulbound `ReputationToken`.
2. **Issuer Backend (`issuer-server/`)**: A lightweight Node.js microservice simulating an e-commerce platform that issues gas-optimized raw ECDSA Proof of Purchase (PoP) credentials.
3. **Frontend (`frontend/`)**: A Vanilla JS static dApp that orchestrates MetaMask authentication, PoP requests, and on-chain submissions.

## Usage & Testing

### Running Tests

To run the comprehensive integration test suite (29 tests validating S2.3, S2.4, S2.6, and SBT enforcement), execute:

```shell
npx hardhat test nodejs
```

*(Note: The tests use isolated local networks per block to allow programmatic time travel without polluting state.)*

### Running the Full Local Simulation

To experience the complete flow of the application locally, you need to spin up the smart contracts, the backend issuer, and the frontend server. 

**Run these commands in separate terminals:**

#### 1. Start the Local Blockchain
Start an empty Hardhat node instance. This simulates the Ethereum network locally.
```shell
npx hardhat node
```

#### 2. Deploy the Smart Contracts
In a new terminal, run the deployment script. This deploys the 5 core contracts to your local node, wires them together, and generates the `deployment.json` file needed by the backend and frontend.
```shell
npx hardhat run scripts/deploy.js --network localhost
```

#### 3. Start the Issuer Backend
Navigate to the issuer directory and start the Web2 e-commerce simulation server. It reads the `deployment.json` to configure itself and starts listening on port 3000.
```shell
cd issuer-server
node server.js
```

*(Optional)* You can verify the issuer is running correctly and serving the correct addresses by pinging its health endpoint:
```shell
curl -s http://localhost:3000/health | python -m json.tool
```

#### 4. Start the Frontend dApp
Finally, start the static web server for the frontend. 
```shell
node frontend/serve.js
```

Now, open your browser and navigate to **`http://localhost:8080`**. Ensure your MetaMask wallet is connected to the Localhost network (`127.0.0.1:8545`, Chain ID `31337`) and try submitting a review!
