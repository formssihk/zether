# Zether Smart Contract Developer Guide

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Core Components](#core-components)
4. [Cryptographic Primitives](#cryptographic-primitives)
5. [Contract Deployment](#contract-deployment)
6. [API Reference](#api-reference)
7. [Usage Examples](#usage-examples)
8. [Gas Optimization](#gas-optimization)
9. [Security Considerations](#security-considerations)
10. [Troubleshooting](#troubleshooting)

## Overview

Zether is a privacy-preserving smart contract system that enables confidential transfers on Ethereum-compatible blockchains. It uses zero-knowledge proofs to hide transaction amounts and participants while maintaining cryptographic guarantees.

### Key Features
- **Confidential Transfers**: Hide transaction amounts and participants
- **Account-based Model**: Similar to Ethereum accounts but with privacy
- **Zero-knowledge Proofs**: Sigma protocols and inner product arguments
- **Epoch-based System**: Time-based privacy windows
- **ElGamal Encryption**: For balance commitments

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   ZSC (Main)    │    │ ZetherVerifier  │    │ BurnVerifier    │
│                 │    │                 │    │                 │
│ - Account Mgmt  │◄───┤ - Transfer      │◄───┤ - Burn Proofs   │
│ - Epoch Logic   │    │   Verification  │    │   Verification  │
│ - State Updates │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
                    ┌─────────────────┐
                    │InnerProductVer. │
                    │                 │
                    │ - Inner Product │
                    │   Proofs        │
                    └─────────────────┘
```

## Core Components

### 1. ZSC (Zether Smart Contract)
The main contract that manages accounts, epochs, and state transitions.

**Key Functions:**
- `register()`: Register a new Zether account
- `fund()`: Deposit tokens into a Zether account
- `transfer()`: Perform confidential transfers
- `burn()`: Withdraw tokens from a Zether account

### 2. ZetherVerifier
Handles verification of transfer proofs using Sigma protocols and inner product arguments.

### 3. BurnVerifier
Handles verification of burn (withdrawal) proofs.

### 4. InnerProductVerifier
Implements inner product proof verification using Bulletproofs-style arguments.

### 5. Utils
Cryptographic utility functions for elliptic curve operations on the BN128 curve.

## Cryptographic Primitives

### Elliptic Curve Operations
The system uses the BN128 curve with the following operations:

```solidity
// Point addition
function add(G1Point memory p1, G1Point memory p2) internal view returns (G1Point memory)

// Scalar multiplication
function mul(G1Point memory p, uint256 s) internal view returns (G1Point memory)

// Modular arithmetic
function add(uint256 x, uint256 y) internal pure returns (uint256)
function mul(uint256 x, uint256 y) internal pure returns (uint256)
```

### Zero-Knowledge Proofs
The system uses two types of proofs:

1. **Sigma Protocols**: For proving knowledge of secret keys
2. **Inner Product Proofs**: For proving relationships between committed values

### ElGamal Encryption
Balances are encrypted using ElGamal encryption:

```solidity
// Commitment structure
struct G1Point {
    bytes32 x;
    bytes32 y;
}

// Account state
mapping(bytes32 => Utils.G1Point[2]) acc; // [CLn, CRn]
```

## Contract Deployment

### Prerequisites
- Node.js 16+
- Hardhat
- Ethereum-compatible network with BN128 precompiled contracts

### Installation
```bash
npm install
```

### Deployment Script
```javascript
// Deploy in order:
// 1. CashToken
// 2. InnerProductVerifier
// 3. ZetherVerifier
// 4. BurnVerifier
// 5. ZSC

const deploy = async () => {
  // 1. Deploy CashToken
  const cashToken = await CashToken.deploy();
  
  // 2. Deploy InnerProductVerifier
  const ipVerifier = await InnerProductVerifier.deploy();
  
  // 3. Deploy ZetherVerifier
  const zVerifier = await ZetherVerifier.deploy(ipVerifier.address);
  
  // 4. Deploy BurnVerifier
  const bVerifier = await BurnVerifier.deploy(ipVerifier.address);
  
  // 5. Deploy ZSC
  const zsc = await ZSC.deploy(
    cashToken.address,
    zVerifier.address,
    bVerifier.address,
    90 // epoch length in seconds
  );
};
```

### Network Configuration
```javascript
// hardhat.config.js
module.exports = {
  solidity: {
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
    besuLocal: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
    },
  },
};
```

## API Reference

### ZSC Contract

#### `register(Utils.G1Point y, uint256 c, uint256 s)`
Register a new Zether account.

**Parameters:**
- `y`: Public key (G1Point)
- `c`: Challenge (uint256)
- `s`: Signature (uint256)

**Requirements:**
- Valid Schnorr signature on contract address
- Account not already registered

#### `fund(Utils.G1Point y, uint256 bTransfer)`
Deposit tokens into a Zether account.

**Parameters:**
- `y`: Account public key
- `bTransfer`: Amount to deposit (≤ MAX = 2^32-1)

**Requirements:**
- Account must be registered
- Sufficient token balance
- Amount within valid range

#### `transfer(Utils.G1Point[] C, Utils.G1Point D, Utils.G1Point[] y, Utils.G1Point u, bytes proof, Utils.G1Point beneficiary)`
Perform a confidential transfer.

**Parameters:**
- `C`: Commitment array
- `D`: Delta commitment
- `y`: Participant public keys
- `u`: Nonce
- `proof`: Zero-knowledge proof
- `beneficiary`: Fee recipient

**Requirements:**
- All participants registered
- Valid zero-knowledge proof
- Unique nonce

#### `burn(Utils.G1Point y, uint256 bTransfer, Utils.G1Point u, bytes proof)`
Withdraw tokens from a Zether account.

**Parameters:**
- `y`: Account public key
- `bTransfer`: Amount to withdraw
- `u`: Nonce
- `proof`: Burn proof

**Requirements:**
- Account registered
- Valid burn proof
- Unique nonce

### Utils Library

#### Elliptic Curve Operations
```solidity
// Point addition
function add(G1Point memory p1, G1Point memory p2) internal view returns (G1Point memory)

// Scalar multiplication
function mul(G1Point memory p, uint256 s) internal view returns (G1Point memory)

// Point negation
function neg(G1Point memory p) internal pure returns (G1Point memory)
```

#### Modular Arithmetic
```solidity
// Modular addition
function add(uint256 x, uint256 y) internal pure returns (uint256)

// Modular multiplication
function mul(uint256 x, uint256 y) internal pure returns (uint256)

// Modular inverse
function inv(uint256 x) internal view returns (uint256)
```

## Usage Examples

### Basic Account Registration
```javascript
const { ethers } = require("ethers");

// Generate key pair
const privateKey = ethers.utils.randomBytes(32);
const publicKey = generatePublicKey(privateKey);

// Create Schnorr signature
const signature = createSchnorrSignature(privateKey, contractAddress);

// Register account
await zsc.register(publicKey, signature.c, signature.s);
```

### Deposit Tokens
```javascript
// Approve token transfer
await cashToken.approve(zsc.address, depositAmount);

// Deposit into Zether account
await zsc.fund(publicKey, depositAmount);
```

### Confidential Transfer
```javascript
// Generate transfer proof
const proof = generateTransferProof({
  participants: [sender, receiver],
  amounts: [100, 200],
  nonce: generateNonce()
});

// Execute transfer
await zsc.transfer(
  proof.C,
  proof.D,
  proof.participants,
  proof.nonce,
  proof.proof,
  feeRecipient
);
```

### Withdraw Tokens
```javascript
// Generate burn proof
const burnProof = generateBurnProof({
  account: publicKey,
  amount: withdrawAmount,
  nonce: generateNonce()
});

// Execute burn
await zsc.burn(
  publicKey,
  withdrawAmount,
  burnProof.nonce,
  burnProof.proof
);
```

## Gas Optimization

### Current Gas Consumption
- **Registration**: ~200,000 gas
- **Deposit**: ~100,000 gas
- **Transfer**: ~3,000,000 gas
- **Burn**: ~2,000,000 gas

### Optimization Strategies

#### 1. Batch Operations
```solidity
// Batch multiple operations in single transaction
function batchTransfer(TransferData[] memory transfers) public {
  for (uint i = 0; i < transfers.length; i++) {
    // Process transfer
  }
}
```

#### 2. Optimize Proof Generation
```javascript
// Use smaller anonymity sets for lower gas
const anonymitySet = selectOptimalDecoys(participants, 8); // vs 32
```

#### 3. Gas Estimation
```javascript
// Always estimate gas before transactions
const gasEstimate = await zsc.estimateGas.transfer(...);
const tx = await zsc.transfer(..., { gasLimit: gasEstimate.mul(120).div(100) });
```

## Security Considerations

### 1. Key Management
- **Never reuse private keys**
- **Use secure random number generation**
- **Implement proper key derivation**

### 2. Proof Generation
- **Use cryptographically secure randomness**
- **Validate all inputs before proof generation**
- **Implement proper nonce management**

### 3. Anonymity Set Collisions
- **Monitor transaction pool for conflicts**
- **Use smaller anonymity sets in busy networks**
- **Implement collision detection**

### 4. Epoch Management
- **Ensure epoch length is sufficient for operations**
- **Handle epoch transitions gracefully**
- **Implement proper rollover logic**

## Troubleshooting

### Common Issues

#### 1. High Gas Consumption
**Problem**: Transactions consume 8M+ gas and fail
**Solution**: 
- Check precompiled contract availability
- Verify BN128 curve configuration
- Optimize proof parameters

#### 2. Proof Verification Failures
**Problem**: "Transfer proof verification failed"
**Solution**:
- Verify anonymity set consistency
- Check nonce uniqueness
- Validate proof generation parameters

#### 3. Account Registration Failures
**Problem**: "Invalid registration signature"
**Solution**:
- Verify Schnorr signature generation
- Check public key format
- Ensure proper challenge computation

#### 4. Anonymity Set Collisions
**Problem**: "Nonce already seen"
**Solution**:
- Implement collision detection
- Use smaller anonymity sets
- Monitor transaction pool

### Debugging Tools

#### 1. Gas Estimation
```javascript
const gasEstimate = await contract.estimateGas.functionName(...);
console.log(`Estimated gas: ${gasEstimate.toString()}`);
```

#### 2. Event Monitoring
```javascript
// Monitor TransferOccurred events
contract.on("TransferOccurred", (parties, beneficiary) => {
  console.log("Transfer completed:", parties, beneficiary);
});
```

#### 3. State Inspection
```javascript
// Check account state
const accountState = await zsc.simulateAccounts([publicKey], currentEpoch);
console.log("Account state:", accountState);
```

### Network-Specific Issues

#### Azure Hyperledger Besu
- Ensure precompiled contracts are enabled
- Verify BN128 curve configuration
- Check gas limit settings

#### Local Development
- Use Hardhat's built-in network
- Enable gas reporting
- Monitor transaction logs

___


### Testing
```bash
# Run all tests
npm test

# Run specific test file
npm test test/enhancedFlow.test.mjs

# Run with gas reporting
REPORT_GAS=true npm test
```

---

