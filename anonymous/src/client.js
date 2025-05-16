const crypto = require('crypto');
const BN = require('bn.js');

const utils = require('./utils/utils.js');
const { ElGamal } = require('./utils/algebra.js');
const Service = require('./utils/service.js');
const bn128 = require('./utils/bn128.js');

const sleep = (wait) => new Promise((resolve) => { setTimeout(resolve, wait); });

class Client {
  constructor(web3, zsc, home, privKey) {
    if (web3 === undefined)
      throw "Constructor's first argument should be an initialized Web3 object.";
    if (zsc === undefined)
      throw "Constructor's second argument should be a deployed ZSC contract object.";
    if (home === undefined)
      throw "Constructor's third argument should be the address of an unlocked Ethereum account.";
    console.log(`Client constructor: home = ${home}`);

    web3.transactionConfirmationBlocks = 1;
    const that = this;

    const transfers = new Set();
    let epochLength = undefined;
    let fee = undefined;

    const getEpoch = (timestamp) => {
      return Math.floor((timestamp === undefined ? (new Date).getTime() / 1000 : timestamp) / epochLength);
    };

    const getChainEpoch = async () => {
      // 1) fetch the latest block’s timestamp
      const latestBlock = await web3.eth.getBlock('latest');
      console.log(`Latest block timestamp: ${latestBlock.timestamp}`);
      const ts = Number(latestBlock.timestamp);
      console.log(`Timestamp in seconds: ${ts}`);

      // 2) fetch epochLength from the contract (in seconds)
      const epochLen = Number(await zsc.methods.epochLength().call());
      console.log(`Epoch length from contract: ${epochLen} seconds`);

      // 3) compute and return the on-chain epoch
      const epo = Math.floor(ts / epochLen)
      console.log(`Computed epoch: ${epo}`);
      return epo;
    }


    const away = () => { // returns ms away from next epoch change
      const current = (new Date).getTime();
      return Math.ceil(current / (epochLength * 1000)) * (epochLength * 1000) - current;
    };

    const estimate = (size, contract) => {
      // this expression is meant to be a relatively close upper bound of the time that proving + a few verifications will take, as a function of anonset size
      // this function should hopefully give you good epoch lengths also for 8, 16, 32, etc... if you have very heavy traffic, may need to bump it up (many verifications)
      // i calibrated this on _my machine_. if you are getting transfer failures, you might need to bump up the constants, recalibrate yourself, etc.
      return Math.ceil(size * Math.log(size) / Math.log(2) * 20 + 5200) + (contract ? 20 : 0);
      // the 20-millisecond buffer is designed to give the callback time to fire (see below).
    };


    zsc.events.TransferOccurred() // i guess this will just filter for "from here on out."
      // an interesting prospect is whether balance recovery could be eliminated by looking at past events.
      .on('data', (event) => {
        if (transfers.has(event.transactionHash)) {
          transfers.delete(event.transactionHash);
          return;
        }
        const account = this.account;
        if (event.returnValues['parties'] === null) return; // truffle is sometimes emitting spurious empty events??? have to avoid this case manually.
        event.returnValues['parties'].forEach((party, i) => {
          if (account.keypair['y'].eq(bn128.deserialize(party))) {
            const blockNumber = event.blockNumber;
            web3.eth.getBlock(blockNumber).then((block) => {
              account._state = account._simulate(block.timestamp);
              web3.eth.getTransaction(event.transactionHash).then((transaction) => {
                let inputs;
                zsc._jsonInterface.forEach((element) => {
                  if (element['name'] === "transfer")
                    inputs = element['inputs'];
                });
                const parameters = web3.eth.abi.decodeParameters(inputs, "0x" + transaction.input.slice(10));
                const value = utils.readBalance(parameters['C'][i], parameters['D'], account.keypair['x']);
                if (value > 0) {
                  account._state.pending += value;
                  console.log("Transfer of " + value + " received! Balance now " + (account._state.available + account._state.pending) + ".");
                }
              });
            });
          }
        });
        if (account.keypair['y'].eq(bn128.deserialize(event.returnValues['beneficiary']))) {
          account._state.pending += fee;
          console.log("Fee of " + fee + " received! Balance now " + (account._state.available + account._state.pending) + ".");
        }
      })
    // .on('error', (error) => {
    //     console.log("Transfer event error: " + error);
    //     console.log(error); // when will this be called / fired...?! confusing. also, test this.
    // });

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

    this.register = (secret) => {
      console.log("Initiating registration.");
      return Promise.all([zsc.methods.epochLength().call(), zsc.methods.fee().call()]).then((result) => {
        console.log("Epoch length is " + result[0] + " seconds.");
        console.log("Fee is " + result[1] + ".");
        epochLength = parseInt(result[0]);
        fee = parseInt(result[1]);
        return new Promise((resolve, reject) => {
          console.log("get secret: " + secret);
          if (secret === undefined) {
            console.log("No secret provided. Generating a new keypair.");
            const keypair = utils.createAccount();
            console.log("Keypair generated.");
            console.log("Public key: " + bn128.serialize(keypair['y']).toString('hex'));
            console.log("Secret key: " + "0x" + keypair['x'].toString(16, 64));
            const [c, s] = utils.sign(zsc._address, keypair);
            console.log("Signature generated.");
            console.log("Signature: " + c.toString(16, 64) + s.toString(16, 64));
            console.log("Registering...");

            (async () => {
              try {
                // 1) ABI-encode the call
                const data = zsc.methods
                  .register(bn128.serialize(keypair.y), c, s)
                  .encodeABI();

                // 2) Get nonce and chainId
                const nonce = await web3.eth.getTransactionCount(home, 'pending');
                const chainId = await web3.eth.getChainId();

                // 3) Build the tx object
                const tx = {
                  from: home,
                  to: zsc.options.address,
                  data,
                  gas: 6_721_975,
                  gasPrice: '0',
                  nonce,
                  chainId
                };

                // 4) Sign locally
                const { rawTransaction } = await web3.eth.accounts.signTransaction(tx, privKey);

                // 5) Broadcast
                web3.eth
                  .sendSignedTransaction(rawTransaction)
                  .on('transactionHash', (hash) => {
                    console.log(`Registration submitted (txHash = "${hash}").`);
                  })
                  .on('receipt', (receipt) => {
                    that.account.keypair = keypair;
                    console.log("Registration successful.");
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
            zsc.methods.simulateAccounts([bn128.serialize(this.account.keypair['y'])], getEpoch() + 1).call().then((result) => {
              const simulated = result[0];
              that.account._state.available = utils.readBalance(simulated[0], simulated[1], x);
              console.log("Account recovered successfully.");
              resolve(); // warning: won't register you. assuming you registered when you first created the account.
            });
          }
        });
      });
    };

    this.deposit = (value) => {
      if (this.account.keypair === undefined)
        throw "Client's account is not yet registered!";
      const account = this.account;
      console.log("Initiating deposit.");

      return new Promise((resolve, reject) => {
        (async () => {
          try {
            // 1) ABI-encode the call
            const data = zsc.methods
              .fund(bn128.serialize(account.keypair.y), value)
              .encodeABI();

            // 2) Get nonce & chainId
            const nonce = await web3.eth.getTransactionCount(home, 'pending');
            const chainId = await web3.eth.getChainId();

            // 3) Build tx object
            const tx = {
              from: home,
              to: zsc.options.address,
              data,
              gas: 6_721_975,
              gasPrice: '0',
              nonce,
              chainId
            };

            // 4) Sign locally
            const { rawTransaction } = await web3.eth.accounts.signTransaction(tx, privKey);

            // 5) Broadcast
            web3.eth
              .sendSignedTransaction(rawTransaction)
              .on('transactionHash', (hash) => {
                console.log(`Deposit submitted (txHash = "${hash}").`);
              })
              .on('receipt', (receipt) => {
                // refresh simulated state and update pending
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


    // Modified transfer method with improved error handling

    this.transfer = async function (name, value, decoys, beneficiary) {
      console.log(`TEST TRANSFER: to=${name}, value=${value}, decoys=${decoys?.join(',')}, beneficiary=${beneficiary}`);

      if (this.account.keypair === undefined)
        throw "Client's account is not yet registered!";

      decoys = decoys ? decoys : [];
      const account = this.account;

      // Force state with all funds available
      let state = account._simulate();
      console.log(`Original state - available: ${state.available}, pending: ${state.pending}`);

      // state.available += state.pending;
      // state.pending = 0;
      // account._state = state;

      console.log(`Modified state - available: ${state.available}, pending: ${state.pending}`);

      // if (value + fee > state.available)
      //     throw `Requested transfer amount of ${value} (plus fee of ${fee}) exceeds account balance of ${state.available}.`;

      // Skip all recursive waiting code
      console.log("Bypassing epoch waiting logic for test");

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
      const y = [account.keypair['y'], friends[name]]; // not yet shuffled
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

      // Main transfer promise
      console.log("Starting test transfer execution");
      return new Promise(async (resolve, reject) => {
        // First, check if we're on the right epoch
        // console.log(`Current epoch: ${getEpoch()}`);
        const epoch = getEpoch();
        console.log(`Current epoch: ${epoch}`);

        account._state.lastRollOver = epoch;

        // Try to call the contract's epochLength method to make sure the ZSC contract is working
        zsc.methods.epochLength().call()
          .then(epochLen => {
            console.log(`Contract epoch length: ${epochLen} seconds`);

            console.log("Calling simulateAccounts");
            // return zsc.methods.simulateAccounts(y.map(bn128.serialize), getEpoch()).call();
            return zsc.methods.simulateAccounts(y.map(bn128.serialize), epoch).call();
          })
          .then(async (result) => {
            console.log("simulateAccounts succeeded");

            // Validate account states
            const deserialized = result.map((account) => ElGamal.deserialize(account));
            console.log(`Found ${deserialized.length} account states`);

            // Check for zero balances
            const zeroAccounts = deserialized.map((account, i) => account.zero() ? i : -1).filter(i => i >= 0);
            if (zeroAccounts.length > 0) {
              console.error(`Zero balance accounts at indices: ${zeroAccounts.join(', ')}`);
              return reject(new Error(`Please make sure all parties (including decoys) are registered. Zero accounts at indices: ${zeroAccounts.join(', ')}`));
            }

            console.log("Generating proof");
            try {
              const r = bn128.randomScalar();
              const D = bn128.curve.g.mul(r);
              const C = y.map((party, i) => {
                const amount = i === index[0] ? -value - fee : i === index[1] ? value : 0;
                console.log(`Transfer amount for party ${i}: ${amount}`);
                const left = ElGamal.base['g'].mul(new BN(amount)).add(party.mul(r));
                return new ElGamal(left, D);
              });

              const Cn = deserialized.map((account, i) => account.add(C[i]));

              // Log the proof parameters 
              console.log(`Proving transfer with: 
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

              console.log("Proof generated successfully");

              const u = utils.u(epoch, account.keypair['x']);
              console.log(`Generated u value for epoch ${state.lastRollOver}`);

              const beneficiaryKey = beneficiary === undefined ? bn128.zero : friends[beneficiary];

              // Create transaction
              const encoded = zsc.methods.transfer(
                C.map((ciphertext) => bn128.serialize(ciphertext.left())),
                bn128.serialize(D),
                y.map(bn128.serialize),
                bn128.serialize(u),
                proof.serialize(),
                bn128.serialize(beneficiaryKey)
              ).encodeABI();

              // Try to estimate gas to see if there's an immediate revert
              console.log("Estimating gas for transaction...");
              try {
                const gasEstimate = await web3.eth.estimateGas({
                  from: home,
                  to: zsc.options.address,
                  data: encoded
                });
                console.log(`Gas estimate: ${gasEstimate}`);
              } catch (gasEstimateError) {
                console.error("Gas estimation failed. This indicates the transaction would revert:", gasEstimateError);

                // Try to get more information about the revert reason
                try {
                  // Call the method directly to get revert reason
                  await zsc.methods.transfer(
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
                to: zsc.options.address,
                data: encoded,
                gas: 7721975,
                gasPrice: '0',
                nonce,
                chainId
              };

              // Sign the transaction
              console.log("Signing transaction...");
              const { rawTransaction } = await web3.eth.accounts.signTransaction(tx, privKey);

              console.log("Sending transaction...");
              web3.eth.sendSignedTransaction(rawTransaction)
                .on('transactionHash', (hash) => {
                  transfers.add(hash);
                  console.log(`Transfer submitted (txHash = "${hash}").`);
                })
                .on('receipt', (receipt) => {
                  console.log("Transaction receipt:", receipt);

                  // Check if the transaction was successful
                  if (receipt.status) {
                    console.log("Transfer receipt received successfully");
                    account._state = account._simulate();
                    account._state.nonceUsed = true;
                    account._state.pending -= value + fee;
                    console.log(`Transfer of ${value} (with fee of ${fee}) was successful. Balance now ${account._state.available + account._state.pending}.`);
                    resolve(receipt);
                  } else {
                    console.error("Transaction receipt indicates failure:", receipt);
                    reject(new Error("Transaction failed with receipt status: " + receipt.status));
                  }
                })
                .on('error', (error) => {
                  console.error("Transaction error:", error);

                  // Try to get transaction receipt even after error
                  if (error.transactionHash) {
                    console.log(`Trying to get receipt for failed tx: ${error.transactionHash}`);
                    web3.eth.getTransactionReceipt(error.transactionHash)
                      .then(receipt => {
                        console.log("Failed transaction receipt:", receipt);

                        // Try to get transaction
                        return web3.eth.getTransaction(error.transactionHash);
                      })
                      .then(tx => {
                        console.log("Failed transaction:", tx);
                      })
                      .catch(err => {
                        console.error("Error getting receipt for failed tx:", err);
                      });
                  }

                  reject(new Error(`Transfer failed: ${error.message}`));
                });

            } catch (proofError) {
              console.error("Error during proof generation:", proofError);
              reject(new Error(`Proof generation failed: ${proofError.message}`));
            }
          })
          .catch(err => {
            console.error("Error in transfer process:", err);
            reject(new Error(`Transfer failed: ${err.message}`));
          });
      });
    };

    this.simulateAccounts = async (pubkeys) => {
      const epoch = await getChainEpoch();
      console.log(`Current epoch: ${epoch}`);
      return zsc.methods.simulateAccounts(pubkeys.map(bn128.serialize), epoch).call()
        .then((result) => {
          return result.map((account) => ElGamal.deserialize(account));
        })
        .catch((error) => {
          console.error("Error simulating accounts:", error);
          throw new Error(`Simulation failed: ${error.message}`);
        });
    };

    this.withdraw = (value) => {
      if (this.account.keypair === undefined)
        throw "Client's account is not yet registered!";
      const account = this.account;

      const attempt = () => {
        const state = account._simulate();
        if (value > state.available + state.pending)
          throw `Requested withdrawal amount of ${value} exceeds account balance of ${state.available + state.pending}.`;

        const wait = away();
        const seconds = Math.ceil(wait / 1000);
        const plural = seconds === 1 ? "" : "s";

        if (value > state.available) {
          console.log(`Your withdrawal has been queued. Please wait ${seconds} second${plural}, for the release of your funds...`);
          return sleep(wait).then(attempt);
        }
        if (state.nonceUsed) {
          console.log(`Your withdrawal has been queued. Please wait ${seconds} second${plural}, until the next epoch...`);
          return sleep(wait).then(attempt);
        }
        if (3100 > wait) {
          console.log("Initiating withdrawal.");
          return sleep(wait).then(attempt);
        }

        // Ready to send the actual burn transaction
        return new Promise((resolve, reject) => {
          zsc.methods
            .simulateAccounts([bn128.serialize(account.keypair.y)], getEpoch())
            .call()
            .then(async (result) => {
              try {
                // 1) Build the burn proof
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

                // 2) ABI-encode the call
                const data = zsc.methods
                  .burn(
                    bn128.serialize(account.keypair.y),
                    value,
                    bn128.serialize(u),
                    proof.serialize()
                  )
                  .encodeABI();

                // 3) Fetch nonce & chainId
                const nonce = await web3.eth.getTransactionCount(home, 'pending');
                const chainId = await web3.eth.getChainId();

                // 4) Build tx object
                const tx = {
                  from: home,
                  to: zsc.options.address,
                  data,
                  gas: 6_721_975,
                  gasPrice: '0',
                  nonce,
                  chainId
                };

                // 5) Sign locally
                const { rawTransaction } = await web3.eth.accounts.signTransaction(tx, privKey);

                // 6) Broadcast
                web3.eth
                  .sendSignedTransaction(rawTransaction)
                  .on('transactionHash', (hash) => {
                    console.log(`Withdrawal submitted (txHash = "${hash}").`);
                  })
                  .on('receipt', (receipt) => {
                    account._state = account._simulate();
                    account._state.nonceUsed = true;
                    account._state.pending -= value;
                    console.log(
                      `Withdrawal of ${value} was successful. ` +
                      `Balance now ${account._state.available + account._state.pending}.`
                    );
                    resolve(receipt);
                  })
                  .on('error', (error) => {
                    console.log("Withdrawal failed: " + error);
                    reject(error);
                  });
              } catch (err) {
                reject(err);
              }
            })
            .catch(reject);
        });
      };

      return attempt();
    };

  }
}

module.exports = Client;