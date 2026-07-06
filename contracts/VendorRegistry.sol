// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title VendorRegistry
/// @notice Implements Seller Onboarding (WP2 S2.2.1) and the
///         product-to-vendor binding used both by seller/product
///         reputation aggregation (WP2 S2.6) and by the Vendor Reply
///         authorization check (WP2 S2.4, "Vendor Reply Mechanism").
contract VendorRegistry {
    IdentityRegistry public immutable identityRegistry;

    struct Vendor {
        bool active;
        string legalName;
        string vatNumber;
    }

    mapping(address => Vendor) public vendors;

    /// productIdHash = keccak256(bytes(productID)) -> owning vendor.
    // bytes32 intendiamo l'hash del productID
    mapping(bytes32 => address) public vendorOfProduct;

    event VendorRegistered(address indexed vendorWallet, string legalName, string vatNumber);
    event ProductRegistered(address indexed vendorWallet, bytes32 indexed productIdHash);

    error NotAVendor();
    error InvalidCASignature();
    error WalletMismatch();
    error ProductAlreadyRegistered();

    constructor(address identityRegistry_) {
        identityRegistry = IdentityRegistry(identityRegistry_);
    }

    modifier onlyVendor() {
        if (!vendors[msg.sender].active) revert NotAVendor();
        _;
    }

    /// @notice On-chain Vendor Registration (WP2 S2.2.1, Step 1.4).
    /// @dev Rather than parsing the full Vendor_VC JSON on-chain (gas
    ///      prohibitive, as WP2 itself notes for the PoP), the caller
    ///      supplies the already-parsed credential fields plus the CA's
    ///      (v, r, s) ECDSA signature over their canonical hash. See
    ///      ReviewContract._verifyPresentation for the same pattern
    ///      applied to the Proof of Purchase.
    function registerVendor(
        address vendorWallet,
        string calldata legalName,
        string calldata vatNumber,
        uint8 v,    //recovery identifier (dato che restituisce due chiavi pubbliche dato che la curva è simmetrica, dice quale scegliere)
        bytes32 r,  //r ed s sono i valori della firma
        bytes32 s
    ) external {
        // Step 1.4: "ensures the vendorWallet bound within the credential
        // strictly matches the address transmitting the transaction".
        if (vendorWallet != msg.sender) revert WalletMismatch();

        bytes32 credentialHash = keccak256(abi.encode(vendorWallet, legalName, vatNumber));
        address recoveredCA = ecrecover(credentialHash, v, r, s);
        if (!identityRegistry.isCA(recoveredCA)) revert InvalidCASignature();

        vendors[vendorWallet] = Vendor({active: true, legalName: legalName, vatNumber: vatNumber});
        emit VendorRegistered(vendorWallet, legalName, vatNumber);
    }

    /// @notice Registers a productID under the caller's vendor catalog.
    ///         Required for ReviewContract to (a) attribute a review's
    ///         contribution to the correct seller reputation aggregate,
    ///         and (b) authorize that vendor's replies to reviews of that
    ///         product (WP2 S2.4, "Authorization" check).
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
