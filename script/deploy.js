// scripts/deploy.js
// require("dotenv").config();
const { ethers, JsonRpcProvider, Wallet, ContractFactory } = require("ethers");
const fs = require("fs");
const path = require("path");

// -- CONFIGURE THESE or via .env --
const RPC_URL   = process.env.RPC_URL   || "http://127.0.0.1:8545";
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0xcce34f0b0f42396c20048c21763fc5ff8096f57ecf2e6f940079cc75ca25501d';
if (!PRIVATE_KEY) {
  console.error("❌  set PRIVATE_KEY");
  process.exit(1);
}

console.log("🔗  Connecting to:", RPC_URL)
console.log("🔐  Using private key:", PRIVATE_KEY);

// helper to load ABI + bytecode
function loadArtifact(name) {
    const artifactPath = path.join(
      __dirname,
      "..",
      "artifacts",
      "contracts",
      `${name}.sol`,
      `${name}.json`
    );
    return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  }

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  console.log("Provider:", provider.connection.url);
  const wallet   = new Wallet(PRIVATE_KEY, provider);
  console.log("🔐  Deploying with:", wallet.address);

  // 1. CashToken
  let A = loadArtifact("CashToken");
  let F = new ethers.ContractFactory(A.abi, A.bytecode, wallet);
  let cashToken = await F.deploy();
  await cashToken.deployed();
  console.log("✅ CashToken:", cashToken.address);

  // 2. InnerProductVerifier
  A = loadArtifact("InnerProductVerifier");
  F = new ethers.ContractFactory(A.abi, A.bytecode, wallet);
  let ipVerifier = await F.deploy();
  await ipVerifier.deployed();
  console.log("✅ InnerProductVerifier:", ipVerifier.address);

  // 3. ZetherVerifier
  A = loadArtifact("ZetherVerifier");
  F = new ethers.ContractFactory(A.abi, A.bytecode, wallet);
  let zVerifier = await F.deploy(ipVerifier.address);
  await zVerifier.deployed();
  console.log("✅ ZetherVerifier:", zVerifier.address);

  // 4. BurnVerifier
  A = loadArtifact("BurnVerifier");
  F = new ethers.ContractFactory(A.abi, A.bytecode, wallet);
  let bVerifier = await F.deploy(ipVerifier.address);
  await bVerifier.deployed();
  console.log("✅ BurnVerifier:", bVerifier.address);

  // 5. ZSC
  A = loadArtifact("ZSC");
  F = new ethers.ContractFactory(A.abi, A.bytecode, wallet);
  let zsc = await F.deploy(
    cashToken.address,
    zVerifier.address,
    bVerifier.address,
    6
  );
  await zsc.deployed();
  console.log("✅ ZSC:", zsc.address);

  console.log("🎉 All contracts deployed!");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
