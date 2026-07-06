// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IdentityRegistry
/// @notice Anchors the public keys of the two off-chain trust roots that
///         WP2 requires the smart contract layer to check against:
///         Certification Authorities, who vet and vouch for vendors
///         (WP2 S2.2.1, "Vendor Onboarding"), and E-commerce platforms,
///         who issue the Proof of Purchase (WP2 S2.3, Check 1 "Issuer
///         Authentication"). Both trust roots are defined at the
///         WP1 S1.3 "System entities" level (Certification Authorities,
///         E-Commerce platform).
///
/// @dev DESIGN NOTE (deviation from the WP2 draft, documented explicitly
///      rather than left implicit): the Vendor_VC example in WP2 S2.2.1
///      uses "alg": "ES256" (ECDSA on P-256 / secp256r1). Solidity's
///      `ecrecover` precompile only supports secp256k1, and the P-256
///      precompile (RIP-7212) is not guaranteed available on every
///      EVM-compatible chain. To keep on-chain verification uniform,
///      cheap, and portable, this implementation requires CAs to sign
///      with ES256K (secp256k1) -- exactly like the PoP issuer already
///      does in WP2 S2.3. VendorRegistry and ReviewContract both rely on
///      this registry's `isCA` / `isIssuer` mappings together with
///      `ecrecover`.
contract IdentityRegistry {
    address public owner;

    /// @notice Trusted Certification Authorities (WP1 S1.3; WP2 S2.2.1).
    mapping(address => bool) public isCA;

    /// @notice E-commerce platforms authorized to issue a Proof of
    ///         Purchase (WP1 S1.3; WP2 S2.3, Check 1).
    mapping(address => bool) public isIssuer;

    event CARegistered(address indexed caWallet);
    event CARevoked(address indexed caWallet);
    event IssuerRegistered(address indexed issuerWallet);
    event IssuerRevoked(address indexed issuerWallet);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param genesisCA      Optional CA to pre-register at deployment
    ///                       time (pass address(0) to skip). Convenient
    ///                       for a demo/testnet deployment with a single
    ///                       known CA, without needing a second
    ///                       post-deploy admin transaction.
    /// @param genesisIssuer  Optional E-commerce platform to pre-register
    ///                       at deployment time (pass address(0) to
    ///                       skip), for the same reason. Additional CAs
    ///                       or issuers can still be admitted later via
    ///                       `registerCA` / `registerIssuer` -- e.g. when
    ///                       a second e-commerce platform joins the
    ///                       ecosystem, per WP2 S2.7.
    constructor(address genesisCA, address genesisIssuer) {
        owner = msg.sender;

        if (genesisCA != address(0)) {
            isCA[genesisCA] = true;
            emit CARegistered(genesisCA);
        }
        if (genesisIssuer != address(0)) {
            isIssuer[genesisIssuer] = true;
            emit IssuerRegistered(genesisIssuer);
        }
    }

    /// @notice Registers a trusted Certification Authority. VendorRegistry
    ///         checks this mapping when validating the CA signature over a
    ///         Vendor_VC (WP2 S2.2.1, Step 1.4).
    /// @dev `onlyOwner` stands in for a proper governance process; WP2
    ///      does not specify one for CA admission (only for new
    ///      E-commerce platforms, via S2.7's DAO vote below), so a simple
    ///      admin-gated whitelist is the natural default here.
    function registerCA(address caWallet) external onlyOwner {
        if (caWallet == address(0)) revert ZeroAddress();
        isCA[caWallet] = true;
        emit CARegistered(caWallet);
    }

    function revokeCA(address caWallet) external onlyOwner {
        isCA[caWallet] = false;
        emit CARevoked(caWallet);
    }


//we still leave the possibility to register more than one Ecommerce 
//platform for future interoperability between different e-commerce platforms


    /// @notice Registers an E-commerce platform authorized to issue PoPs.
    ///         ReviewContract checks this mapping in Check 1 ("Issuer
    ///         Authentication") of every review submission and vote.
    /// @dev WP2 S2.7 ("Cross-Platform Interoperability") envisions new
    ///      platforms joining "through a formalized, decentralized
    ///      governance vote (e.g., via a DAO)". `onlyOwner` here is a
    ///      deliberately simple placeholder for that governance module,
    ///      which is out of scope for WP1-WP3.
    function registerIssuer(address issuerWallet) external onlyOwner {
        if (issuerWallet == address(0)) revert ZeroAddress();
        isIssuer[issuerWallet] = true;
        emit IssuerRegistered(issuerWallet);
    }

    function revokeIssuer(address issuerWallet) external onlyOwner {
        isIssuer[issuerWallet] = false;
        emit IssuerRevoked(issuerWallet);
    }
}
