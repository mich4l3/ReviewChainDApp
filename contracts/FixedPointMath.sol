// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// In a real Hardhat/Foundry project this comes from the published
// package instead of a vendored copy:
//   npm install solady            (Hardhat / npm workflow)
//   forge install Vectorized/solady   (Foundry workflow)
// and the import below becomes:
//   import {FixedPointMathLib} from "solady/src/utils/FixedPointMathLib.sol";
import "solady/src/utils/FixedPointMathLib.sol";

/// @title FixedPointMath
/// @notice Computes the voting weight W = log(1 + R_voter) required by
///         WP2 S2.6, on top of Solady's `FixedPointMathLib.lnWad`
///         instead of a hand-rolled logarithm.
/// @dev Solady is a widely used, gas-optimized Solidity utility library
///      (MIT-licensed, github.com/Vectorized/solady). `lnWad` computes a
///      natural logarithm directly in 1e18 ("WAD") fixed point, which is
///      exactly the scale ReviewContract already uses for upvoteWeight /
///      downvoteWeight, so no extra unit conversion is needed at the call
///      site. Its own documentation states it is "an approximation" but
///      "monotonically increasing" -- which is the only property the
///      anti-farming argument in WP3 S3.3.5 actually depends on (a
///      strictly increasing weight in R, not a specific numerical
///      precision).
library FixedPointMath {
    /// @notice Returns ln(1 + r) scaled by 1e18, for an integer,
    ///         unscaled reputation score r. This is the effective voting
    ///         weight W of WP2 S2.6.
    function ln1p(uint256 r) internal pure returns (uint256) {
        // (r + 1) expressed in WAD (1e18) fixed point, as lnWad expects. 
        //each number gets "scaled" by multiplying it by 10^18, simultating to work with 18 decimal simulated figures
        int256 oneWad = int256(1e18);
        int256 x = int256(r) * oneWad + oneWad; // (r + 1) * 1e18
        int256 result = FixedPointMathLib.lnWad(x);  //calculates ln in WAD format
        // ln(1 + r) is >= 0 for every r >= 0, so this cast is always safe.
        return uint256(result);
    }
}
