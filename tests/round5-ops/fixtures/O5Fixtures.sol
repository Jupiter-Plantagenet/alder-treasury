// SPDX-License-Identifier: MIT
// O5 (round-5 ops) TEST INSTRUMENTATION ONLY. Deployed only on the isolated Anvil 18548. Not product code,
// not a supported asset/owner profile: failure fixtures exist to prove rejection/rollback.
pragma solidity 0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// Emits arbitrary logs with caller-chosen topics: forges events with signatures identical to Safe/executor/token events.
contract O5Forger {
 function emitLog(bytes32[] calldata t, bytes calldata d) external {
  bytes memory data=d;uint n=t.length;
  assembly {
   let p:=add(data,32) let l:=mload(data)
   switch n
   case 0 {log0(p,l)}
   case 1 {log1(p,l,calldataload(t.offset))}
   case 2 {log2(p,l,calldataload(t.offset),calldataload(add(t.offset,32)))}
   case 3 {log3(p,l,calldataload(t.offset),calldataload(add(t.offset,32)),calldataload(add(t.offset,64)))}
   default {log4(p,l,calldataload(t.offset),calldataload(add(t.offset,32)),calldataload(add(t.offset,64)),calldataload(add(t.offset,96)))}
  }
 }
}
/// transferFrom to `failTo` returns false WITHOUT reverting (ATOMIC return-false variant).
contract O5ReturnFalseToken is ERC20 {
 address public failTo; constructor(address to,uint256 supply) ERC20("O5 ReturnFalse","O5RF"){_mint(to,supply);} function decimals() public pure override returns(uint8){return 6;}
 function setFail(address a) external {failTo=a;}
 function transferFrom(address f,address t,uint256 v) public override returns(bool){if(t==failTo&&t!=address(0))return false;return super.transferFrom(f,t,v);}
}
/// transfer to `failTo` delivers one base unit less than requested (ATOMIC delta-mismatch / fee-on-transfer variant).
contract O5DeltaToken is ERC20 {
 address public failTo; constructor(address to,uint256 supply) ERC20("O5 Delta","O5DT"){_mint(to,supply);} function decimals() public pure override returns(uint8){return 6;}
 function setFail(address a) external {failTo=a;}
 function _update(address f,address t,uint256 v) internal override {if(t==failTo&&t!=address(0)&&f!=address(0)&&v>1){super._update(f,t,v-1);super._update(f,address(0xdead),1);}else super._update(f,t,v);}
}
/// Contract owner implementing ONLY the legacy Safe-1.4.1 `isValidSignature(bytes,bytes)` (magic 0x20c13b0b).
contract O5LegacyOwner { function isValidSignature(bytes memory,bytes memory) external pure returns(bytes4){return 0x20c13b0b;} }
/// Contract owner implementing ONLY modern ERC-1271 `isValidSignature(bytes32,bytes)` (magic 0x1626ba7e).
contract O5ModernOwner { function isValidSignature(bytes32,bytes memory) external pure returns(bytes4){return 0x1626ba7e;} }
