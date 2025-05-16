// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts@v3.4.2/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts@v3.4.2/access/Ownable.sol";
import "./Utils.sol";
import "./ZetherVerifier.sol";
import "./BurnVerifier.sol";
import "./InnerProductVerifier.sol"; // Included for clarity

contract ZTK is ERC20, Ownable {
    using Utils for uint256;
    using Utils for Utils.G1Point;

    // Zether configuration
    uint256 public constant MAX = 4294967295; // 2^32 - 1, max amount for shielded transactions
    uint256 public epochLength;
    uint256 public fee;
    ZetherVerifier public zetherVerifier;
    BurnVerifier public burnVerifier;

    // Shielded account storage
    mapping(bytes32 => Utils.G1Point[2]) acc; // Main account: [CLn, CRn] (ElGamal commitments)
    mapping(bytes32 => Utils.G1Point[2]) pending; // Pending transfers
    mapping(bytes32 => uint256) lastRollOver; // Last epoch rolled over
    bytes32[] nonceSet; // Nonce tracking for replay protection
    uint256 public lastGlobalUpdate; // Current epoch proxy

    // Events
    event Registered(address indexed account, bytes32 indexed publicKey);
    event Deposited(address indexed account, uint256 amount, bytes32 indexed publicKey);
    event ShieldedTransfer(Utils.G1Point[] parties, Utils.G1Point beneficiary);
    event Burned(address indexed account, uint256 amount, bytes32 indexed publicKey);

    constructor(
        address _zetherVerifier,
        address _burnVerifier,
        uint256 _epochLength
    ) ERC20("Zether Token", "ZTK") Ownable() {
        require(_zetherVerifier != address(0), "ZTK: invalid ZetherVerifier address");
        require(_burnVerifier != address(0), "ZTK: invalid BurnVerifier address");
        _setupDecimals(2); // Set decimals to 2 for MAX limit compatibility
        zetherVerifier = ZetherVerifier(_zetherVerifier);
        burnVerifier = BurnVerifier(_burnVerifier);
        epochLength = _epochLength;
        fee = zetherVerifier.fee();
        lastGlobalUpdate = 0;
        Utils.G1Point memory empty;
        pending[keccak256(abi.encode(empty))][1] = Utils.g(); // Initialize empty account
    }

    // Override decimals to ensure consistency
    function decimals() public view override returns (uint8) {
        return 2;
    }

    // Mint function for testing (restricted to owner)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // Simulate accounts for a given epoch (from ZSC.sol)
    function simulateAccounts(Utils.G1Point[] memory y, uint256 epoch) public view returns (Utils.G1Point[2][] memory accounts) {
        uint256 size = y.length;
        accounts = new Utils.G1Point[2][](size);
        for (uint256 i = 0; i < size; i++) {
            bytes32 yHash = keccak256(abi.encode(y[i]));
            accounts[i] = acc[yHash];
            if (lastRollOver[yHash] < epoch) {
                Utils.G1Point[2] memory scratch = pending[yHash];
                accounts[i][0] = accounts[i][0].add(scratch[0]);
                accounts[i][1] = accounts[i][1].add(scratch[1]);
            }
        }
    }

    // Register a Zether account with Schnorr signature
    function registerAccount(Utils.G1Point memory y, uint256 c, uint256 s) external {
        bytes32 yHash = keccak256(abi.encode(y));
        require(!registered(yHash), "ZTK: account already registered");

        // Verify Schnorr signature
        Utils.G1Point memory K = Utils.g().mul(s).add(y.mul(c.neg()));
        uint256 challenge = uint256(keccak256(abi.encode(address(this), y, K))).mod();
        require(challenge == c, "ZTK: invalid registration signature");

        // Initialize pending account
        pending[yHash][0] = y;
        pending[yHash][1] = Utils.g();
        emit Registered(msg.sender, yHash);
    }

    // Deposit tokens into shielded pool (transparent to shielded)
    function depositForPrivateTx(uint256 amount, Utils.G1Point memory y, bool shouldMint) external {
        bytes32 yHash = keccak256(abi.encode(y));
        require(registered(yHash), "ZTK: account not registered");
        require(amount <= MAX, "ZTK: amount exceeds MAX limit");

        rollOver(yHash);

        if (shouldMint) {
            require(msg.sender == owner(), "ZTK: only owner can mint");
            _mint(msg.sender, amount);
        } else {
            require(balanceOf(msg.sender) >= amount, "ZTK: insufficient balance");
            _burn(msg.sender, amount);
        }

        // Update shielded balance
        Utils.G1Point memory scratch = pending[yHash][0];
        scratch = scratch.add(Utils.g().mul(amount));
        pending[yHash][0] = scratch;

        emit Deposited(msg.sender, amount, yHash);
    }

    // Shielded transfer (Zether-style)
    function shieldedTransfer(
        Utils.G1Point[] memory C,
        Utils.G1Point memory D,
        Utils.G1Point[] memory y,
        Utils.G1Point memory u,
        bytes memory proof,
        Utils.G1Point memory beneficiary
    ) external {
        uint256 size = y.length;
        Utils.G1Point[] memory CLn = new Utils.G1Point[](size);
        Utils.G1Point[] memory CRn = new Utils.G1Point[](size);
        require(C.length == size, "ZTK: input array length mismatch");

        // Handle beneficiary (fee recipient)
        bytes32 beneficiaryHash = keccak256(abi.encode(beneficiary));
        require(registered(beneficiaryHash), "ZTK: beneficiary not registered");
        rollOver(beneficiaryHash);
        pending[beneficiaryHash][0] = pending[beneficiaryHash][0].add(Utils.g().mul(fee));

        // Process parties
        for (uint256 i = 0; i < size; i++) {
            bytes32 yHash = keccak256(abi.encode(y[i]));
            require(registered(yHash), "ZTK: account not registered");
            rollOver(yHash);
            Utils.G1Point[2] memory scratch = pending[yHash];
            pending[yHash][0] = scratch[0].add(C[i]);
            pending[yHash][1] = scratch[1].add(D);

            scratch = acc[yHash];
            CLn[i] = scratch[0].add(C[i]);
            CRn[i] = scratch[1].add(D);
        }

        // Verify nonce
        bytes32 uHash = keccak256(abi.encode(u));
        for (uint256 i = 0; i < nonceSet.length; i++) {
            require(nonceSet[i] != uHash, "ZTK: nonce already seen");
        }
        nonceSet.push(uHash);

        // Verify Zether proof
        require(
            zetherVerifier.verifyTransfer(CLn, CRn, C, D, y, lastGlobalUpdate, u, proof),
            "ZTK: transfer proof verification failed"
        );

        emit ShieldedTransfer(y, beneficiary);
    }

    // Burn tokens from shielded pool (shielded to transparent)
    function burn(Utils.G1Point memory y, uint256 bTransfer, Utils.G1Point memory u, bytes memory proof) external {
        bytes32 yHash = keccak256(abi.encode(y));
        require(registered(yHash), "ZTK: account not registered");
        require(bTransfer <= MAX, "ZTK: burn amount exceeds MAX limit");

        rollOver(yHash);

        // Update pending balance
        Utils.G1Point[2] memory scratch = pending[yHash];
        pending[yHash][0] = scratch[0].add(Utils.g().mul(bTransfer.neg()));

        // Simulate debit for verification
        scratch = acc[yHash];
        scratch[0] = scratch[0].add(Utils.g().mul(bTransfer.neg()));

        // Verify nonce
        bytes32 uHash = keccak256(abi.encode(u));
        for (uint256 i = 0; i < nonceSet.length; i++) {
            require(nonceSet[i] != uHash, "ZTK: nonce already seen");
        }
        nonceSet.push(uHash);

        // Verify burn proof
        require(
            burnVerifier.verifyBurn(scratch[0], scratch[1], y, lastGlobalUpdate, u, msg.sender, proof),
            "ZTK: burn proof verification failed"
        );

        // Transfer tokens to sender
        _mint(msg.sender, bTransfer);

        emit Burned(msg.sender, bTransfer, yHash);
    }

    // Internal: Roll over pending balances to main account
    function rollOver(bytes32 yHash) internal {
        uint256 e = block.timestamp / epochLength;
        if (lastRollOver[yHash] < e) {
            Utils.G1Point[2][2] memory scratch = [acc[yHash], pending[yHash]];
            acc[yHash][0] = scratch[0][0].add(scratch[1][0]);
            acc[yHash][1] = scratch[0][1].add(scratch[1][1]);
            delete pending[yHash];
            lastRollOver[yHash] = e;
        }
        if (lastGlobalUpdate < e) {
            lastGlobalUpdate = e;
            delete nonceSet;
        }
    }

    // Internal: Check if account is registered
    function registered(bytes32 yHash) internal view returns (bool) {
        Utils.G1Point memory zero = Utils.G1Point(0, 0);
        Utils.G1Point[2][2] memory scratch = [acc[yHash], pending[yHash]];
        return !(scratch[0][0].eq(zero) && scratch[0][1].eq(zero) && scratch[1][0].eq(zero) && scratch[1][1].eq(zero));
    }
}