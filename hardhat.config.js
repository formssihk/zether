// require("@nomicfoundation/hardhat-toolbox");
// const ZetherModule = require("./ignition/modules/ZetherModule")

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: 
  {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      {
        version: "0.7.0"
      }
    ],
  },
  networks: {
    hardhat: {
      chainId: 1337,           // your local chain-id
    },
    besuLocal: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
      // force Hardhat’s EIP-1193 client to use “latest” for nonce lookups:
      defaultBlock: "latest",
    },
    // ignition: {
    //   modules: [ ZetherModule ],
    // },
  },
};
