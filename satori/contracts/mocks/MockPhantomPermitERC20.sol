// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice The "phantom permit" hazard, as a token.
///
///         It does NOT implement ERC-2612, but it has a permissive `fallback`,
///         so a call to `permit(...)` hits the fallback, does nothing, and
///         RETURNS SUCCESSFULLY. Any caller that reads permit's success as
///         "allowance granted" proceeds on a lie.
///
///         Real tokens are shaped like this. It is the reason the permit entry
///         points discard the permit's outcome entirely and let the subsequent
///         transfer be the only thing that decides — see
///         docs/design/permit-entry-points.md.
contract MockPhantomPermitERC20 is ERC20 {
    constructor() ERC20("Phantom", "PHNT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// Swallows `permit` (and anything else unrecognised) and returns success.
    fallback() external payable {}
    receive() external payable {}
}
