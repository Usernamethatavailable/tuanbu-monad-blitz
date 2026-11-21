// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiptRegistry} from "./ReceiptRegistry.sol";

interface ReceiptTestVm {
    function expectEmit(bool, bool, bool, bool, address) external;
    function expectRevert(bytes4) external;
    function prank(address) external;
}

contract ReceiptRegistryTest {
    ReceiptTestVm private constant VM = ReceiptTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant DIGEST = keccak256("test receipt");
    ReceiptRegistry private registry;

    event Anchored(bytes32 indexed digest);

    function setUp() public {
        registry = new ReceiptRegistry(address(this));
    }

    function testPublisherEmitsIndexedDigest() public {
        assert(registry.publisher() == address(this));
        VM.expectEmit(true, false, false, true, address(registry));
        emit Anchored(DIGEST);
        registry.anchor(DIGEST);
    }

    function testOtherAccountCannotPublish() public {
        VM.expectRevert(ReceiptRegistry.UnauthorizedPublisher.selector);
        VM.prank(address(0xBEEF));
        registry.anchor(DIGEST);
    }

    function testRejectsZeroPublisher() public {
        VM.expectRevert(ReceiptRegistry.InvalidPublisher.selector);
        new ReceiptRegistry(address(0));
    }
}
