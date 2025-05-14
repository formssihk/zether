// test/zsc.ethers.test.mjs
import { expect }         from "chai";
import fs                 from "fs";
import path               from "path";
import { fileURLToPath }  from "url";
import { ethers, Wallet } from "ethers";
// import deployed           from "../deployed.json" assert { type: "json" };
import { createRequire }  from "module";
// import dotenv             from "dotenv";

// dotenv.config();
const require = createRequire(import.meta.url);
const Client  = require("../anonymous.js/src/client.js");

// Recreate __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Load compiled ABI + bytecode artifacts
function loadArtifact(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Create N random wallets connected to the provider
function randomSigners(n, provider) {
  return Array.from({ length: n }, () => Wallet.createRandom().connect(provider));
}

// Fund each target from the deployer so they have ETH
async function fundSigners(deployer, targets, amtEth = "1.0") {
  const value = ethers.utils.parseEther(amtEth);
  await Promise.all(targets.map(w => deployer.sendTransaction({ to: w.address, value })));
}

describe("ZSC (ethers.js)", function() {
  this.timeout(30000);

  let provider;
  let deployer;    // the original deployer wallet
  let cash, zsc;   // contract instances bound to deployer
  let alice, bob, carol, dave, miner; // test users

  // Shim to let Client.js call web3.eth.sendSignedTransaction + decodeParameters
  const Web3Shim = {
    eth: {
      sendSignedTransaction: tx => provider.sendTransaction(tx.rawTransaction),
      abi: {
        decodeParameters: (inputs, data) =>
          ethers.utils.defaultAbiCoder.decode(inputs.map(i => i.type), data)
      }
    },
    transactionConfirmationBlocks: 1
  };

  before(async () => {
    // 1) Connect to Besu
    provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:8545");

    // 2) Recreate your deployer wallet (the one you used for `truffle migrate`)
    deployer = new Wallet(
      "0xcce34f0b0f42396c20048c21763fc5ff8096f57ecf2e6f940079cc75ca25501d",
      provider
    );

    // 3) Instantiate and bind contracts to deployer
    const cashJson = loadArtifact("CashToken");
    const zscJson  = loadArtifact("ZSC");
    // cash = new ethers.Contract(deployed.CashToken, cashJson.abi, provider).connect(deployer);
    // zsc  = new ethers.Contract(deployed.ZSC,      zscJson.abi,  provider).connect(deployer);

    // 4) instantiate ethers Contract objects connected to each signer
    // instantiate
    cash = new ethers.Contract(
      "0x41A0F79712811d03718D63122601c69133EeE1ba",    // the address of CashToken
      cashJson.abi,          // its ABI
      deployer                 // a Signer or Provider
    );

    zsc = new ethers.Contract(
      "0x328136867b4a422ED5ed4657257edd4280D2F193",          // the address of ZSC
      zscJson.abi,
      deployer
    );

    // 4) Create 5 new random test wallets
    [alice, bob, carol, dave, miner] = randomSigners(5, provider);

    // 5) Fund them (1 ETH each) so they can pay gas
    // await fundSigners(deployer, [alice, bob, carol, dave, miner], "1.0");
  });

  // it("mint & approve (deployer)", async () => {
  //   // mint 1,000 tokens to deployer’s address
  //   await cash.mint(await deployer.getAddress(), 1000);
  //   // approve ZSC to spend them
  //   await cash.approve(zsc.address, 1000);

  //   const bal = await cash.balanceOf(await deployer.getAddress());
  //   console.log("Deployer balance:", bal.toString());
  //   expect(bal).to.equal(bal);
  // });

  it("register deployer", async () => {
    const clientD = new Client(Web3Shim, zsc.address, await deployer.getAddress());
    await clientD.register();
    // expect(client.account.balance()).to.equal(0);
  });

  it("deposit & withdraw (deployer)", async () => {
    const clientD = new Client(Web3Shim, zsc, await deployer.getAddress());
    await clientD.register();
    await clientD.deposit(100);
    expect(clientD.account._state.pending).to.equal(100);

    await clientD.withdraw(10);
    // let event handler update state
    await new Promise(r => setTimeout(r, 1000));
    expect(clientD.account.balance()).to.equal(90);
  });

  it("transfer with decoys & miner fee (deployer → test users)", async () => {
    // register all test users
    const clients = [alice, bob, carol, dave, miner].map(
      w => new Client(Web3Shim, zsc, w.address)
    );
    await Promise.all(clients.map(c => c.register()));

    // add friends to deployer’s client
    const clientD = new Client(Web3Shim, zsc, await deployer.getAddress());
    for (let w of [bob, carol, dave, miner]) {
      clientD.friends.add(w.address, w.address); // or use public() in your actual flow
    }

    // deposit for deployer so they can pay out
    await clientD.deposit(50);

    // transfer 10 to Bob, with Carol/Dave as decoys, miner as fee-recipient
    await clientD.transfer(bob.address, 10, [carol.address, dave.address], miner.address);
    await new Promise(r => setTimeout(r, 1000));

    expect(clients[1].account.balance()).to.equal(10);          // Bob got 10
    const fee = (await zsc.fee()).toNumber();
    expect(clients[4].account.balance()).to.equal(fee);         // Miner got fee
  });
});
