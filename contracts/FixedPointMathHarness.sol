// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FixedPointMath} from "../contracts/FixedPointMath.sol";

/// @notice Thin external-facing wrapper so a test can call a pure library
///         function like a normal contract method. Not part of the
///         deployed protocol; lives only under test/.
contract FixedPointMathHarness {
    function ln1p(uint256 r) external pure returns (uint256) {
        return FixedPointMath.ln1p(r);
    }
}
