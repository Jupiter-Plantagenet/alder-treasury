// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {ReferenceToken} from "../src/ReferenceToken.sol";
contract ReferenceTokenTest {function testFixedSupplyAndNoFixtureControls() public {ReferenceToken token=new ReferenceToken(address(this),42000000000);require(token.totalSupply()==42000000000&&token.balanceOf(address(this))==42000000000,"initial exact treasury supply");require(token.decimals()==6,"six decimals");(bool mint,)=address(token).call(abi.encodeWithSignature("mint(address,uint256)",address(this),1));require(!mint,"no mint authority");(bool fail,)=address(token).call(abi.encodeWithSignature("fail(address)",address(100)));require(!fail,"no failure control");}}
