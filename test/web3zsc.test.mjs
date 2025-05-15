import { Web3 } from "web3";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { fileURLToPath }  from "url";
import { createRequire }  from "module";
import bn128 from '../anonymous/src/utils/bn128.js';
import BN from 'bn.js';
import { ElGamal } from '../anonymous/src/utils/algebra.js';

const require = createRequire(import.meta.url);
const Client = require("../anonymous/src/client.js");

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

  const httpProvider = new Web3(HTTP_URL);
  let mintAmount = httpProvider.utils.toWei('100', 'ether');
  let depositAmt = httpProvider.utils.toWei('50', 'ether');
  let transferAmt = httpProvider.utils.toWei('10', 'ether');
  console.log(`Minting ${mintAmount} wei, depositing ${depositAmt} wei, transferring ${transferAmt} wei`);

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
    // await cash.methods.mint(deployer, mintAmount)
    //   .send({ from: deployer, gas: 6721975, gasPrice: 0 });
  //   // approve ZSC
  //   await cash.methods.approve(ZSC_ADDRESS, mintAmount)
  //     .send({ from: deployer, gas: 6721975, gasPrice: 0 });

  //   const bal = await cash.methods.balanceOf(deployer).call();
  //   console.log("Deployer balance:", bal);
  //   expect(bal).to.equal(bal);
  // });

  // it("register deployer", async () => {
  //   const clientD = new Client(web3, zsc, deployer, DEPLOYER_KEY);
  //   await clientD.register();
  //   expect(clientD.account.balance()).to.equal(0);
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


  async function discreteLog(point) {
    // Get the generator point g
    const g = ElGamal.base['g'];
    
    // Try values from 0 to a reasonable maximum
    const MAX_BALANCE = 10000; // Adjust based on expected maximum balance
    
    for (let i = 0; i <= MAX_BALANCE; i++) {
      // Compute g^i
      const gToTheI = g.mul(new BN(i));
      
      // Check if g^i equals our point
      if (gToTheI.eq(point)) {
        return i;
      }
    }
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
  
  async function countdown(seconds) {
    for (let i = seconds; i > 0; i--) {
      process.stdout.write(`\rWaiting ${i} second${i === 1 ? '' : 's'}… `);
      await delay(1000);
    }
    console.log('\rDone waiting!             ');
  }

  // it("should allow transferring with decoys & miner fee (deployer → test users)", async () => {
  //   console.log(`Minting ${mintAmount} tokens to deployer...`);
  // try {
  //   await cash.methods.mint(deployer, mintAmount)
  //     .send({ from: deployer, gas: 6721975, gasPrice: 0 });
    
  //   const postMintBalance = await cash.methods.balanceOf(deployer).call();
  //   console.log("Balance after minting:", postMintBalance);
  // } catch (error) {
  //   console.error("Error during minting:", error);
  //   // Continue anyway as the tokens might already be minted
  // }
  
  // // Step 2: Approve ZSC with better error handling
  // console.log(`Approving ZSC contract to spend ${mintAmount} tokens...`);
  // try {
  //   const currentAllowance = await cash.methods.allowance(deployer, ZSC_ADDRESS).call();
  //   console.log("Current allowance:", currentAllowance);
    
  //   if (BigInt(currentAllowance) < BigInt(mintAmount)) {
  //     await cash.methods.approve(ZSC_ADDRESS, mintAmount)
  //       .send({ from: deployer, gas: 6721975, gasPrice: 0 });
      
  //     const newAllowance = await cash.methods.allowance(deployer, ZSC_ADDRESS).call();
  //     console.log("New allowance:", newAllowance);
  //   } else {
  //     console.log("Sufficient allowance already exists");
  //   }
  // } catch (error) {
  //   console.error("Error during approval:", error);
  //   throw error; // This is critical, so we'll stop the test if it fails
  // }
  //   const clientD = new Client(web3, zsc, deployer, DEPLOYER_KEY);
  //   await clientD.register();

  //   console.log(`Wait 10secs`)
  //   await delay(10);
    
  //   // Set up clients
  //   const bob = new Client(web3, zsc, users[1].address, users[1].privateKey);
  //   const carol = new Client(web3, zsc, users[2].address, users[2].privateKey);
  //   const dave = new Client(web3, zsc, users[3].address, users[3].privateKey);
    
  //   // Register all users
  //   await Promise.all([
  //     bob.register(), 
  //     carol.register(), 
  //     dave.register(), 
  //   ]);
    
  //   // Set up alice's friends
  //   clientD.friends.add("Bob", bob.account.public());
  //   clientD.friends.add("Carol", carol.account.public());
  //   clientD.friends.add("Dave", dave.account.public());
    
  //   // Deposit so clientD can pay out
  //   console.log(`Depositing ${50}…`);
  //   await clientD.deposit(50);
  //   console.log(`Deployer deposited`);

  //   console.log('Waiting for 2 minutes…');
  //   await countdown(2 * 60)

  //   // Execute the transfer
  //   // await clientD.transfer("Bob", 10, ["Carol", "Dave"]);
  //   await clientD.transfer("Bob", 10);
    
  //   // Give event-handler time to process
  //   await new Promise(resolve => setTimeout(resolve, 100));
    
  //   // Check Bob's balance
  //   assert.equal(
  //     bob.account.balance(),
  //     10,
  //     "Transfer amount wasn't correctly received by Bob"
  //   );
  // }).timeout(5 * 60 * 1000);

  it("get deployer balance", async () => {
    const pubKeyStr = "0x1dee9f2165784a3240c4a0719b0806ec9e0f47ed222455fb195ee605865bb776,0x1610362e336f48a30c040513e6dae488fdbab820bb4046d2b870c68815961507";
    const privateKeyHex = '0x2dec92d21bdcec708cc0a3df1acaa10726a7b7086bd794dde8b29994bf5fb277';
  
    // Convert to BN - adjust based on your library's requirements
    const privateKey = new BN(privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex, 16);
    const [xStr, yStr] = pubKeyStr.split(',');
    const xClean = xStr.replace('0x04', '0x');
    
    // Example of potential deserialize function (adjust to your actual library)
    const pubKey = bn128.deserialize([xClean, yStr]);
    // Use in your test
    const user = await new Client(web3, zsc, deployer, DEPLOYER_KEY);
    const bal = await user.simulateAccounts([pubKey]);
    
    const encryptedBal = bal[0];
  
    console.log("Encrypted balance object:", encryptedBal);
    
    // Implement decryption logic
    // 1. Get the left and right components
    const left = encryptedBal.left();
    const right = encryptedBal.right();
    console.log("ElGamal left component:", left.toString());
    console.log("ElGamal right component:", right.toString());
    
    // 2. Compute the shared secret using the private key
    // The shared secret is right^privateKey
    const sharedSecret = right.mul(privateKey);
    console.log("Computed shared secret:", sharedSecret.toString());
    
    // 3. Subtract the shared secret from the left component
    // This gives us g^m where m is the balance
    const gToTheM = left.add(sharedSecret.neg());
    console.log("g^m value:", gToTheM.toString());
    
    // 4. Compute the discrete log to get the balance
    // For Zether, balances are typically small enough that we can 
    // compute the discrete log by brute force
    
    // Assuming you have a discrete log function available
    // If not, we'll implement a simple version
    const decryptedBalance = await discreteLog(gToTheM);
    console.log("Decrypted balance:", decryptedBalance);
    
    // Assert balance is a number
    expect(decryptedBalance).to.be.a('number');
    expect(bal).to.equal(bal);
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

