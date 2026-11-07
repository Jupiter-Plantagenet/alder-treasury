// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Safe} from "@safe-global/safe-contracts/contracts/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/common/Enum.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BatchExecutor} from "../src/BatchExecutor.sol";
import {FailureToken,IExecutor,Vm} from "./BatchExecutor.t.sol";
contract TreasuryHandler {
 Vm private constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
 Safe public safe;FailureToken public token;IExecutor public executor;uint256 public paid;uint256 public sequence;uint256 public accepted;uint256 public failures;bytes private lastPayload;bytes32[] private paidIds;
 constructor(){vm.warp(1000000);Safe singleton=new Safe();SafeProxyFactory f=new SafeProxyFactory();address[] memory owners=new address[](3);owners[0]=vm.addr(101);owners[1]=vm.addr(202);owners[2]=vm.addr(303);safe=Safe(payable(address(f.createProxyWithNonce(address(singleton),abi.encodeCall(Safe.setup,(owners,2,address(0),hex"",address(0),address(0),0,payable(address(0)))),42))));token=new FailureToken();executor=IExecutor(address(new BatchExecutor(address(safe),address(token),block.chainid)));token.mint(address(safe),1e12);require(_exec(address(token),abi.encodeCall(ERC20.approve,(address(executor),1e12))),"initial bounded fixture cap");}
 function _exec(address to,bytes memory data) private returns(bool){bytes32 hash=safe.getTransactionHash(to,0,data,Enum.Operation.Call,1000000,0,0,address(0),address(0),safe.nonce());(uint8 av,bytes32 ar,bytes32 ass)=vm.sign(101,hash);(uint8 bv,bytes32 br,bytes32 bs)=vm.sign(202,hash);bytes memory a=abi.encodePacked(ar,ass,av);bytes memory b=abi.encodePacked(br,bs,bv);return safe.execTransaction(to,0,data,Enum.Operation.Call,1000000,0,0,address(0),payable(address(0)),vm.addr(101)<vm.addr(202)?bytes.concat(a,b):bytes.concat(b,a));}
 function action(uint256 seed) external {
  uint256 mode=seed%6;uint256 nonceBefore=safe.nonce();uint256 balanceBefore=token.balanceOf(address(safe));sequence++;bytes32 batch=keccak256(abi.encode(sequence));uint256 amount=seed%10000+1;IExecutor.Payment[] memory p=new IExecutor.Payment[](3);for(uint256 i;i<3;i++)p[i]=IExecutor.Payment(keccak256(abi.encode(sequence,i)),address(uint160(100+i)),amount);
  bytes memory payload=abi.encodeCall(IExecutor.executeBatch,(batch,uint64(block.timestamp),uint64(block.timestamp+1 days),executor.authorityHash(),p));
  if(mode==0){require(_exec(address(executor),payload),"authorized exact batch failed");paid+=3*amount;accepted++;lastPayload=payload;for(uint256 i;i<3;i++)paidIds.push(p[i].paymentId);}
  else if(mode==1&&lastPayload.length>0){require(!_exec(address(executor),lastPayload),"replay accepted");failures++;}
  else if(mode==2){require(_exec(address(executor),abi.encodeCall(IExecutor.cancelBatch,(batch))),"cancel failed");require(_exec(address(executor),abi.encodeCall(IExecutor.cancelBatch,(batch))),"idempotent cancel failed");require(!_exec(address(executor),payload),"cancelled batch accepted");failures++;}
  else if(mode==3){(bool ok,)=address(executor).call(payload);require(!ok,"non Safe accepted");require(safe.nonce()==nonceBefore,"outsider consumed Safe nonce");}
  else if(mode==4){bytes memory expired=abi.encodeCall(IExecutor.executeBatch,(batch,uint64(block.timestamp-2 days),uint64(block.timestamp-1 days),executor.authorityHash(),p));require(!_exec(address(executor),expired),"expiry accepted");failures++;}
  else if(mode==5){token.fail(address(102));require(!_exec(address(executor),payload),"third transfer accepted");for(uint256 i;i<3;i++)require(!executor.usedPaymentId(p[i].paymentId),"failed marker leaked");require(!executor.executedBatch(batch),"failed batch marker leaked");token.fail(address(0));failures++;}
  if(mode!=0)require(token.balanceOf(address(safe))==balanceBefore,"failed path changed treasury");
 }
 function assertAccounting() external view {uint256 sum;for(uint256 i;i<3;i++)sum+=token.balanceOf(address(uint160(100+i)));require(sum==paid,"recipient accounting");require(token.balanceOf(address(safe))+paid==1e12,"treasury conservation");require(token.balanceOf(address(executor))==0,"executor retained funds");require(token.allowance(address(safe),address(executor))+paid==1e12,"bounded cap conservation");for(uint256 i;i<paidIds.length;i++)require(executor.usedPaymentId(paidIds[i]),"accepted ID forgotten");}
}
contract TreasuryInvariantTest {
 TreasuryHandler public handler;address[] private targets;
 function setUp() public {handler=new TreasuryHandler();targets.push(address(handler));}
 function targetContracts() external view returns(address[] memory){return targets;}
 function invariant_exactConservationReplayRollbackAndAuthority() public view {handler.assertAccounting();}
}
