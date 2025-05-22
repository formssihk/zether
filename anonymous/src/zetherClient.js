const crypto = require('crypto');
const BN = require('bn.js');

const utils = require('./utils/utils.js');
const { ElGamal } = require('./utils/algebra.js');
const Service = require('./utils/service.js');
const bn128 = require('./utils/bn128.js');

const sleep = (wait) => new Promise((resolve) => { setTimeout(resolve, wait); });

class EnhancedClient {
  constructor(web3, ztk, home, privKey) {
    if (web3 === undefined)
      throw "Constructor's first argument should be an initialized Web3 object.";
    if (ztk === undefined)
      throw "Constructor's second argument should be a deployed ZetherEnhancedZTK contract object.";
    if (home === undefined)
      throw "Constructor's third argument should be the address of an unlocked Ethereum account.";
    
    console.log(`Enhanced Client constructor: home = ${home}`);

    web3.transactionConfirmationBlocks = 1;
    const that = this;

    const transfers = new Set();
    let epochLength = undefined;
    let fee = undefined;

    const getEpoch = (timestamp) => {
      return Math.floor((timestamp === undefined ? (new Date).getTime() / 1000 : timestamp) / epochLength);
    };

    const getChainEpoch = async () => {
      const latestBlock = await web3.eth.getBlock('latest');
      console.log(`Latest block timestamp: ${latestBlock.timestamp}`);
      const ts = Number(latestBlock.timestamp);
      console.log(`Timestamp in seconds: ${ts}`);

      const epochLen = Number(await ztk.methods.epochLength().call());
      console.log(`Epoch length from contract: ${epochLen} seconds`);

      const epo = Math.floor(ts / epochLen)
      console.log(`Computed epoch: ${epo}`);
      return epo;
    }

    const away = () => {
      const current = (new Date).getTime();
      return Math.ceil(current / (epochLength * 1000)) * (epochLength * 1000) - current;
    };

    // Listen for shielded transfer events
    ztk.events.ShieldedTransfer()
      .on('data', (event) => {
        console.log("ShieldedTransfer event received:", event.transactionHash);
        if (transfers.has(event.transactionHash)) {
          transfers.delete(event.transactionHash);
          return;
        }
        
        const account = this.account;
        if (event.returnValues['parties'] === null) return;
        
        event.returnValues['parties'].forEach((party, i) => {
          if (account.keypair && account.keypair['y'].eq(bn128.deserialize(party))) {
            const blockNumber = event.blockNumber;
            web3.eth.getBlock(blockNumber).then((block) => {
              account._state = account._simulate(block.timestamp);
              web3.eth.getTransaction(event.transactionHash).then((transaction) => {
                // Process the received transfer
                console.log("Processing received shielded transfer...");
                // Note: This would need to be implemented based on your specific event structure
              });
            });
          }
        });
      })
      .on('error', (error) => {
        console.log("ShieldedTransfer event error: " + error);
      });

    // Listen for deposit events
    ztk.events.Deposited()
      .on('data', (event) => {
        console.log("Deposited event received:", event.returnValues);
        const account = this.account;
        if (account.keypair) {
          const pubKeyHash = web3.utils.keccak256(web3.eth.abi.encodeParameters(
            ['uint256', 'uint256'], 
            bn128.serialize(account.keypair['y'])
          ));
          if (event.returnValues.publicKey === pubKeyHash) {
            account._state.pending += parseInt(event.returnValues.amount);
            console.log(`Deposit of ${event.returnValues.amount} processed! Balance now ${account._state.available + account._state.pending}.`);
          }
        }
      });

    // Listen for burn events
    ztk.events.Burned()
      .on('data', (event) => {
        console.log("Burned event received:", event.returnValues);
        const account = this.account;
        if (account.keypair) {
          const pubKeyHash = web3.utils.keccak256(web3.eth.abi.encodeParameters(
            ['uint256', 'uint256'], 
            bn128.serialize(account.keypair['y'])
          ));
          if (event.returnValues.publicKey === pubKeyHash) {
            account._state.pending -= parseInt(event.returnValues.amount);
            console.log(`Burn of ${event.returnValues.amount} processed! Balance now ${account._state.available + account._state.pending}.`);
          }
        }
      });

    this.account = new function () {
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
      this.public = () => bn128.serialize(this.keypair['y']);
      this.secret = () => "0x" + this.keypair['x'].toString(16, 64);
    };

    this.friends = new function () {
      const friends = {};
      this.add = (name, pubkey) => {
        friends[name] = bn128.deserialize(pubkey);
        console.log(`Friend ${name} added to directory.`);
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

    // Enhanced register function for ZetherEnhancedZTK
    this.register = (secret) => {
      console.log("Initiating registration with ZetherEnhancedZTK.");
      return Promise.all([ztk.methods.epochLength().call(), ztk.methods.fee().call()]).then((result) => {
        console.log("Epoch length is " + result[0] + " seconds.");
        console.log("Fee is " + result[1] + ".");
        epochLength = parseInt(result[0]);
        fee = parseInt(result[1]);
        
        return new Promise((resolve, reject) => {
          if (secret === undefined) {
            console.log("No secret provided. Generating a new keypair.");
            const keypair = utils.createAccount();
            console.log("Keypair generated.");
            console.log("Public key: " + bn128.serialize(keypair['y']).toString('hex'));
            console.log("Secret key: " + "0x" + keypair['x'].toString(16, 64));
            
            const [c, s] = utils.sign(ztk._address, keypair);
            console.log("Signature generated.");
            console.log("Signature: " + c.toString(16, 64) + s.toString(16, 64));
            console.log("Registering with registerAccount...");

            (async () => {
              try {
                const data = ztk.methods
                  .registerAccount(bn128.serialize(keypair.y), c, s)
                  .encodeABI();

                const nonce = await web3.eth.getTransactionCount(home, 'pending');
                const chainId = await web3.eth.getChainId();

                const tx = {
                  from: home,
                  to: ztk.options.address,
                  data,
                  gas: 6_721_975,
                  gasPrice: '0',
                  nonce,
                  chainId
                };

                const { rawTransaction } = await web3.eth.accounts.signTransaction(tx, privKey);

                web3.eth
                  .sendSignedTransaction(rawTransaction)
                  .on('transactionHash', (hash) => {
                    console.log(`Registration submitted (txHash = "${hash}").`);
                  })
                  .on('receipt', (receipt) => {
                    console.log("Registration receipt:", receipt);
                    that.account.keypair = keypair;
                    console.log("Registration successful with ZetherEnhancedZTK.");
                    resolve();
                  })
                  .on('error', (error) => {
                    console.log("Registration failed: " + error);
                    reject(error);
                  });
              } catch (err) {
                reject(err);
              }
            })();
          } else {
            const x = new BN(secret.slice(2), 16).toRed(bn128.q);
            that.account.keypair = { 'x': x, 'y': bn128.curve.g.mul(x) };
            ztk.methods.simulateAccounts([bn128.serialize(this.account.keypair['y'])], getEpoch() + 1).call().then((result) => {
              const simulated = result[0];
              that.account._state.available = utils.readBalance(simulated[0], simulated[1], x);
              console.log("Account recovered successfully.");
              resolve();
            });
          }
        });
      });
    };

    // Enhanced deposit function using depositForPrivateTx
    this.depositForPrivateTx = (value, shouldMint = false) => {
      if (this.account.keypair === undefined)
        throw "Client's account is not yet registered!";
      
      const account = this.account;
      console.log(`Initiating deposit of ${value} tokens (shouldMint: ${shouldMint}).`);

      return new Promise((resolve, reject) => {
        (async () => {
          try {
            const data = ztk.methods
              .depositForPrivateTx(value, bn128.serialize(account.keypair.y), shouldMint)
              .encodeABI();

            const nonce = await web3.eth.getTransactionCount(home, 'pending');
            const chainId = await web3.eth.getChainId();

            const tx = {
              from: home,
              to: ztk.options.address,
              data,
              gas: 6_721_975,
              gasPrice: '0',
              nonce,
              chainId
            };

            const { rawTransaction } = await web3.eth.accounts.signTransaction(tx, privKey);

            web3.eth
              .sendSignedTransaction(rawTransaction)
              .on('transactionHash', (hash) => {
                console.log(`Deposit submitted (txHash = "${hash}").`);
              })
              .on('receipt', (receipt) => {
                console.log("Deposit receipt:", receipt);
                account._state = account._simulate();
                account._state.pending += value;
                console.log(
                  `Deposit of ${value} was successful. ` +
                  `Balance now ${account._state.available + account._state.pending}.`
                );
                resolve(receipt);
              })
              .on('error', (error) => {
                console.log("Deposit failed: " + error);
                reject(error);
              });
          } catch (err) {
            reject(err);
          }
        })();
      });
    };

    // Enhanced shielded transfer function
    this.shieldedTransfer = async function (name, value, decoys, beneficiary) {
      console.log(`Initiating shielded transfer: to=${name}, value=${value}, decoys=${decoys?.join(',')}, beneficiary=${beneficiary}`);

      if (this.account.keypair === undefined)
        throw "Client's account is not yet registered!";

      decoys = decoys ? decoys : [];
      const account = this.account;

      let state = account._simulate();
      console.log(`Current state - available: ${state.available}, pending: ${state.pending}`);

      const size = 2 + decoys.length;
      console.log(`Anonset size: ${size}`);

      // Check for power of two size
      if (size & (size - 1)) {
        let previous = 1;
        let next = 2;
        while (next < size) {
          previous *= 2;
          next *= 2;
        }
        throw `Anonset's size (including you and the recipient) must be a power of two. Add ${next - size} or remove ${size - previous}.`;
      }

      // Friend validation
      const friends = this.friends.show();
      if (!(name in friends))
        throw `Name "${name}" hasn't been friended yet!`;
      if (account.keypair['y'].eq(friends[name]))
        throw "Sending to yourself is currently unsupported (and useless!).";

      // Build parties array
      const y = [account.keypair['y'], friends[name]];
      decoys.forEach((decoy) => {
        if (!(decoy in friends))
          throw `Decoy "${decoy}" is unknown in friends directory!`;
        y.push(friends[decoy]);
      });

      if (beneficiary !== undefined && !(beneficiary in friends))
        throw `Beneficiary "${beneficiary}" is not known!`;

      // Shuffle parties
      const index = [];
      let m = y.length;
      while (m !== 0) {
        const i = crypto.randomBytes(1).readUInt8() % m--;
        const temp = y[i];
        y[i] = y[m];
        y[m] = temp;
        if (account.keypair['y'].eq(temp)) index[0] = m;
        else if (friends[name].eq(temp)) index[1] = m;
      }

      // Ensure sender and receiver have opposite parity
      if (index[0] % 2 === index[1] % 2) {
        const temp = y[index[1]];
        y[index[1]] = y[index[1] + (index[1] % 2 === 0 ? 1 : -1)];
        y[index[1] + (index[1] % 2 === 0 ? 1 : -1)] = temp;
        index[1] = index[1] + (index[1] % 2 === 0 ? 1 : -1);
      }

      console.log(`Sender index: ${index[0]}, Receiver index: ${index[1]}`);

      console.log("Starting shielded transfer execution");
      return new Promise(async (resolve, reject) => {
        const epoch = getEpoch();
        console.log(`Current epoch: ${epoch}`);

        account._state.lastRollOver = epoch;

        try {
          console.log("Calling simulateAccounts for shielded transfer");
          const result = await ztk.methods.simulateAccounts(y.map(bn128.serialize), epoch).call();
          console.log("simulateAccounts succeeded");

          const deserialized = result.map((account) => ElGamal.deserialize(account));
          console.log(`Found ${deserialized.length} account states`);

          // Check for zero balances
          const zeroAccounts = deserialized.map((account, i) => account.zero() ? i : -1).filter(i => i >= 0);
          if (zeroAccounts.length > 0) {
            console.error(`Zero balance accounts at indices: ${zeroAccounts.join(', ')}`);
            return reject(new Error(`Please make sure all parties (including decoys) are registered. Zero accounts at indices: ${zeroAccounts.join(', ')}`));
          }

          console.log("Generating proof for shielded transfer");
          const r = bn128.randomScalar();
          const D = bn128.curve.g.mul(r);
          const C = y.map((party, i) => {
            const amount = i === index[0] ? -value - fee : i === index[1] ? value : 0;
            console.log(`Transfer amount for party ${i}: ${amount}`);
            const left = ElGamal.base['g'].mul(new BN(amount)).add(party.mul(r));
            return new ElGamal(left, D);
          });

          const Cn = deserialized.map((account, i) => account.add(C[i]));

          console.log(`Proving shielded transfer with: 
                - Value: ${value}
                - Fee: ${fee}
                - Last rollover: ${state.lastRollOver}
                - State: ${epoch}
                - Available after transfer: ${state.available - value - fee}
            `);

          const proof = Service.proveTransfer(
            Cn, C, y, epoch, account.keypair['x'], r,
            value, state.available - value - fee, index, fee
          );

          console.log("Proof generated successfully for shielded transfer");

          const u = utils.u(epoch, account.keypair['x']);
          console.log(`Generated u value for epoch ${epoch}`);

          const beneficiaryKey = beneficiary === undefined ? bn128.zero : friends[beneficiary];

          // Use shieldedTransfer method instead of transfer
          const encoded = ztk.methods.shieldedTransfer(
            C.map((ciphertext) => bn128.serialize(ciphertext.left())),
            bn128.serialize(D),
            y.map(bn128.serialize),
            bn128.serialize(u),
            proof.serialize(),
            bn128.serialize(beneficiaryKey)
          ).encodeABI();

          console.log("Estimating gas for shielded transfer...");
          try {
            const gasEstimate = await web3.eth.estimateGas({
              from: home,
              to: ztk.options.address,
              data: encoded
            });
            console.log(`Gas estimate: ${gasEstimate}`);
          } catch (gasEstimateError) {
            console.error("Gas estimation failed. This indicates the transaction would revert:", gasEstimateError);
            try {
              await ztk.methods.shieldedTransfer(
                C.map((ciphertext) => bn128.serialize(ciphertext.left())),
                bn128.serialize(D),
                y.map(bn128.serialize),
                bn128.serialize(u),
                proof.serialize(),
                bn128.serialize(beneficiaryKey)
              ).call({ from: home });
            } catch (callError) {
              console.error("Contract call error details:", callError);
              return reject(new Error(`Transaction would revert: ${callError.message}`));
            }
          }

          const nonce = await web3.eth.getTransactionCount(home, 'pending');
          const chainId = await web3.eth.getChainId();
          console.log(`Using nonce ${nonce} on chain ID ${chainId}`);

          const tx = {
            from: home,
            to: ztk.options.address,
            data: encoded,
            gas: 7721975,
            gasPrice: '0',
            nonce,
            chainId
          };

          console.log("Signing shielded transfer transaction...");
          const { rawTransaction } = await web3.eth.accounts.signTransaction(tx, privKey);

          console.log("Sending shielded transfer transaction...");
          web3.eth.sendSignedTransaction(rawTransaction)
            .on('transactionHash', (hash) => {
              transfers.add(hash);
              console.log(`Shielded transfer submitted (txHash = "${hash}").`);
            })
            .on('receipt', (receipt) => {
              console.log("Shielded transfer receipt:", receipt);

              if (receipt.status) {
                console.log("Shielded transfer receipt received successfully");
                account._state = account._simulate();
                account._state.nonceUsed = true;
                account._state.pending -= value + fee;
                console.log(`Shielded transfer of ${value} (with fee of ${fee}) was successful. Balance now ${account._state.available + account._state.pending}.`);
                resolve(receipt);
              } else {
                console.error("Transaction receipt indicates failure:", receipt);
                reject(new Error("Transaction failed with receipt status: " + receipt.status));
              }
            })
            .on('error', (error) => {
              console.error("Shielded transfer transaction error:", error);
              reject(new Error(`Shielded transfer failed: ${error.message}`));
            });

        } catch (error) {
          console.error("Error during shielded transfer process:", error);
          reject(new Error(`Shielded transfer failed: ${error.message}`));
        }
      });
    };

    this.simulateAccounts = async (pubkeys) => {
      const epoch = await getChainEpoch();
      console.log(`Current epoch: ${epoch}`);
      return ztk.methods.simulateAccounts(pubkeys.map(bn128.serialize), epoch).call()
        .then((result) => {
          return result.map((account) => ElGamal.deserialize(account));
        })
        .catch((error) => {
          console.error("Error simulating accounts:", error);
          throw new Error(`Simulation failed: ${error.message}`);
        });
    };

    // Enhanced burn function for ZetherEnhancedZTK
    this.burn = (value) => {
      if (this.account.keypair === undefined)
        throw "Client's account is not yet registered!";
      
      const account = this.account;
      console.log(`Initiating burn of ${value} shielded tokens.`);

      const attempt = () => {
        const state = account._simulate();
        if (value > state.available + state.pending)
          throw `Requested burn amount of ${value} exceeds account balance of ${state.available + state.pending}.`;

        const wait = away();
        const seconds = Math.ceil(wait / 1000);
        const plural = seconds === 1 ? "" : "s";

        if (value > state.available) {
          console.log(`Your burn has been queued. Please wait ${seconds} second${plural}, for the release of your funds...`);
          return sleep(wait).then(attempt);
        }
        if (state.nonceUsed) {
          console.log(`Your burn has been queued. Please wait ${seconds} second${plural}, until the next epoch...`);
          return sleep(wait).then(attempt);
        }
        if (3100 > wait) {
          console.log("Initiating burn.");
          return sleep(wait).then(attempt);
        }

        // Ready to send the actual burn transaction
        return new Promise((resolve, reject) => {
          ztk.methods
            .simulateAccounts([bn128.serialize(account.keypair.y)], getEpoch())
            .call()
            .then(async (result) => {
              try {
                console.log("Building burn proof...");
                const deserialized = ElGamal.deserialize(result[0]);
                const C = deserialized.plus(new BN(-value));
                const proof = Service.proveBurn(
                  C,
                  account.keypair.y,
                  state.lastRollOver,
                  home,
                  account.keypair.x,
                  state.available - value
                );
                const u = utils.u(state.lastRollOver, account.keypair.x);

                console.log("Burn proof generated successfully");

                // Use burn method from ZetherEnhancedZTK
                const data = ztk.methods
                  .burn(
                    bn128.serialize(account.keypair.y),
                    value,
                    bn128.serialize(u),
                    proof.serialize()
                  )
                  .encodeABI();

                const nonce = await web3.eth.getTransactionCount(home, 'pending');
                const chainId = await web3.eth.getChainId();

                const tx = {
                  from: home,
                  to: ztk.options.address,
                  data,
                  gas: 6_721_975,
                  gasPrice: '0',
                  nonce,
                  chainId
                };

                const { rawTransaction } = await web3.eth.accounts.signTransaction(tx, privKey);

                web3.eth
                  .sendSignedTransaction(rawTransaction)
                  .on('transactionHash', (hash) => {
                    console.log(`Burn submitted (txHash = "${hash}").`);
                  })
                  .on('receipt', (receipt) => {
                    console.log("Burn receipt:", receipt);
                    account._state = account._simulate();
                    account._state.nonceUsed = true;
                    account._state.pending -= value;
                    console.log(
                      `Burn of ${value} was successful. ` +
                      `Balance now ${account._state.available + account._state.pending}.`
                    );
                    resolve(receipt);
                  })
                  .on('error', (error) => {
                    console.log("Burn failed: " + error);
                    reject(error);
                  });
              } catch (err) {
                console.error("Error during burn process:", err);
                reject(err);
              }
            })
            .catch(reject);
        });
      };

      return attempt();
    };

    // Additional helper functions for ZetherEnhancedZTK

    // Check if transfers are frozen
    this.areTransfersFrozen = async () => {
      try {
        const frozen = await ztk.methods.zetherTransfersFrozen().call();
        console.log("Transfers frozen status:", frozen);
        return frozen;
      } catch (error) {
        console.error("Error checking freeze status:", error);
        throw error;
      }
    };

    // Get contract reserves (if you're the owner or for informational purposes)
    this.getAvailableReserves = async () => {
      try {
        const reserves = await ztk.methods.getAvailableReserves().call();
        console.log("Available reserves:", reserves);
        return reserves;
      } catch (error) {
        console.error("Error getting reserves:", error);
        throw error;
      }
    };

    // Check if a key is blacklisted
    this.isKeyBlacklisted = async (pubKey) => {
      try {
        const keyHash = web3.utils.keccak256(web3.eth.abi.encodeParameters(
          ['uint256', 'uint256'], 
          bn128.serialize(pubKey)
        ));
        const blacklisted = await ztk.methods.blacklistedKeys(keyHash).call();
        console.log("Key blacklisted status:", blacklisted);
        return blacklisted;
      } catch (error) {
        console.error("Error checking blacklist status:", error);
        throw error;
      }
    };

    // Get current epoch from contract
    this.getCurrentEpoch = async () => {
      try {
        const epoch = await getChainEpoch();
        console.log("Current contract epoch:", epoch);
        return epoch;
      } catch (error) {
        console.error("Error getting current epoch:", error);
        throw error;
      }
    };

  }
}

module.exports = EnhancedClient;