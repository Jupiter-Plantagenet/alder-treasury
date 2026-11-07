"""Package measured supply evidence and reconcile only TR-T-SUPPLY, preserving history."""
import collections
import copy
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'evidence/round6-perf/supply-current-20261102'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read(relative):
    return json.loads((ROOT / relative).read_text(encoding='utf-8'))


def main():
    OUT.mkdir(parents=True, exist_ok=False)
    raw_root = '.local/release-supply-20261102/'
    audit = read(raw_root + 'receipt.json')
    assert audit['results']['audit']['exit_code'] == 0
    assert audit['results']['audit']['vulnerabilities']['total'] == 0
    assert digest((ROOT / 'package-lock.json').read_bytes()) == audit['package_lock_sha256']
    review_path = 'docs/independent-review-current-finish-20261102.json'
    review = read(review_path)
    pins = review['current_source_sha256']
    assert len(pins) == 43 and all(digest((ROOT / p).read_bytes()) == h for p, h in pins.items())
    assert review['release_blocker'] == 'Empirical release gates remain open; no reviewed current-source P2 finding remains.'
    restoration = read('.local/codex-a2/20261102-live-restoration-evidence.json')
    binding_path = restoration['binding']['report']
    binding_bytes = (ROOT / binding_path).read_bytes()
    assert digest(binding_bytes) == restoration['binding']['reportSha256']
    binding = json.loads(binding_bytes)
    assert binding['status'] == 'PASS' and len(binding['contracts']) == 5
    assert len(binding['sourceFiles']) == 30 and binding['noTransactionsSent']
    assert all(digest((ROOT / p).read_bytes()) == h for p, h in binding['sourceFiles'].items())
    source_path = '.local/scratch-r6/runs/p6-20261101T235425Z-a2stack/setup/supply-source-audit.json'
    source = read(source_path)
    assert source['safe']['source_match_count'] == source['safe']['source_files'] == 45
    assert not source['safe']['source_mismatches'] and source['safe']['license_matches_manifest']
    assert source['openzeppelin']['version'] == source['openzeppelin']['lock_version'] == '5.0.2'
    license_path = 'docs/licenses/OpenZeppelin-5.0.2-MIT.txt'
    license_notice = read('docs/licenses/OpenZeppelin-5.0.2-MIT.provenance.json')
    assert digest((ROOT / license_path).read_bytes()) == license_notice['sha256']
    selected = [raw_root + x for x in ('receipt.json', 'audit.stdout.json', 'sbom.stdout.json', 'inventory.raw.log')]
    selected += [review_path, source_path, binding_path, license_path,
                 'docs/licenses/OpenZeppelin-5.0.2-MIT.provenance.json',
                 'docs/licenses/Safe-LGPL-3.0.txt', 'vendor/safe-1.4.1/SOURCE.json',
                 'tests/round6-perf/canonical-supply-binding.mjs']
    copies = {}
    for i, relative in enumerate(selected):
        raw = (ROOT / relative).read_bytes()
        name = f'{i:02d}-' + Path(relative).name
        with (OUT / name).open('xb') as stream:
            stream.write(raw)
        copies[relative] = {'file': name, 'sha256': digest(raw), 'bytes': len(raw)}
    assertions = [
        ('No unresolved critical/high security findings', [selected[0], review_path],
         'Current npm advisory execution reports zero findings, and all43 independently reviewed current source pins match; no unresolved reviewed P2 remains.'),
        ('exact Safe/OZ rights and notices reviewed', [source_path, license_path, 'docs/licenses/Safe-LGPL-3.0.txt'],
         'Safe1.4.1 LGPL-3.0 notice and45 source hashes checked; OpenZeppelin5.0.2 MIT SPDX/package declaration and full official tagged notice preserved. License obligations remain part of release packaging.'),
        ('no private code', [source_path, raw_root + 'sbom.stdout.json'],
         'Reviewed third-party custody sources are the pinned open-source Safe/OpenZeppelin distributions; this is a dependency provenance claim, not a claim to publish local secrets.'),
        ('dependency digest/bytecode and compiler metadata checked', [binding_path, raw_root + 'receipt.json'],
         'All5 canonical live runtime contracts match deployment hashes and compiled artifacts, including executor immutables;30 metadata source hashes and compiler0.8.24/Shanghai/optimizer200 checked.'),
        ('no audit/certification inference', [review_path, binding_path],
         'This packet records bounded execution and simulated AI source review; no formal security audit or certification is claimed.'),
    ]
    report = {'schema': 'alder.current-supply-proof/v1', 'id': 'TR-T-SUPPLY', 'status': 'pass',
              'basis': 'current_advisory_execution_and_independent_source_rights_bytecode_review',
              'at_utc': datetime.now(timezone.utc).isoformat(), 'evidence': copies,
              'review_source_pins_verified': pins, 'assertions': [
                  {'assertion': assertion, 'status': 'pass', 'evidence_paths': evidence, 'finding': finding}
                  for assertion, evidence, finding in assertions],
              'limitations': ['No formal audit/certification; no clean-host rebuild or database restore inferred.',
                              'Other product acceptance IDs remain open; this closes only the frozen supply review condition.'],
              'packager_sha256': digest(Path(__file__).read_bytes())}
    report_raw = (json.dumps(report, indent=2) + '\n').encode()
    (OUT / 'report.json').write_bytes(report_raw)
    matrix_path = ROOT / 'docs/current-acceptance-matrix-20261102.json'
    matrix_raw = matrix_path.read_bytes()
    before = OUT / 'matrix-before'
    before.mkdir()
    for name in ('current-acceptance-matrix-20261102.json', 'current-acceptance-matrix-20261102.md'):
        (before / name).write_bytes((ROOT / 'docs' / name).read_bytes())
    matrix = json.loads(matrix_raw)
    row = next(item for item in matrix['acceptance'] if item['id'] == 'TR-T-SUPPLY')
    assert row['status'] == 'not_run'
    evidence_path = 'evidence/round6-perf/supply-current-20261102/report.json'
    row.update(status='pass', basis='executed', product_gap=None,
               gap_classification='current_execution_and_independent_review',
               assertion_reconciliation='Current advisory/SBOM execution, exact Safe/OZ rights review and canonical artifact/compiler binding completed; no audit/certification inference.',
               reviewer_remaining_criterion=None, execution_update_utc=report['at_utc'])
    for claim in row['claims']:
        proof = next(a for a in report['assertions'] if a['assertion'] == claim['assertion'])
        claim.update(status='pass', basis='executed_and_reviewed', remaining_gap=None,
                     evidence_paths=[evidence_path, *proof['evidence_paths']],
                     acceptance_assertion_status='pass', source_review_status='reviewed with current measured evidence',
                     gap_classification='current_execution_and_independent_review')
    row['current_execution_claims'] = copy.deepcopy(row['claims'])
    row['evidence'].append({'path': evidence_path, 'sha256': digest(report_raw)})
    matrix['evidence_sha256'][evidence_path] = digest(report_raw)
    count = collections.Counter(item['status'] for item in matrix['acceptance'])
    matrix['summary'].update(executed_pass=count['pass'], reviewed_pass=count['reviewed-pass'],
                             partial=count['partial'], fail=count['fail'], not_run=count['not_run'])
    matrix['release_readiness'] = 'NO_GO_FOR_RELEASE: remaining empirical performance, restore, browser/accessibility and convergence gates remain open; supply review is now closed.'
    matrix_path.write_text(json.dumps(matrix, indent=2) + '\n', encoding='utf-8')
    with (ROOT / 'docs/current-acceptance-matrix-20261102.md').open('a', encoding='utf-8') as stream:
        stream.write('\n\n## Current supply evidence update\n\nTR-T-SUPPLY is now pass from current measured advisory/SBOM and canonical bytecode/compiler binding plus independently pinned source/rights review. See `evidence/round6-perf/supply-current-20261102/report.json`. Historical disposition and prior matrix are preserved in that packet. Other release gates remain open.\n')
    print(json.dumps({'id': 'TR-T-SUPPLY', 'status': 'pass', 'report_sha256': digest(report_raw), 'summary': matrix['summary']}))


if __name__ == '__main__':
    main()
