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

    struct Vendor {
        bool   active;
        string legalName;
        string vatNumber;
    }

    // vendorWallet => VendorProfile
    mapping(address => Vendor)  public vendors;

    event VendorRegistered(address indexed vendorWallet, string legalName, string vatNumber);

    error NotAVendor();
    error InvalidCASignature();
    error WalletMismatch();
    error NotIssuer();

    constructor(address identityRegistry_) {
        identityRegistry = IdentityRegistry(identityRegistry_);
    }

    modifier onlyVendor() {
        if (!vendors[msg.sender].active) revert NotAVendor();
        _;
    }

    /// @notice On-chain Vendor Registration (WP2 S2.2.1).
    /// @dev Registration is performed directly by the E-Commerce (Issuer)
    ///      on behalf of the vendor, after the vendor has been vetted off-chain.
    function issuerRegisterVendor(
        address vendorWallet,
        string calldata legalName,
        string calldata vatNumber
    ) external {
        // Only an authorized Issuer (e-commerce) can register a vendor
        if (!identityRegistry.isIssuer(msg.sender)) revert NotIssuer();

        vendors[vendorWallet] = Vendor({active: true, legalName: legalName, vatNumber: vatNumber});
        emit VendorRegistered(vendorWallet, legalName, vatNumber);
    }

    function isVendor(address account) external view returns (bool) {
        return vendors[account].active;
    }
}
