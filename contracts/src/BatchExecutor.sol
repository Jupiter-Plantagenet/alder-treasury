// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
interface ISafeAuthority {function getOwners() external view returns(address[] memory);function getThreshold() external view returns(uint256);}
contract BatchExecutor is ReentrancyGuard {
 using SafeERC20 for IERC20;
 struct Payment {bytes32 paymentId;address recipient;uint256 amount;}
 address public immutable safe; IERC20 public immutable token; uint256 public immutable expectedChainId;
 string public constant PROFILE="ALDER_EXACT_1"; uint256 public constant MAX_ITEMS=100;
 mapping(bytes32=>bool) public usedPaymentId; mapping(bytes32=>bool) public executedBatch; mapping(bytes32=>bool) public cancelledBatch;
 event PaymentExecuted(bytes32 indexed batchId,bytes32 indexed paymentId,address token,address indexed recipient,uint256 amount);
 event BatchExecuted(bytes32 indexed batchId,bytes32 intentHash,uint256 total,uint256 count);
 event BatchCancelled(bytes32 indexed batchId);
 error Invalid(); error OnlySafe();
 constructor(address s,address t,uint256 chain){require(s.code.length>0&&t.code.length>0&&chain==block.chainid,"deployment");safe=s;token=IERC20(t);expectedChainId=chain;}
 modifier onlySafe(){if(msg.sender!=safe)revert OnlySafe();_;}
 function authorityHash() public view returns(bytes32){address[] memory owners=ISafeAuthority(safe).getOwners();for(uint i=1;i<owners.length;i++){address a=owners[i];uint j=i;while(j>0&&owners[j-1]>a){owners[j]=owners[j-1];j--;}owners[j]=a;}return keccak256(abi.encode(owners,ISafeAuthority(safe).getThreshold()));}
 function executeBatch(bytes32 id,uint64 afterTime,uint64 until,bytes32 authority,Payment[] calldata items) external onlySafe nonReentrant {
 if(block.chainid!=expectedChainId||id==bytes32(0)||executedBatch[id]||cancelledBatch[id]||items.length==0||items.length>100||until<=afterTime||until-afterTime>7 days||block.timestamp<afterTime||block.timestamp>until||authority!=authorityHash())revert Invalid();
 uint total;executedBatch[id]=true;
 for(uint i;i<items.length;i++){Payment calldata p=items[i];if(p.paymentId==bytes32(0)||usedPaymentId[p.paymentId]||p.amount==0||p.recipient==address(0)||p.recipient==safe||p.recipient==address(this))revert Invalid();usedPaymentId[p.paymentId]=true;total+=p.amount;}
 if(token.balanceOf(safe)<total||token.allowance(safe,address(this))<total)revert Invalid();
 for(uint i;i<items.length;i++){Payment calldata p=items[i];uint a=token.balanceOf(safe);uint b=token.balanceOf(p.recipient);token.safeTransferFrom(safe,p.recipient,p.amount);if(token.balanceOf(safe)!=a-p.amount||token.balanceOf(p.recipient)!=b+p.amount)revert Invalid();emit PaymentExecuted(id,p.paymentId,address(token),p.recipient,p.amount);}
 emit BatchExecuted(id,keccak256(msg.data),total,items.length);
 }
 function cancelBatch(bytes32 id) external onlySafe nonReentrant {if(executedBatch[id])revert Invalid();if(!cancelledBatch[id]){cancelledBatch[id]=true;emit BatchCancelled(id);}}
}
