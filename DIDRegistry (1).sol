// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DIDRegistrySolution {
    struct DIDDocument {
        address owner;
        string  publicKey;
        string  serviceEndpoint;
        uint256 createdAt;
        uint256 updatedAt;
        bool    active;
    }

    mapping(address => DIDDocument) private _documents;
    mapping(address => bool)        private _registered;
    mapping(string => address) private _didToOwner;

    event DIDRegistered(address indexed owner, string did, string publicKey, uint256 timestamp);
    event DIDUpdated(address indexed owner, string publicKey, uint256 timestamp);
    event DIDRevoked(address indexed owner, uint256 timestamp);

    error AlreadyRegistered(address owner);
    error NotRegistered(address owner);
    error NotOwner(address caller, address owner);
    error DIDInactive(address owner);
    error DIDAlreadyTaken(string did);
    error InvalidDID();


    function registerDID(
        string calldata did,
        string calldata publicKey,
        string calldata serviceEndpoint
    ) external {
        if (_registered[msg.sender]) revert AlreadyRegistered(msg.sender);
        if (bytes(did).length == 0) revert InvalidDID();
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

    function resolveDID(string calldata did) external view returns (DIDDocument memory) {
        address owner = _didToOwner[did];

        if (owner == address(0)) revert NotRegistered(owner);

        return _documents[owner];
    }

    function updateDID(
        string calldata newPublicKey,
        string calldata newServiceEndpoint
    ) external {
        if (!_registered[msg.sender]) revert NotRegistered(msg.sender);
        if (!_documents[msg.sender].active) revert DIDInactive(msg.sender);

        if (bytes(newPublicKey).length > 0)
            _documents[msg.sender].publicKey = newPublicKey;

        if (bytes(newServiceEndpoint).length > 0)
            _documents[msg.sender].serviceEndpoint = newServiceEndpoint;

        _documents[msg.sender].updatedAt = block.timestamp;

        emit DIDUpdated(msg.sender, _documents[msg.sender].publicKey, block.timestamp);
    }

    function revokeDID() external {
        if (!_registered[msg.sender]) revert NotRegistered(msg.sender);
        if (!_documents[msg.sender].active) revert DIDInactive(msg.sender);

        _documents[msg.sender].active = false;

        emit DIDRevoked(msg.sender, block.timestamp);
    }

    function isActive(string calldata did) external view returns (bool) {
        address owner = _didToOwner[did];
        return _registered[owner] && _documents[owner].active;
    }

}