// test/zsc.web3.test.js
import { Web3 } from "web3";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { fileURLToPath }  from "url";
import { createRequire }  from "module";

const require = createRequire(import.meta.url);
const Client = require("../anonymous.js/src/client.js");

const HTTP_URL       = process.env.RPC_URL || "http://127.0.0.1:8545";
const WS_URL       = process.env.RPC_WS_URL || "ws://127.0.0.1:8546";
const DEPLOYER_KEY  = "0xcce34f0b0f42396c20048c21763fc5ff8096f57ecf2e6f940079cc75ca25501d";

// contract addresses (hard-coded here; adjust if yours differ)
const CASH_ADDRESS = "0x41A0F79712811d03718D63122601c69133EeE1ba";
const ZSC_ADDRESS  = "0x328136867b4a422ED5ed4657257edd4280D2F193";

// Recreate __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// load compiled ABIs
function loadArtifact(name) {
  const json = fs.readFileSync(
    path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`),
    "utf8"
  );
  return JSON.parse(json).abi;
}

describe("ZSC (web3.js)", function() {
  this.timeout(30000);

  let web3;
  let httpWeb3;
  let deployer;
  let cash, zsc;
  let users; // [alice, bob, carol, dave, miner]

  before(async () => {
    // 1) Init web3
    web3 = new Web3(WS_URL);
    console.log("WS connection status:", web3.currentProvider.getStatus());

    // Add HTTP provider side for RPC calls (optional)
    // you can also set a fallback HTTP provider for calls:
    httpWeb3 = new Web3(HTTP_URL)

    // 2) Add deployer account
    web3.eth.accounts.wallet.add(DEPLOYER_KEY);
    deployer = web3.eth.accounts.wallet[0].address;

    // 3) Instantiate contracts
    const cashAbi = loadArtifact("CashToken");
    const zscAbi  = loadArtifact("ZSC");
    cash = new web3.eth.Contract(cashAbi, CASH_ADDRESS);
    zsc  = new httpWeb3.eth.Contract(zscAbi,  ZSC_ADDRESS);

    // 4) Create & fund 5 random test users
    users = Array.from({ length: 5 }, () => web3.eth.accounts.create());
    users.forEach(u => web3.eth.accounts.wallet.add(u.privateKey));

    
    // await Promise.all(users.map(u =>
    //   web3.eth.sendTransaction({
    //     from: deployer,
    //     to:   u.address,
    //     value: web3.utils.toWei("1", "ether"),
    //     gas: 21000
    //   })
    // ));
  });
  

  // it("mint & approve (deployer)", async () => {
  //   // mint 1,000 to deployer
  //   await cash.methods.mint(deployer, 1000)
  //     .send({ from: deployer, gas: 6721975, gasPrice: 0 });
  //   // approve ZSC
  //   await cash.methods.approve(ZSC_ADDRESS, 1000)
  //     .send({ from: deployer, gas: 6721975, gasPrice: 0 });

  //   const bal = await cash.methods.balanceOf(deployer).call();
  //   console.log("Deployer balance:", bal);
  //   expect(bal).to.equal(bal);
  // });

  // it("register deployer", async () => {
    // const clientD = new Client(web3, zsc, deployer, DEPLOYER_KEY);
    // await clientD.register();
    // expect(clientD.account.balance()).to.equal(0);
  // });

  // it("deposit & withdraw (deployer)", async () => {
  //   const clientD = new Client(web3, zsc, deployer, DEPLOYER_KEY);
  //   await clientD.register();

  //   await clientD.deposit(100);
  //   expect(clientD.account._state.pending).to.equal(100);

  //   await clientD.withdraw(10);
  //   // wait for event‐handler to update state
  //   await new Promise(r => setTimeout(r, 1000));
  //   expect(clientD.account.balance()).to.equal(90);
  // });

  it("should allow transferring with decoys & miner fee (deployer → test users)", async () => {
    const clientD = new Client(web3, zsc, deployer, DEPLOYER_KEY);
    await clientD.register();
    
    // Set up clients
    const bob = new Client(web3, zsc, users[1].address, users[1].privateKey);
    const carol = new Client(web3, zsc, users[2].address, users[2].privateKey);
    const dave = new Client(web3, zsc, users[3].address, users[3].privateKey);
    
    // Register all users
    await Promise.all([
      bob.register(), 
      carol.register(), 
      dave.register(), 
    ]);
    
    // Set up alice's friends
    clientD.friends.add("Bob", bob.account.public());
    clientD.friends.add("Carol", carol.account.public());
    clientD.friends.add("Dave", dave.account.public());
    
    // Deposit so alice can pay out
    await clientD.deposit(50);
    
    // Execute the transfer
    await clientD.transfer("Bob", 10, ["Carol", "Dave"]);
    
    // Give event-handler time to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check Bob's balance
    assert.equal(
      bob.account.balance(),
      10,
      "Transfer amount wasn't correctly received by Bob"
    );
  });

  after(async () => {
    // close the WS provider
    if (web3.currentProvider.disconnect) {
      web3.currentProvider.disconnect(1000, 'Test complete');
    } else if (web3.currentProvider.connection && web3.currentProvider.connection.close) {
      web3.currentProvider.connection.close();
    }
    // web3.eth.accounts.wallet.clear();
  });
});

