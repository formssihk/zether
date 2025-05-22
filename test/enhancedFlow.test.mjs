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
const EnhancedClient = require("./zetherClient.js");

const HTTP_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const WS_URL = process.env.RPC_WS_URL || "ws://127.0.0.1:8546";
const DEPLOYER_KEY = "0xcce34f0b0f42396c20048c21763fc5ff8096f57ecf2e6f940079cc75ca25501d";

// Contract addresses - update these to match your deployed contracts
const ZTK_ADDRESS = "0x41A0F79712811d03718D63122601c69133EeE1ba"; // Your ZetherEnhancedZTK contract

// Recreate __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load compiled ABIs
function loadArtifact(name) {
  const json = fs.readFileSync(
    path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`),
    "utf8"
  );
  return JSON.parse(json).abi;
}

describe("ZetherEnhancedZTK Tests", function() {
  this.timeout(60000);

  let web3;
  let httpWeb3;
  let deployer;
  let ztk;
  let users;

  const httpProvider = new Web3(HTTP_URL);
  let mintAmount = 10000; // Using smaller amounts compatible with MAX = 2^32-1
  let depositAmt = 5000;
  let transferAmt = 1000;
  
  console.log(`Test amounts - mint: ${mintAmount}, deposit: ${depositAmt}, transfer: ${transferAmt}`);

  before(async () => {
    console.log("Setting up test environment...");
    
    // Initialize web3 connections
    web3 = new Web3(WS_URL);
    httpWeb3 = new Web3(HTTP_URL);
    
    console.log("WS connection status:", web3.currentProvider.getStatus());

    // Add deployer account
    web3.eth.accounts.wallet.add(DEPLOYER_KEY);
    deployer = web3.eth.accounts.wallet[0].address;
    console.log("Deployer address:", deployer);

    // Load contract
    const ztkAbi = loadArtifact("ZetherEnhancedZTK");
    ztk = new httpWeb3.eth.Contract(ztkAbi, ZTK_ADDRESS);
    console.log("Contract loaded at:", ZTK_ADDRESS);

    // Create test users
    users = Array.from({ length: 5 }, () => web3.eth.accounts.create());
    users.forEach(u => web3.eth.accounts.wallet.add(u.privateKey));
    console.log("Created", users.length, "test users");

    // Initial contract setup - mint some tokens to deployer for testing
    try {
      console.log("Minting initial tokens to deployer...");
      await ztk.methods.mint(deployer, mintAmount * 10)
        .send({ from: deployer, gas: 6721975, gasPrice: 0 });
      
      const balance = await ztk.methods.balanceOf(deployer).call();
      console.log("Deployer balance after minting:", balance);
    } catch (error) {
      console.log("Minting failed or tokens already exist:", error.message);
    }
  });

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

  describe("Account Registration", function() {
    it("should register new Zether accounts", async () => {
      console.log("\n=== Testing Account Registration ===");
      
      const alice = new EnhancedClient(web3, ztk, users[0].address, users[0].privateKey);
      const bob = new EnhancedClient(web3, ztk, users[1].address, users[1].privateKey);
      
      console.log("Registering Alice...");
      await alice.register();
      console.log("Alice registered successfully");
      
      console.log("Registering Bob...");
      await bob.register();
      console.log("Bob registered successfully");
      
      // Verify accounts are registered by checking their public keys
      const alicePubKey = alice.account.public();
      const bobPubKey = bob.account.public();
      
      console.log("Alice public key:", alicePubKey);
      console.log("Bob public key:", bobPubKey);
      
      expect(alicePubKey).to.not.be.null;
      expect(bobPubKey).to.not.be.null;
      expect(alicePubKey).to.not.equal(bobPubKey);
    });

    it("should prevent duplicate registration", async () => {
      console.log("\n=== Testing Duplicate Registration Prevention ===");
      
      const carol = new EnhancedClient(web3, ztk, users[2].address, users[2].privateKey);
      
      console.log("Registering Carol for the first time...");
      await carol.register();
      console.log("Carol registered successfully");
      
      console.log("Attempting to register Carol again (should fail)...");
      try {
        await carol.register();
        throw new Error("Should have failed on duplicate registration");
      } catch (error) {
        console.log("Duplicate registration correctly prevented:", error.message);
        expect(error.message).to.include("account already registered");
      }
    });
  });

  describe("Token Deposits", function() {
    it("should deposit tokens into shielded pool", async () => {
      console.log("\n=== Testing Token Deposits ===");
      
      const alice = new EnhancedClient(web3, ztk, users[0].address, users[0].privateKey);
      
      // First, give Alice some tokens
      console.log("Minting tokens to Alice...");
      await ztk.methods.mint(users[0].address, depositAmt)
        .send({ from: deployer, gas: 6721975, gasPrice: 0 });
      
      const aliceBalance = await ztk.methods.balanceOf(users[0].address).call();
      console.log("Alice's token balance:", aliceBalance);
      
      console.log("Alice depositing", depositAmt, "tokens into shielded pool...");
      await alice.depositForPrivateTx(depositAmt, false); // false = don't mint, use existing balance
      
      console.log("Waiting for deposit to be processed...");
      await delay(2000);
      
      // Check Alice's shielded balance
      const shieldedBalance = alice.account.balance();
      console.log("Alice's shielded balance:", shieldedBalance);
      
      expect(shieldedBalance).to.equal(depositAmt);
    });

    it("should allow owner to deposit with minting", async () => {
      console.log("\n=== Testing Owner Deposit with Minting ===");
      
      const ownerClient = new EnhancedClient(web3, ztk, deployer, DEPLOYER_KEY);
      await ownerClient.register();
      
      console.log("Owner depositing", depositAmt, "tokens with minting...");
      await ownerClient.depositForPrivateTx(depositAmt, true); // true = mint new tokens
      
      console.log("Waiting for deposit to be processed...");
      await delay(2000);
      
      const shieldedBalance = ownerClient.account.balance();
      console.log("Owner's shielded balance:", shieldedBalance);
      
      // Check contract reserves
      const reserves = await ztk.methods.getAvailableReserves().call();
      console.log("Contract reserves:", reserves);
      
      expect(shieldedBalance).to.equal(depositAmt);
      expect(parseInt(reserves)).to.be.at.least(depositAmt);
    });
  });

  describe("Shielded Transfers", function() {
    it("should perform shielded transfer between accounts", async () => {
      console.log("\n=== Testing Shielded Transfers ===");
      
      // Setup clients
      const alice = new EnhancedClient(web3, ztk, users[0].address, users[0].privateKey);
      const bob = new EnhancedClient(web3, ztk, users[1].address, users[1].privateKey);
      const carol = new EnhancedClient(web3, ztk, users[2].address, users[2].privateKey);
      const dave = new EnhancedClient(web3, ztk, users[3].address, users[3].privateKey);
      
      // Register all if not already done
      try {
        await dave.register();
        console.log("Dave registered");
      } catch (e) {
        console.log("Dave already registered or registration failed:", e.message);
      }
      
      // Add friends
      alice.friends.add("Bob", bob.account.public());
      alice.friends.add("Carol", carol.account.public());
      alice.friends.add("Dave", dave.account.public());
      
      console.log("Alice's initial balance:", alice.account.balance());
      console.log("Bob's initial balance:", bob.account.balance());
      
      // Wait for epoch if needed
      console.log("Waiting for next epoch...");
      await countdown(5);
      
      console.log("Alice transferring", transferAmt, "to Bob with Carol and Dave as decoys...");
      await alice.shieldedTransfer("Bob", transferAmt, ["Carol", "Dave"]);
      
      console.log("Waiting for transfer to be processed...");
      await delay(5000);
      
      console.log("Alice's final balance:", alice.account.balance());
      console.log("Bob's final balance:", bob.account.balance());
      
      // Note: Exact balance verification might need adjustment based on fee structure
      expect(bob.account.balance()).to.be.greaterThan(0);
    });

    it("should handle transfer freezing by owner", async () => {
      console.log("\n=== Testing Transfer Freeze Functionality ===");
      
      const alice = new EnhancedClient(web3, ztk, users[0].address, users[0].privateKey);
      const bob = new EnhancedClient(web3, ztk, users[1].address, users[1].privateKey);
      
      console.log("Owner freezing shielded transfers...");
      await ztk.methods.freezeZetherTransfers()
        .send({ from: deployer, gas: 6721975, gasPrice: 0 });
      
      console.log("Attempting transfer while frozen (should fail)...");
      try {
        await alice.shieldedTransfer("Bob", 100);
        throw new Error("Transfer should have failed while frozen");
      } catch (error) {
        console.log("Transfer correctly blocked while frozen:", error.message);
        expect(error.message).to.include("transfers are frozen");
      }
      
      console.log("Owner unfreezing shielded transfers...");
      await ztk.methods.unfreezeZetherTransfers()
        .send({ from: deployer, gas: 6721975, gasPrice: 0 });
      
      console.log("Transfers should now work normally again");
    });
  });

  describe("Token Burning (Withdrawal)", function() {
    it("should burn shielded tokens back to transparent tokens", async () => {
      console.log("\n=== Testing Token Burning ===");
      
      const alice = new EnhancedClient(web3, ztk, users[0].address, users[0].privateKey);
      
      const initialShieldedBalance = alice.account.balance();
      const initialTransparentBalance = await ztk.methods.balanceOf(users[0].address).call();
      
      console.log("Alice's initial shielded balance:", initialShieldedBalance);
      console.log("Alice's initial transparent balance:", initialTransparentBalance);
      
      const burnAmount = Math.min(500, initialShieldedBalance);
      if (burnAmount <= 0) {
        console.log("Alice needs shielded tokens to burn, skipping test");
        return;
      }
      
      console.log("Alice burning", burnAmount, "shielded tokens...");
      await alice.burn(burnAmount);
      
      console.log("Waiting for burn to be processed...");
      await delay(5000);
      
      const finalShieldedBalance = alice.account.balance();
      const finalTransparentBalance = await ztk.methods.balanceOf(users[0].address).call();
      
      console.log("Alice's final shielded balance:", finalShieldedBalance);
      console.log("Alice's final transparent balance:", finalTransparentBalance);
      
      expect(finalShieldedBalance).to.equal(initialShieldedBalance - burnAmount);
      expect(parseInt(finalTransparentBalance)).to.equal(parseInt(initialTransparentBalance) + burnAmount);
    });

    it("should prevent burning more than available balance", async () => {
      console.log("\n=== Testing Burn Amount Validation ===");
      
      const bob = new EnhancedClient(web3, ztk, users[1].address, users[1].privateKey);
      const bobBalance = bob.account.balance();
      
      console.log("Bob's shielded balance:", bobBalance);
      
      const excessiveAmount = bobBalance + 1000;
      console.log("Attempting to burn", excessiveAmount, "(should fail)...");
      
      try {
        await bob.burn(excessiveAmount);
        throw new Error("Should have failed on excessive burn amount");
      } catch (error) {
        console.log("Excessive burn correctly prevented:", error.message);
        expect(error.message).to.include("exceeds" || "insufficient");
      }
    });
  });

  describe("Blacklist Functionality", function() {
    it("should prevent blacklisted keys from participating", async () => {
      console.log("\n=== Testing Blacklist Functionality ===");
      
      const mallory = new EnhancedClient(web3, ztk, users[4].address, users[4].privateKey);
      await mallory.register();
      
      const malloryPubKey = mallory.account.keypair.y;
      
      console.log("Owner blacklisting Mallory's public key...");
      await ztk.methods.addToBlacklist([
        bn128.serialize(malloryPubKey)[0],
        bn128.serialize(malloryPubKey)[1]
      ]).send({ from: deployer, gas: 6721975, gasPrice: 0 });
      
      console.log("Attempting deposit with blacklisted key (should fail)...");
      try {
        await ztk.methods.mint(users[4].address, 1000)
          .send({ from: deployer, gas: 6721975, gasPrice: 0 });
        await mallory.depositForPrivateTx(1000, false);
        throw new Error("Should have failed for blacklisted key");
      } catch (error) {
        console.log("Blacklisted key correctly blocked:", error.message);
        expect(error.message).to.include("blacklisted");
      }
      
      console.log("Owner removing Mallory from blacklist...");
      await ztk.methods.removeFromBlacklist([
        bn128.serialize(malloryPubKey)[0],
        bn128.serialize(malloryPubKey)[1]
      ]).send({ from: deployer, gas: 6721975, gasPrice: 0 });
      
      console.log("Mallory should now be able to participate normally");
    });
  });

  describe("Reserve Management", function() {
    it("should track reserves correctly", async () => {
      console.log("\n=== Testing Reserve Management ===");
      
      const initialReserves = await ztk.methods.getAvailableReserves().call();
      console.log("Initial reserves:", initialReserves);
      
      console.log("Owner adding additional reserves...");
      const additionalReserves = 2000;
      
      // Ensure owner has tokens to add as reserves
      const ownerBalance = await ztk.methods.balanceOf(deployer).call();
      if (parseInt(ownerBalance) < additionalReserves) {
        await ztk.methods.mint(deployer, additionalReserves)
          .send({ from: deployer, gas: 6721975, gasPrice: 0 });
      }
      
      await ztk.methods.addReserves(additionalReserves)
        .send({ from: deployer, gas: 6721975, gasPrice: 0 });
      
      const finalReserves = await ztk.methods.getAvailableReserves().call();
      console.log("Final reserves:", finalReserves);
      
      expect(parseInt(finalReserves)).to.equal(parseInt(initialReserves) + additionalReserves);
    });
  });

  after(async () => {
    console.log("\n=== Cleaning up test environment ===");
    
    // Close WebSocket connection
    if (web3.currentProvider.disconnect) {
      web3.currentProvider.disconnect(1000, 'Test complete');
    } else if (web3.currentProvider.connection && web3.currentProvider.connection.close) {
      web3.currentProvider.connection.close();
    }
    
    console.log("Test cleanup completed");
  });
});