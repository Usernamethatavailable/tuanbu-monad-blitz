// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Registers the digest of a public TuAnBu receipt submitted by the application.
contract ReceiptRegistry {
    error InvalidPublisher();
    error UnauthorizedPublisher();

    address public immutable publisher;
    event Anchored(bytes32 indexed digest);

    constructor(address publisher_) {
        if (publisher_ == address(0)) revert InvalidPublisher();
        publisher = publisher_;
    }

    function anchor(bytes32 digest) external {
        if (msg.sender != publisher) revert UnauthorizedPublisher();
        emit Anchored(digest);
    }
}
