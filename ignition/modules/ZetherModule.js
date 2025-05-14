const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

const ZetherModule = buildModule("ZetherModule", (m) => {
  const cashToken = m.contract("CashToken");

  const innerProductVerifier = m.contract("InnerProductVerifier", [], {
    gas: 6721975,
  });

  const zetherVerifier = m.contract(
    "ZetherVerifier",
    [innerProductVerifier],
    { gas: 6721975 }
  );

  const burnVerifier = m.contract(
    "BurnVerifier",
    [innerProductVerifier],
    { gas: 6721975 }
  );

  const zsc = m.contract("ZSC", [
    cashToken,
    zetherVerifier,
    burnVerifier,
    6,
  ]);

  return { cashToken, zetherVerifier, burnVerifier, innerProductVerifier, zsc };
});

module.exports = ZetherModule;