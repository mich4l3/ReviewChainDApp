// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title DIDRegistry
/// @notice On-chain registry that associates a W3C Decentralized Identifier
///         (DID) string with an Ethereum address and a DID Document.
///         Actors in the TechRate protocol (reviewers, voters, vendors) must
///         register and maintain an active DID before the ReviewContract or
///         VendorRegistry will accept their participation.
///
/// @dev Based on the course exercise solution (DIDRegistrySolution).
///      One addition over the original: `isActiveByOwner(address)` allows
///      other contracts to check DID liveness by raw address, avoiding the
///      expensive on-chain `string` construction that `isActive(string)`
///      would require (e.g. concatenating "did:ethr:" + toHexString(addr)).
contract DIDRegistry {

    struct DIDDocument {
        address owner;           // Ethereum address that controls this DID
        string  publicKey;       // Serialised public key (e.g. base58 or PEM)
        string  serviceEndpoint; // URL where the DID subject can be reached
        uint256 createdAt;       // block.timestamp at registration
        uint256 updatedAt;       // block.timestamp of last update
        bool    active;          // false when DID has been deactivated
    }

    mapping(address => DIDDocument) private _documents;
    mapping(address => bool)        private _registered;
    mapping(string  => address)     private _didToOwner;

    event DIDRegistered(address indexed owner, string did, string publicKey, uint256 timestamp);
    event DIDUpdated   (address indexed owner, string publicKey, uint256 timestamp);
    event DIDRevoked   (address indexed owner, uint256 timestamp);

    error AlreadyRegistered(address owner);
    error NotRegistered(address owner);
    error NotOwner(address caller, address owner);
    error DIDInactive(address owner);
    error DIDAlreadyTaken(string did);
    error InvalidDID();
    error NotIssuer();

    IdentityRegistry public immutable identityRegistry;

    constructor(address identityRegistry_) {
        identityRegistry = IdentityRegistry(identityRegistry_);
    }

    // ------------------------------------------------------------------
    // Registration
    // ------------------------------------------------------------------

    /// @notice Registers a new DID for `msg.sender`.
    /// @param did             The full DID string, e.g. "did:ethr:0xABCD…".
    /// @param publicKey       Serialised public key of the DID subject.
    /// @param serviceEndpoint Optional URL (pass "" to omit).
    function registerDID(
        string calldata did,
        string calldata publicKey,
        string calldata serviceEndpoint
    ) external {
        if (_registered[msg.sender])        revert AlreadyRegistered(msg.sender);
        if (bytes(did).length == 0)         revert InvalidDID();
        if (_didToOwner[did] != address(0)) revert DIDAlreadyTaken(did);

        _documents[msg.sender] = DIDDocument({
            owner:           msg.sender,
            publicKey:       publicKey,
            serviceEndpoint: serviceEndpoint,
            createdAt:       block.timestamp,
            updatedAt:       block.timestamp,
            active:          true
        });
        _registered[msg.sender] = true;
        _didToOwner[did] = msg.sender;

        emit DIDRegistered(msg.sender, did, publicKey, block.timestamp);
    }

    /// @notice Registers a new DID for a specific owner, callable only by an Issuer
    /// @param owner           The Ethereum address that will own this DID
    /// @param did             The full DID string, e.g. "did:ethr:0xABCD…".
    /// @param publicKey       Serialised public key of the DID subject.
    /// @param serviceEndpoint Optional URL (pass "" to omit).
    function issuerRegisterDID(
        address owner,
        string calldata did,
        string calldata publicKey,
        string calldata serviceEndpoint
    ) external {
        if (!identityRegistry.isIssuer(msg.sender)) revert NotIssuer();
        if (_registered[owner])             revert AlreadyRegistered(owner);
        if (bytes(did).length == 0)         revert InvalidDID();
        if (_didToOwner[did] != address(0)) revert DIDAlreadyTaken(did);

        _documents[owner] = DIDDocument({
            owner:           owner,
            publicKey:       publicKey,
            serviceEndpoint: serviceEndpoint,
            createdAt:       block.timestamp,
            updatedAt:       block.timestamp,
            active:          true
        });

        _registered[owner] = true;
        _didToOwner[did]   = owner;

        emit DIDRegistered(owner, did, publicKey, block.timestamp);
    }

    // ------------------------------------------------------------------
    // Resolution
    // ------------------------------------------------------------------

    /// @notice Resolves a DID string to its DID Document.
    function resolveDID(string calldata did) external view returns (DIDDocument memory) {
        address owner = _didToOwner[did];
        if (owner == address(0)) revert NotRegistered(owner);
        return _documents[owner];
    }

    // ------------------------------------------------------------------
    // Update / Revocation
    // ------------------------------------------------------------------

    /// @notice Updates the public key and/or service endpoint of the
    ///         caller's DID Document. Only non-empty strings are applied.
    function updateDID(
        string calldata newPublicKey,
        string calldata newServiceEndpoint
    ) external {
        if (!_registered[msg.sender])       revert NotRegistered(msg.sender);
        if (!_documents[msg.sender].active) revert DIDInactive(msg.sender);

        if (bytes(newPublicKey).length > 0)
            _documents[msg.sender].publicKey = newPublicKey;

        if (bytes(newServiceEndpoint).length > 0)
            _documents[msg.sender].serviceEndpoint = newServiceEndpoint;

        _documents[msg.sender].updatedAt = block.timestamp;

        emit DIDUpdated(msg.sender, _documents[msg.sender].publicKey, block.timestamp);
    }

    /// @notice Permanently deactivates the caller's DID.
    ///         After revocation the address can no longer submit reviews
    ///         or votes (ReviewContract checks `isActiveByOwner`).
    function revokeDID() external {
        if (!_registered[msg.sender])       revert NotRegistered(msg.sender);
        if (!_documents[msg.sender].active) revert DIDInactive(msg.sender);

        _documents[msg.sender].active = false;

        emit DIDRevoked(msg.sender, block.timestamp);
    }

    // ------------------------------------------------------------------
    // View helpers
    // ------------------------------------------------------------------

    /// @notice Returns true if the DID string is registered and active.
    function isActive(string calldata did) external view returns (bool) {
        address owner = _didToOwner[did];
        return _registered[owner] && _documents[owner].active;
    }

    /// @notice Returns true if `owner` has a registered, active DID.
    /// @dev    Cheaper than `isActive(string)` for on-chain callers because
    ///         it avoids building the "did:ethr:0x…" string inside the EVM.
    ///         Used by ReviewContract and VendorRegistry.
    function isActiveByOwner(address owner) external view returns (bool) {
        return _registered[owner] && _documents[owner].active;
    }

    /// @notice Returns the full DID Document of `owner` (for off-chain use).
    function documentOf(address owner) external view returns (DIDDocument memory) {
        if (!_registered[owner]) revert NotRegistered(owner);
        return _documents[owner];
    }
}
