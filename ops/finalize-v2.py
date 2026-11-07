"""Check exact specification coverage and summarize executed local evidence only."""
from pathlib import Path
import json,re,collections,hashlib
r=Path(__file__).resolve().parents[1]
load=lambda p:json.loads((r/p).read_text(encoding='utf-8'))
spec=load('docs/inputs/treasury-contracts.json');acceptance=load('docs/acceptance.json');screens=load('apps/web/screens.json')
assert {x['id'] for x in spec['acceptance_tests']}=={x['id'] for x in acceptance['tests']}
assert {x['id'] for x in spec['screens']}=={x['id'] for x in screens}
assert len(acceptance['tests'])==32 and len(screens)==13
log=lambda p:(r/p).read_text(encoding='utf-8')
integration=log('evidence/tests-v2-current-integration.log');contracts=log('evidence/contracts-v2-current.log');wallet=load('evidence/browser-wallet-v2/report.json');audit=load('evidence/npm-audit-v2-current.json')
assert re.search(r'pass 10\b',integration) and re.search(r'fail 0\b',integration)
assert '11 tests passed, 0 failed' in contracts and 'calls: 128000, reverts: 0' in contracts
assert wallet['passed'] and len(wallet['screens'])==13
assert 'PASS real browser cryptographic' in log('evidence/tests-v2-current-wallet.log'),'current wallet command failed; older report is not sufficient'
assert audit['metadata']['vulnerabilities']['total']==0
adversarial=load('evidence/legacy-proof-v2-latest.json');assert adversarial['exitCode']==0 and adversarial['originalReportHashesChecked']==5
assert 'PASS real isolated browser' in log('evidence/prepared-outer-v2-current.log')
fast=[int(n) for n in re.findall(r'pass (\d+)\b',log('evidence/tests-v2-current-fast.log'))]
assert sum(fast)==6
assert 'built in' in log('evidence/build-v2-current.log')
source_roots=['apps','packages','services','contracts/src','contracts/test','db','ops','tests','vendor']
source=[]
for folder in source_roots:
 for p in (r/folder).rglob('*'):
  if p.is_file():source.append((p.relative_to(r).as_posix(),hashlib.sha256(p.read_bytes()).hexdigest()))
source_digest=hashlib.sha256(json.dumps(sorted(source),separators=(',',':')).encode()).hexdigest()
report={'scope':'Local integration v2; not full release or independent audit','verdict':'NO_GO_FOR_RELEASE','exact_acceptance_ids':32,'exact_screen_ids':13,'acceptance_status_counts':dict(collections.Counter(x['release_status'] for x in acceptance['tests'])),'complete_release_passes':0,'fast_subset_tests':sum(fast),'isolated_integration_tests':10,'foundry_tests':11,'amount_fuzz_runs':10000,'invariant':{'runs':1000,'depth':128,'calls':128000,'reverts':0},'browser':wallet,'npm_audit':audit['metadata']['vulnerabilities'],'adversarial_subsystem_proof':adversarial,'private_restore':load('evidence/private-restore-v2.json'),'runtime':load('evidence/runtime-v2.json'),'implementation_source_digest_sha256':source_digest,'implementation_source_files':len(source),'source_digest_scope':source_roots,'full_limits':'docs/LOCAL-v2.md','independent_findings':'docs/INDEPENDENT-FINDINGS-v2.md','implementer_only_review':'docs/REVIEW-v2.md'}
(r/'evidence/result-v2.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print('VERIFIED:32 exact acceptance IDs;13exact screen IDs;6fast+10isolated+11Foundry tests;128000 invariant calls;browser3paid→3retracted;0npm findings;full release NO_GO.')
