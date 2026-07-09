// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";
import {DIDRegistry}      from "./DIDRegistry.sol";

/// @title VendorRegistry
/// @notice Implements Seller Onboarding (WP2 S2.2.1) and the
///         product-to-vendor binding used both by seller/product
///         reputation aggregation (WP2 S2.6) and by the Vendor Reply
///         authorization check (WP2 S2.4, "Vendor Reply Mechanism").
///
/// @dev DID integration: a vendor must have an active DID registered in
///      the DIDRegistry before they can register on this contract. This
///      anchors the vendor's on-chain identity to their W3C DID, enabling
///      future key rotation via the DIDRegistry without losing their
///      accumulated reputation.
///      The CA signature check (ecrecover over the Vendor_VC hash) is
///      kept on-chain because vendor onboarding is a direct operation
///      performed by the vendor themselves — it does not pass through the
///      DApp relayer.
contract VendorRegistry {
    IdentityRegistry public immutable identityRegistry;
    DIDRegistry      public immutable didRegistry;

    struct Vendor {
        bool   active;
        string legalName;
        string vatNumber;
    }

    mapping(address => Vendor)  public vendors;
    mapping(bytes32 => address) public vendorOfProduct;

    event VendorRegistered(address indexed vendorWallet, string legalName, string vatNumber);
    event ProductRegistered(address indexed vendorWallet, bytes32 indexed productIdHash);

    error NotAVendor();
    error InvalidCASignature();
    error WalletMismatch();
    error ProductAlreadyRegistered();
    error VendorDIDNotActive();

    constructor(address identityRegistry_, address didRegistry_) {
        identityRegistry = IdentityRegistry(identityRegistry_);
        didRegistry      = DIDRegistry(didRegistry_);
    }

    modifier onlyVendor() {
        if (!vendors[msg.sender].active) revert NotAVendor();
        _;
    }

    /// @notice On-chain Vendor Registration (WP2 S2.2.1, Step 1.4).
    /// @dev The vendor must already have an active DID in DIDRegistry
    ///      before calling this function. The CA signature is still
    ///      verified on-chain via ecrecover (secp256k1) because vendor
    ///      onboarding is a direct wallet operation, not relayed by the
    ///      DApp backend.
    function registerVendor(
        address vendorWallet,
        string calldata legalName,
        string calldata vatNumber,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // Wallet binding: the transaction sender must match the credential subject.
        if (vendorWallet != msg.sender) revert WalletMismatch();

        // DID check: the vendor must have a registered and active DID.
        if (!didRegistry.isActiveByOwner(vendorWallet)) revert VendorDIDNotActive();

        // Verify the CA's ECDSA signature over the canonical credential hash.
        bytes32 credentialHash = keccak256(abi.encode(vendorWallet, legalName, vatNumber));
        address recoveredCA    = ecrecover(credentialHash, v, r, s);
        if (!identityRegistry.isCA(recoveredCA)) revert InvalidCASignature();

        vendors[vendorWallet] = Vendor({active: true, legalName: legalName, vatNumber: vatNumber});
        emit VendorRegistered(vendorWallet, legalName, vatNumber);
    }

    /// @notice Registers a productID under the caller's vendor catalog.
    function registerProduct(string calldata productID) external onlyVendor {
        bytes32 productIdHash = keccak256(bytes(productID));
        if (vendorOfProduct[productIdHash] != address(0)) revert ProductAlreadyRegistered();
        vendorOfProduct[productIdHash] = msg.sender;
        emit ProductRegistered(msg.sender, productIdHash);
    }

    function isVendor(address account) external view returns (bool) {
        return vendors[account].active;
    }
}
