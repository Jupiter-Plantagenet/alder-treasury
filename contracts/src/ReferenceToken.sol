// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract ReferenceToken is ERC20 {constructor(address treasury,uint256 supply) ERC20("Alder Reference", "ALDR") {require(treasury!=address(0),"treasury");_mint(treasury,supply);} function decimals() public pure override returns(uint8){return 6;}}
