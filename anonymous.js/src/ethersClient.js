const crypto = require('crypto');
const BN = require('bn.js');
const { ethers } = require('ethers');

const utils = require('./utils/utils.js');
const { ElGamal } = require('./utils/algebra.js');
const Service = require('./utils/service.js');
const bn128 = require('./utils/bn128.js');

const sleep = (wait) => new Promise((resolve) => { setTimeout(resolve, wait); });

class Client {
    constructor(provider, zsc, home) {
        if (provider === undefined)
            throw "Constructor's first argument should be an initialized ethers.js Provider object.";
        if (zsc === undefined)
            throw "Constructor's second argument should be a deployed ZSC contract object.";
        if (home === undefined)
            throw "Constructor's third argument should be the address of an unlocked Ethereum account.";

        const that = this;
        const transfers = new Set();
        let epochLength = undefined;
        let fee = undefined;

        const getEpoch = (timestamp) => {
            return Math.floor((timestamp === undefined ? (new Date).getTime() / 1000 : timestamp) / epochLength);
        };

        const away = () => { // returns ms away from next epoch change
            const current = (new Date).getTime();
            return Math.ceil(current / (epochLength * 1000)) * (epochLength * 1000) - current;
        };

        const estimate = (size, contract) => {
            // This expression is meant to be a relatively close upper bound of the time that proving + a few verifications will take
            return Math.ceil(size * Math.log(size) / Math.log(2) * 20 + 5200) + (contract ? 20 : 0);
            // The 20-millisecond buffer is designed to give the callback time to fire
        };

        // Setting up transfer event listener 
        // Define the TransferOccurred event filter
        const transferFilter = zsc.filters.TransferOccurred();

        // Add event listener
        zsc.on(transferFilter, async (event) => {
            // Skip if we've already processed this transaction
            if (transfers.has(event.transactionHash)) {
                transfers.delete(event.transactionHash);
                return;
            }
            
            const account = this.account;
            
            // Skip if parties is null (for handling spurious empty events)
            if (event.args.parties === null) return;
            
            // Check if any party matches our account
            for (let i = 0; i < event.args.parties.length; i++) {
                const party = event.args.parties[i];
                if (account.keypair.y.eq(bn128.deserialize(party))) {
                    // Get block for timestamp
                    const block = await provider.getBlock(event.blockNumber);
                    account._state = account._simulate(block.timestamp);
                    
                    // Get transaction
                    const transaction = await provider.getTransaction(event.transactionHash);
                    
                    // Decode the transaction data
                    const transferInterface = zsc.interface.getFunction("transfer");
                    const parameters = zsc.interface.decodeFunctionData(transferInterface, transaction.data);
                    
                    // Extract value
                    const value = utils.readBalance(parameters.C[i], parameters.D, account.keypair.x);
                    
                    if (value > 0) {
                        account._state.pending += value;
                        console.log(`Transfer of ${value} received! Balance now ${account._state.available + account._state.pending}.`);
                    }
                }
            }
            
            // Check if we're the beneficiary for the fee
            if (account.keypair.y.eq(bn128.deserialize(event.args.beneficiary))) {
                account._state.pending += fee;
                console.log(`Fee of ${fee} received! Balance now ${account._state.available + account._state.pending}.`);
            }
        });
        
        // Error handling
        zsc.on("error", (error) => {
            console.log("Transfer event error: " + error);
            console.log(error);
        });
        

        this.account = new function() {
            this.keypair = undefined;
            this._state = {
                available: 0,
                pending: 0,
                nonceUsed: 0,
                lastRollOver: 0
            };

            this._simulate = (timestamp) => {
                const updated = {};
                updated.available = this._state.available;
                updated.pending = this._state.pending;
                updated.nonceUsed = this._state.nonceUsed;
                updated.lastRollOver = getEpoch(timestamp);
                if (this._state.lastRollOver < updated.lastRollOver) {
                    updated.available += updated.pending;
                    updated.pending = 0;
                    updated.nonceUsed = false;
                }
                return updated;
            };

            this.balance = () => this._state.available + this._state.pending;
            this.public = () => bn128.serialize(this.keypair.y);
            this.secret = () => "0x" + this.keypair.x.toString(16, 64);
        };

        this.friends = new function() {
            const friends = {};
            this.add = (name, pubkey) => {
                // todo: checks that these are properly formed, of the right types, etc...
                friends[name] = bn128.deserialize(pubkey);
                return "Friend added.";
            };

            this.show = () => friends;
            this.remove = (name) => {
                if (!(name in friends))
                    throw "Friend " + name + " not found in directory!";
                delete friends[name];
                return "Friend deleted.";
            };
        };

        this.register = async (secret) => {
            console.log("Initiating registration.");
            
            try {
                // Get epochLength and fee using Promise.all
                const [epochLengthBN, feeBN] = await Promise.all([
                    zsc.epochLength(),
                    zsc.fee()
                ]);
                
                epochLength = parseInt(epochLengthBN.toString());
                fee = parseInt(feeBN.toString());
                
                if (secret === undefined) {
                    const keypair = utils.createAccount();
                    const [c, s] = utils.sign(zsc.address, keypair);
                    
                    const tx = await zsc.register(
                        bn128.serialize(keypair.y), 
                        c, 
                        s, 
                        { from: home, gasLimit: 6721975 }
                    );
                    
                    console.log(`Registration submitted (txHash = "${tx.hash}").`);
                    
                    // Wait for transaction confirmation
                    await tx.wait();
                    
                    that.account.keypair = keypair;
                    console.log("Registration successful.");
                } else {
                    const x = new BN(secret.slice(2), 16).toRed(bn128.q);
                    that.account.keypair = { 'x': x, 'y': bn128.curve.g.mul(x) };
                    
                    const result = await zsc.simulateAccounts(
                        [bn128.serialize(this.account.keypair.y)], 
                        getEpoch() + 1
                    );
                    
                    const simulated = result[0];
                    that.account._state.available = utils.readBalance(simulated[0], simulated[1], x);
                    console.log("Account recovered successfully.");
                }
            } catch (error) {
                console.log("Registration failed: " + error);
                throw error;
            }
        };

        this.deposit = async (value) => {
            if (this.account.keypair === undefined)
                throw "Client's account is not yet registered!";
            
            const account = this.account;
            console.log("Initiating deposit.");
            
            try {
                const tx = await zsc.fund(
                    bn128.serialize(account.keypair.y), 
                    value, 
                    { from: home, gasLimit: 6721975 }
                );
                
                console.log(`Deposit submitted (txHash = "${tx.hash}").`);
                
                // Wait for transaction confirmation
                const receipt = await tx.wait();
                
                account._state = account._simulate(); // have to freshly call it
                account._state.pending += value;
                console.log(`Deposit of ${value} was successful. Balance now ${account._state.available + account._state.pending}.`);
                
                return receipt;
            } catch (error) {
                console.log("Deposit failed: " + error);
                throw error;
            }
        };

        this.transfer = async (name, value, decoys, beneficiary) => {
            if (this.account.keypair === undefined)
                throw "Client's account is not yet registered!";
            
            decoys = decoys ? decoys : [];
            const account = this.account;
            const state = account._simulate();
            
            if (value + fee > state.available + state.pending)
                throw `Requested transfer amount of ${value} (plus fee of ${fee}) exceeds account balance of ${state.available + state.pending}.`;
            
            const wait = away();
            const seconds = Math.ceil(wait / 1000);
            const plural = seconds === 1 ? "" : "s";
            
            if (value > state.available) {
                console.log(`Your transfer has been queued. Please wait ${seconds} second${plural}, for the release of your funds...`);
                await sleep(wait);
                return this.transfer(name, value, decoys, beneficiary);
            }
            
            if (state.nonceUsed) {
                console.log(`Your transfer has been queued. Please wait ${seconds} second${plural}, until the next epoch...`);
                await sleep(wait);
                return this.transfer(name, value, decoys, beneficiary);
            }
            
            const size = 2 + decoys.length;
            const estimated = estimate(size, false);
            
            if (estimated > epochLength * 1000)
                throw `The anonset size (${size}) you've requested might take longer than the epoch length (${epochLength} seconds) to prove. Consider re-deploying, with an epoch length at least ${Math.ceil(estimate(size, true) / 1000)} seconds.`;
            
            if (estimated > wait) {
                console.log(wait < 3100 ? "Initiating transfer." : `Your transfer has been queued. Please wait ${seconds} second${plural}, until the next epoch...`);
                await sleep(wait);
                return this.transfer(name, value, decoys, beneficiary);
            }
            
            if (size & (size - 1)) {
                let previous = 1;
                let next = 2;
                while (next < size) {
                    previous *= 2;
                    next *= 2;
                }
                throw `Anonset's size (including you and the recipient) must be a power of two. Add ${next - size} or remove ${size - previous}.`;
            }
            
            const friends = this.friends.show();
            
            if (!(name in friends))
                throw `Name "${name}" hasn't been friended yet!`;
            
            if (account.keypair.y.eq(friends[name]))
                throw "Sending to yourself is currently unsupported (and useless!).";
            
            const y = [account.keypair.y, friends[name]]; // not yet shuffled
            
            decoys.forEach((decoy) => {
                if (!(decoy in friends))
                    throw `Decoy "${decoy}" is unknown in friends directory!`;
                y.push(friends[decoy]);
            });
            
            if (beneficiary !== undefined && !(beneficiary in friends))
                throw `Beneficiary "${beneficiary}" is not known!`;
            
            const index = [];
            let m = y.length;
            
            // Shuffle the array of y's
            while (m !== 0) {
                const i = crypto.randomBytes(1).readUInt8() % m--;
                const temp = y[i];
                y[i] = y[m];
                y[m] = temp;
                if (account.keypair.y.eq(temp)) index[0] = m;
                else if (friends[name].eq(temp)) index[1] = m;
            }
            
            // Make sure you and your friend have opposite parity
            if (index[0] % 2 === index[1] % 2) {
                const temp = y[index[1]];
                y[index[1]] = y[index[1] + (index[1] % 2 === 0 ? 1 : -1)];
                y[index[1] + (index[1] % 2 === 0 ? 1 : -1)] = temp;
                index[1] = index[1] + (index[1] % 2 === 0 ? 1 : -1);
            }
            
            try {
                // Simulate accounts
                const result = await zsc.simulateAccounts(
                    y.map(bn128.serialize), 
                    getEpoch()
                );
                
                const deserialized = result.map((account) => ElGamal.deserialize(account));
                
                if (deserialized.some((account) => account.zero()))
                    throw new Error("Please make sure all parties (including decoys) are registered.");
                
                const r = bn128.randomScalar();
                const D = bn128.curve.g.mul(r);
                
                const C = y.map((party, i) => {
                    const left = ElGamal.base.g.mul(new BN(i === index[0] ? -value - fee : i === index[1] ? value : 0)).add(party.mul(r));
                    return new ElGamal(left, D);
                });
                
                const Cn = deserialized.map((account, i) => account.add(C[i]));
                const proof = Service.proveTransfer(Cn, C, y, state.lastRollOver, account.keypair.x, r, value, state.available - value - fee, index, fee);
                const u = utils.u(state.lastRollOver, account.keypair.x);
                
                // Create throwaway wallet
                const throwaway = ethers.Wallet.createRandom().connect(provider);
                
                const beneficiaryKey = beneficiary === undefined ? bn128.zero : friends[beneficiary];
                
                // Create and sign transaction
                const data = zsc.interface.encodeFunctionData("transfer", [
                    C.map((ciphertext) => bn128.serialize(ciphertext.left())),
                    bn128.serialize(D),
                    y.map(bn128.serialize),
                    bn128.serialize(u),
                    proof.serialize(),
                    bn128.serialize(beneficiaryKey)
                ]);
                
                const tx = {
                    to: zsc.address,
                    data: data,
                    gasLimit: 7721975,
                    nonce: 0
                };
                
                // Get gas price and add it to transaction
                const gasPrice = await provider.getGasPrice();
                tx.gasPrice = gasPrice;
                
                // Sign transaction
                const signedTx = await throwaway.signTransaction(tx);
                
                // Send transaction
                const sentTx = await provider.sendTransaction(signedTx);
                transfers.add(sentTx.hash);
                console.log(`Transfer submitted (txHash = "${sentTx.hash}").`);
                
                // Wait for transaction confirmation
                const receipt = await sentTx.wait();
                
                account._state = account._simulate(); // have to freshly call it
                account._state.nonceUsed = true;
                account._state.pending -= value + fee;
                console.log(`Transfer of ${value} (with fee of ${fee}) was successful. Balance now ${account._state.available + account._state.pending}.`);
                
                return receipt;
            } catch (error) {
                console.log("Transfer failed: " + error);
                throw error;
            }
        };

        this.withdraw = async (value) => {
            if (this.account.keypair === undefined)
                throw "Client's account is not yet registered!";
            
            const account = this.account;
            const state = account._simulate();
            
            if (value > state.available + state.pending)
                throw `Requested withdrawal amount of ${value} exceeds account balance of ${state.available + state.pending}.`;
            
            const wait = away();
            const seconds = Math.ceil(wait / 1000);
            const plural = seconds === 1 ? "" : "s";
            
            if (value > state.available) {
                console.log(`Your withdrawal has been queued. Please wait ${seconds} second${plural}, for the release of your funds...`);
                await sleep(wait);
                return this.withdraw(value);
            }
            
            if (state.nonceUsed) {
                console.log(`Your withdrawal has been queued. Please wait ${seconds} second${plural}, until the next epoch...`);
                await sleep(wait);
                return this.withdraw(value);
            }
            
            if (3100 > wait) { // determined empirically. IBFT, block time 1
                console.log("Initiating withdrawal.");
                await sleep(wait);
                return this.withdraw(value);
            }
            
            try {
                const result = await zsc.simulateAccounts(
                    [bn128.serialize(account.keypair.y)], 
                    getEpoch()
                );
                
                const deserialized = ElGamal.deserialize(result[0]);
                const C = deserialized.plus(new BN(-value));
                const proof = Service.proveBurn(C, account.keypair.y, state.lastRollOver, home, account.keypair.x, state.available - value);
                const u = utils.u(state.lastRollOver, account.keypair.x);
                
                const tx = await zsc.burn(
                    bn128.serialize(account.keypair.y), 
                    value, 
                    bn128.serialize(u), 
                    proof.serialize(), 
                    { from: home, gasLimit: 6721975 }
                );
                
                console.log(`Withdrawal submitted (txHash = "${tx.hash}").`);
                
                // Wait for transaction confirmation
                const receipt = await tx.wait();
                
                account._state = account._simulate(); // have to freshly call it
                account._state.nonceUsed = true;
                account._state.pending -= value;
                console.log(`Withdrawal of ${value} was successful. Balance now ${account._state.available + account._state.pending}.`);
                
                return receipt;
            } catch (error) {
                console.log("Withdrawal failed: " + error);
                throw error;
            }
        };
    }
}

module.exports = Client;