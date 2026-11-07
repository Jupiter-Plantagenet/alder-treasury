"""Deterministic ACL ordering regression for cross-cluster restore comparison."""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ops'))
import round6_restore_baseline as baseline  # noqa: E402


def test_acl_aggregates_sort_by_emitted_role_names() -> None:
    queries = dict(baseline._catalog_queries(None))
    for label in ('relation_acl', 'schema_acl', 'default_acl', 'function_acl', 'aggregate_acl'):
        sql = queries[label]
        match = re.search(r"\) ORDER BY (.*?),\s*'\[\]'::jsonb", sql, flags=re.S)
        assert match, f'{label}: JSON aggregate has no explicit deterministic ordering'
        order_text = match.group(1)
        assert 'pg_get_userbyid' in order_text, f'{label}: order must use the same role-name values emitted in JSON'
        normalized = re.sub(
            r"CASE WHEN [ax]\.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid\([ax]\.grantee\) END",
            'EMITTED_GRANTEE', order_text)
        normalized = re.sub(r'pg_get_userbyid\([adx]\.\w+\)', 'EMITTED_ROLE_NAME', normalized)
        assert not re.search(r'\b(?:a|x)\.grantee\b|\b(?:a|x)\.grantor\b|\bd\.defaclrole\b', normalized), (
            f'{label}: numeric role OIDs remain in aggregate ordering'
        )


if __name__ == '__main__':
    test_acl_aggregates_sort_by_emitted_role_names()
    print('restore baseline ACL ordering: PASS')
