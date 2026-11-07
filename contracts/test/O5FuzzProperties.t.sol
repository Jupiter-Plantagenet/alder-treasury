// SPDX-License-Identifier: MIT
// O5 (round-5 ops) TR-T-FUZZ gap-fill: one fuzz property per scheduled dimension (amount is in BatchExecutor.t.sol)
// - array, time window, recipient, cancellation, unauthorized pull - plus a MALICIOUS-CALLBACK token that re-enters the
// executor during transferFrom (directly, and through a pre-signed Safe transaction at the next nonce).
pragma solidity 0.8.24;
import {Safe} from "@safe-global/safe-contracts/contracts/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/common/Enum.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BatchExecutor} from "../src/BatchExecutor.sol";
import {FailureToken,IExecutor,Vm} from "./BatchExecutor.t.sol";

/// Malicious-callback fixture token: on the armed transfer it calls `target` with `payload` from inside transferFrom.
/// mode 1 = swallow the callback's failure and finish the transfer; mode 2 = propagate the callback's revert.
contract CallbackToken is ERC20 {
 address public target; bytes public payload; uint256 public mode; address public armedTo; bool public callbackOk; uint256 public callbacks;
 constructor() ERC20("O5 Callback","O5CB"){} function decimals() public pure override returns(uint8){return 6;}
 function mint(address to,uint256 n) external {_mint(to,n);}
 function arm(address to,address t,bytes calldata p,uint256 m) external {armedTo=to;target=t;payload=p;mode=m;}
 function _update(address a,address b,uint256 n) internal override {
  if(b==armedTo&&b!=address(0)&&mode!=0){uint256 m=mode;mode=0;callbacks++;(bool ok,bytes memory ret)=target.call(payload);callbackOk=ok;if(!ok&&m==2){assembly{revert(add(ret,32),mload(ret))}}}
  super._update(a,b,n);
 }
}

contract O5Base {
 Vm vm=Vm(address(uint160(uint256(keccak256("hevm cheat code"))))); Safe safe; uint k1=101; uint k2=202;
 function newSafe() internal returns(Safe s){Safe singleton=new Safe();SafeProxyFactory f=new SafeProxyFactory();address[] memory o=new address[](3);o[0]=vm.addr(k1);o[1]=vm.addr(k2);o[2]=vm.addr(303);s=Safe(payable(address(f.createProxyWithNonce(address(singleton),abi.encodeCall(Safe.setup,(o,2,address(0),hex"",address(0),address(0),0,payable(address(0)))),7))));}
 function sigs(address to,bytes memory data,uint256 nonce) internal returns(bytes memory){return sigsG(to,data,nonce,1000000);}
 function sigsG(address to,bytes memory data,uint256 nonce,uint256 g) internal returns(bytes memory){bytes32 h=safe.getTransactionHash(to,0,data,Enum.Operation.Call,g,0,0,address(0),address(0),nonce);(uint8 v1,bytes32 r1,bytes32 s1)=vm.sign(k1,h);(uint8 v2,bytes32 r2,bytes32 s2)=vm.sign(k2,h);bytes memory a=abi.encodePacked(r1,s1,v1);bytes memory b=abi.encodePacked(r2,s2,v2);return vm.addr(k1)<vm.addr(k2)?bytes.concat(a,b):bytes.concat(b,a);}
 function exec(address to,bytes memory data) internal returns(bool){bytes memory s=sigs(to,data,safe.nonce());return safe.execTransaction(to,0,data,Enum.Operation.Call,1000000,0,0,address(0),payable(address(0)),s);}
 /// outer safeTxGas large enough that a nested pre-signed Safe call really reaches the executor (exercises nonReentrant, not GS010)
 function execBig(address to,bytes memory data) internal returns(bool){bytes memory s=sigsG(to,data,safe.nonce(),8000000);return safe.execTransaction(to,0,data,Enum.Operation.Call,8000000,0,0,address(0),payable(address(0)),s);}
}

contract O5FuzzPropertiesTest is O5Base {
 FailureToken token; IExecutor ex;
 function setUp() public {vm.warp(2000000);safe=newSafe();token=new FailureToken();ex=IExecutor(address(new BatchExecutor(address(safe),address(token),block.chainid)));token.mint(address(safe),1e30);require(exec(address(token),abi.encodeCall(ERC20.approve,(address(ex),1e30))),"cap");}
 function batch(bytes32 id,uint64 a,uint64 u,IExecutor.Payment[] memory p) internal view returns(bytes memory){return abi.encodeCall(IExecutor.executeBatch,(id,a,u,ex.authorityHash(),p));}
 function rcpt(uint256 seed,uint256 i) internal view returns(address r){r=address(uint160(uint256(keccak256(abi.encode(seed,i)))));if(r==address(0)||r==address(safe)||r==address(ex))r=address(uint160(0xBEEF+i));}

 /// array: 1..100 items, distinct IDs, arbitrary recipients (duplicates allowed) and amounts; exact sum, each ID once.
 function testFuzzArray(uint8 n,uint256 seed) public {
  uint256 len=uint256(n)%100+1;IExecutor.Payment[] memory p=new IExecutor.Payment[](len);uint256 total;
  for(uint256 i;i<len;i++){p[i]=IExecutor.Payment(keccak256(abi.encode(seed,"id",i)),rcpt(seed%7==0?0:seed,seed%5==0?i%3:i),uint256(keccak256(abi.encode(seed,i)))%1e18+1);total+=p[i].amount;}
  uint256 sb=token.balanceOf(address(safe));
  require(exec(address(ex),batch(keccak256(abi.encode(seed,"b")),uint64(block.timestamp),uint64(block.timestamp+1 days),p)),"valid array batch");
  require(sb-token.balanceOf(address(safe))==total,"Safe delta = checked total");
  uint256 sumAfter;for(uint256 i;i<len;i++){require(ex.usedPaymentId(p[i].paymentId),"every ID marked");bool dup;for(uint256 j;j<i;j++)if(p[j].recipient==p[i].recipient)dup=true;if(!dup)sumAfter+=token.balanceOf(p[i].recipient);}
  require(sumAfter==total,"recipient sum = total (fresh recipients)");require(!exec(address(ex),batch(keccak256(abi.encode(seed,"b2")),uint64(block.timestamp),uint64(block.timestamp+1 days),p)),"IDs at most once");
 }
 /// time: accepted iff validAfter <= ts <= validUntil, until > after and until-after <= 7 days; no effect otherwise.
 function testFuzzTimeWindow(uint32 da,uint32 du,uint32 dt) public {
  uint64 base=uint64(block.timestamp)+30 days;uint64 a=base-15 days+uint64(da%(30 days));uint64 u=a+uint64(du%(9 days))-1 days;uint64 ts=base-16 days+uint64(dt%(32 days));
  vm.warp(ts);IExecutor.Payment[] memory p=new IExecutor.Payment[](1);p[0]=IExecutor.Payment(keccak256(abi.encode(da,du,dt)),address(0xA11CE),5);
  bool expect=u>a&&u-a<=7 days&&ts>=a&&ts<=u;bool got=exec(address(ex),batch(keccak256(abi.encode("t",da,du,dt)),a,u,p));
  require(got==expect,"time predicate");require(token.balanceOf(address(0xA11CE))==(expect?5:0),"effect iff accepted");require(ex.usedPaymentId(p[0].paymentId)==expect,"marker iff accepted");
 }
 /// recipient: zero, Safe and executor rejected; any other address accepted with exact delta.
 function testFuzzRecipient(address r,uint8 which) public {
  if(which%4==1)r=address(0);else if(which%4==2)r=address(safe);else if(which%4==3)r=address(ex);
  IExecutor.Payment[] memory p=new IExecutor.Payment[](1);p[0]=IExecutor.Payment(keccak256(abi.encode(r,which)),r,9);uint256 before=token.balanceOf(r);
  bool bad=r==address(0)||r==address(safe)||r==address(ex);bool got=exec(address(ex),batch(keccak256(abi.encode("r",r,which)),uint64(block.timestamp),uint64(block.timestamp+1),p));
  require(got==!bad,"recipient rule");if(!bad)require(token.balanceOf(r)==before+9,"exact");
 }
 /// cancellation: cancel-before-execute blocks forever; execute-then-cancel is refused; repeated cancel is a no-op.
 function testFuzzCancellation(bytes32 id,bool cancelFirst,uint8 repeats) public {
  if(id==bytes32(0))id=bytes32(uint256(1));IExecutor.Payment[] memory p=new IExecutor.Payment[](1);p[0]=IExecutor.Payment(keccak256(abi.encode(id)),address(0xB0B),3);bytes memory data=batch(id,uint64(block.timestamp),uint64(block.timestamp+1 days),p);
  if(cancelFirst){for(uint256 i;i<uint256(repeats)%4+1;i++)require(exec(address(ex),abi.encodeCall(IExecutor.cancelBatch,(id))),"cancel/no-op");require(!exec(address(ex),data),"cancelled stays dead");require(token.balanceOf(address(0xB0B))==0&&!ex.usedPaymentId(p[0].paymentId),"no effect");}
  else{require(exec(address(ex),data),"execute");require(!exec(address(ex),abi.encodeCall(IExecutor.cancelBatch,(id))),"cancel after execute refused");require(token.balanceOf(address(0xB0B))==3,"paid once");}
 }
 /// no unauthorized pull: any non-Safe caller is refused by the executor and cannot pull with the Safe's cap.
 function testFuzzUnauthorizedPull(address caller,uint96 amount) public {
  if(caller==address(safe)||caller==address(vm)||uint160(caller)<=0xff)caller=address(0xCA11);amount=amount%1e9+1;uint256 sb=token.balanceOf(address(safe));IExecutor.Payment[] memory p=new IExecutor.Payment[](1);p[0]=IExecutor.Payment(keccak256(abi.encode(caller,amount)),caller==address(0)?address(1):caller,amount);
  vm.prank(caller);(bool ok,)=address(ex).call(batch(bytes32(uint256(77)),uint64(block.timestamp),uint64(block.timestamp+1),p));require(!ok,"OnlySafe");
  if(caller!=address(ex)){vm.prank(caller);(bool ok2,)=address(token).call(abi.encodeCall(ERC20.transferFrom,(address(safe),caller,amount)));require(!ok2,"cap is executor-only");}
  require(token.balanceOf(address(safe))==sb,"treasury intact");
 }
}

contract O5MaliciousCallbackTest is O5Base {
 CallbackToken token; IExecutor ex;
 function setUp() public {vm.warp(3000000);safe=newSafe();token=new CallbackToken();ex=IExecutor(address(new BatchExecutor(address(safe),address(token),block.chainid)));token.mint(address(safe),1e24);require(exec(address(token),abi.encodeCall(ERC20.approve,(address(ex),1e24))),"cap");}
 function three(uint256 seed,uint256 amount) internal view returns(IExecutor.Payment[] memory p){p=new IExecutor.Payment[](3);for(uint256 i;i<3;i++)p[i]=IExecutor.Payment(keccak256(abi.encode(seed,i)),address(uint160(0x1000+i+seed%1000)),amount);}
 function payload(bytes32 id,IExecutor.Payment[] memory p) internal view returns(bytes memory){return abi.encodeCall(IExecutor.executeBatch,(id,uint64(block.timestamp),uint64(block.timestamp+1 days),ex.authorityHash(),p));}
 /// re-entry through a VALID pre-signed Safe tx at the next nonce into executeBatch (nonReentrant), callback failure swallowed.
 function testFuzzReentryViaSafeSwallowed(uint256 seed,uint64 amount,uint8 at) public {
  amount=amount%1e12+1;IExecutor.Payment[] memory p=three(seed,amount);IExecutor.Payment[] memory q=three(seed^1,amount);
  bytes memory inner=payload(keccak256(abi.encode(seed,"inner")),q);uint256 n=safe.nonce();bytes memory innerSig=sigs(address(ex),inner,n+1);
  token.arm(p[at%3].recipient,address(safe),abi.encodeCall(Safe.execTransaction,(address(ex),0,inner,Enum.Operation.Call,1000000,0,0,address(0),payable(address(0)),innerSig)),1);
  uint256 sb=token.balanceOf(address(safe));require(execBig(address(ex),payload(keccak256(abi.encode(seed,"outer")),p)),"outer batch");
  require(token.callbacks()==1&&token.callbackOk(),"callback reached the Safe and the nested execTransaction returned (ExecutionFailure), i.e. the executor's nonReentrant refused it");require(safe.nonce()==n+2,"nested Safe nonce consumed by the failed re-entry");for(uint256 i;i<3;i++){require(!ex.usedPaymentId(q[i].paymentId),"re-entered batch IDs unused");require(token.balanceOf(q[i].recipient)==(q[i].recipient==p[0].recipient||q[i].recipient==p[1].recipient||q[i].recipient==p[2].recipient?amount:0),"no re-entered effect");}
  require(!ex.executedBatch(keccak256(abi.encode(seed,"inner"))),"inner batch not executed");require(sb-token.balanceOf(address(safe))==3*uint256(amount),"only the outer batch moved");
 }
 /// direct re-entry into executeBatch from the token (not the Safe) is OnlySafe; propagated => whole outer batch rolls back.
 function testFuzzReentryDirectPropagated(uint256 seed,uint64 amount,uint8 at) public {
  amount=amount%1e12+1;IExecutor.Payment[] memory p=three(seed,amount);token.arm(p[at%3].recipient,address(ex),payload(keccak256(abi.encode(seed,"x")),three(seed^9,amount)),2);
  uint256 sb=token.balanceOf(address(safe));bytes32 id=keccak256(abi.encode(seed,"outer"));require(!exec(address(ex),payload(id,p)),"outer must fail");
  require(token.balanceOf(address(safe))==sb&&!ex.executedBatch(id),"rolled back");for(uint256 i;i<3;i++)require(token.balanceOf(p[i].recipient)==0&&!ex.usedPaymentId(p[i].paymentId),"no partial");
 }
 /// re-entry into cancelBatch(outer) through a valid pre-signed Safe tx is blocked by nonReentrant; outer still executes exactly once.
 function testFuzzReentryCancelViaSafe(uint256 seed,uint64 amount) public {
  amount=amount%1e12+1;IExecutor.Payment[] memory p=three(seed,amount);bytes32 id=keccak256(abi.encode(seed,"outer"));bytes memory c=abi.encodeCall(IExecutor.cancelBatch,(id));uint256 n=safe.nonce();bytes memory cs=sigs(address(ex),c,n+1);
  token.arm(p[1].recipient,address(safe),abi.encodeCall(Safe.execTransaction,(address(ex),0,c,Enum.Operation.Call,1000000,0,0,address(0),payable(address(0)),cs)),1);
  require(execBig(address(ex),payload(id,p)),"outer");require(ex.executedBatch(id),"executed");require(token.callbacks()==1&&token.callbackOk()&&safe.nonce()==n+2,"nested cancel reached the executor and was refused (ExecutionFailure)");
  (bool cancelled)=BatchExecutor(address(ex)).cancelledBatch(id);require(!cancelled,"re-entrant cancel blocked");
 }
}
