const { ethers } = require('ethers');
const Client = require('../anonymous.js/src/client.js');
const { expect } = require('chai');

// Import compiled contract artifacts
const CashTokenArtifact = require('../build/CashToken.json');
const ZSCArtifact = require('../build/ZSC.json');

describe("ZSC", function () {
  let cashToken;
  let zsc;
  let provider;
  let deployer;
  let alice; // will reuse...
  let bob;
  let carol;
  let dave;
  let miner;
  let zuza;
  let bob1;
  let carol1;
  let dave1;
  let miner1;
  let accounts;

  before(async function () {
    // Setup provider and get signers
    provider = new ethers.providers.JsonRpcProvider();
    const signers = await ethers.getSigners();
    accounts = signers.map(signer => signer.address);
    deployer = signers[0];

    // Deploy CashToken
    const CashTokenFactory = new ethers.ContractFactory(
      CashTokenArtifact.abi,
      CashTokenArtifact.bytecode,
      deployer
    );
    cashToken = await CashTokenFactory.deploy();
    await cashToken.deployed();

    // Deploy ZSC
    const ZSCFactory = new ethers.ContractFactory(
      ZSCArtifact.abi,
      ZSCArtifact.bytecode,
      deployer
    );
    zsc = await ZSCFactory.deploy(cashToken.address);
    await zsc.deployed();
  });

  it("should allow minting and approving", async function () {
    await cashToken.mint(accounts[0], 1000);
    await cashToken.approve(zsc.address, 1000);
    const balance = await cashToken.balanceOf(accounts[0]);
    expect(balance.toNumber()).to.equal(1000, "Minting failed");
  });

  it("should allow initialization", async function () {
    alice = new Client(provider, zsc.connect(deployer), accounts[0]);
    await alice.register();
  });

  it("should allow funding", async function () {
    await alice.deposit(100);
  });

  it("should allow withdrawing", async function () {
    await alice.withdraw(10);
  });

  it("should allow transferring (2 decoys and miner)", async function () {
    bob = new Client(provider, zsc.connect(deployer), accounts[0]);
    carol = new Client(provider, zsc.connect(deployer), accounts[0]);
    dave = new Client(provider, zsc.connect(deployer), accounts[0]);
    miner = new Client(provider, zsc.connect(deployer), accounts[0]);
    
    await Promise.all([bob.register(), carol.register(), dave.register(), miner.register()]);
    
    alice.friends.add("Bob", bob.account.public());
    alice.friends.add("Carol", carol.account.public());
    alice.friends.add("Dave", dave.account.public());
    alice.friends.add("Miner", miner.account.public());
    
    await alice.transfer("Bob", 10, ["Carol", "Dave"], "Miner");
    
    // Wait for transaction to be mined and events to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    expect(bob.account.balance()).to.equal(10, "Transfer failed");
    
    const fee = await zsc.fee();
    expect(miner.account.balance()).to.equal(Number(fee), "Fees failed");
  });

  it("should allow transferring (2 decoys and NO miner)", async function () {
    await alice.transfer("Bob", 10, ["Carol", "Dave"]);
    
    // Wait for transaction to be mined and events to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    expect(bob.account.balance()).to.equal(20, "Transfer failed");
  });

  it("should allow transferring (6 decoys and miner)", async function () {
    bob1 = new Client(provider, zsc.connect(deployer), accounts[0]);
    carol1 = new Client(provider, zsc.connect(deployer), accounts[0]);
    dave1 = new Client(provider, zsc.connect(deployer), accounts[0]);
    miner1 = new Client(provider, zsc.connect(deployer), accounts[0]);
    
    await Promise.all([bob1.register(), carol1.register(), dave1.register(), miner1.register()]);
    
    alice.friends.add("Bob1", bob1.account.public());
    alice.friends.add("Carol1", carol1.account.public());
    alice.friends.add("Dave1", dave1.account.public());
    alice.friends.add("Miner1", miner1.account.public());
    
    await alice.transfer("Bob", 10, ["Carol", "Dave", "Bob1", "Carol1", "Dave1", "Miner1"], "Miner");
    
    // Wait for transaction to be mined and events to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    expect(bob.account.balance()).to.equal(30, "Transfer failed");
    
    const fee = await zsc.fee();
    expect(miner.account.balance()).to.equal(Number(fee), "Fees failed");
  });

  it("should allow transferring without decoys or miner", async function () {
    zuza = new Client(provider, zsc.connect(deployer), accounts[0]);
    await zuza.register();
    
    alice.friends.add("Zuza", zuza.account.public());
    await alice.transfer("Zuza", 5);
    
    // Wait for transaction to be mined and events to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    expect(zuza.account.balance()).to.equal(5, "Transfer failed");
  });

  it("should allow transferring without decoys but with miner", async function () {
    await alice.transfer("Carol", 5, [], "Miner");
    
    // Wait for transaction to be mined and events to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    expect(carol.account.balance()).to.equal(5, "Transfer failed");
  });
});