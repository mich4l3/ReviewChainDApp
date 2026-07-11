// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DIDRegistry {

    struct DIDDocument {
        address owner;          // Ethereum address that controls this DID
        string  publicKey;      // Serialised public key (e.g. base58 or PEM)
        string  serviceEndpoint;// URL where the DID subject can be reached
        uint256 createdAt;      // block.timestamp at registration
        uint256 updatedAt;      // block.timestamp of last update
        bool    active;         // false when DID has been deactivated
    }

    mapping(address => DIDDocument) private _documents;
    mapping(string => address) private _didToOwner;
    mapping(address => bool) private _registered;

    event DIDRegistered(address indexed owner, string publicKey, uint256 timestamp);
    event DIDUpdated   (address indexed owner, string publicKey, uint256 timestamp);
    event DIDRevoked   (address indexed owner, uint256 timestamp);

    error AlreadyRegistered(address owner);
    error NotRegistered(address owner);
    error NotOwner(address caller, address owner);
    error DIDInactive(address owner);

    /**
     *   1. Revert with AlreadyRegistered if msg.sender is already registered.
     *   2. Create and store a new DIDDocument for msg.sender.
     *   3. Emit DIDRegistered.
     */
    function registerDID(
        string calldata did,
        string calldata publicKey,
        string calldata serviceEndpoint
    ) external {
        // --- your code here ---
    }

    /**
     *   1. Revert with NotRegistered if owner has no DID.
     *   2. Return the stored DIDDocument.
     */
    function resolveDID(string calldata did) external view returns (DIDDocument memory) {
        // --- your code here ---
    }

    /**
     *   1. Revert with NotRegistered / DIDInactive appropriately.
     *   2. Only update fields that are non-empty.
     *   3. Refresh updatedAt.
     *   4. Emit DIDUpdated.
     */
    function updateDID(
        string calldata newPublicKey,
        string calldata newServiceEndpoint
    ) external {
        // --- your code here ---
    }

    /**
     *   1. Validate registration and ownership.
     *   2. Set active = false.
     *   3. Emit DIDRevoked.
     */
    function revokeDID() external {
        // --- your code here ---
    }

    /// Returns true if the DID is active
    function isActive(string calldata did) external view returns (bool) {
        // --- your code here ---
    }
}
