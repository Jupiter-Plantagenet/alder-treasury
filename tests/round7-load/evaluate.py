#!/usr/bin/env python3
"""Evidence-only P6 LOAD evaluator. Missing or partial evidence never earns PASS."""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

RUN_RE = re.compile(r"^p6-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}$")
RUNS_ROOT = Path(".local/scratch-r6/runs")
EXPECTED = {"duration_s": 1800, "read_rps": 20, "write_rps": 5, "sessions": 100, "sse": 10}
LIMITS = {"read_p95_ms": 300, "write_p95_ms": 500, "error_rate_exclusive": 0.01,
          "event_at_arrival_upper_bound_p95_ms": 2000, "inp_p95_ms": 200,
          "cold_lcp_p95_ms": 2500, "rss_including_pg_chrome_mib": 8192,
          "batch_gas_used": 15_000_000, "minimum_block_gas_limit": 30_000_000}


def load_json(path: Path | None) -> Any:
    if path is None or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None


def percentile(values: list[float], q: float = .95) -> float | None:
    """Match load-summarize.py's sorted int(q*n) selection."""
    xs = sorted(values)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None


def num(value: Any) -> float | None:
    try:
        x = float(value)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def read_raw(path: Path | None) -> list[dict[str, Any]] | None:
    if path is None or not path.is_file():
        return None
    rows: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8-sig") as f:
            for line in f:
                try:
                    item = json.loads(line)
                    if isinstance(item, dict):
                        rows.append(item)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return None
    return rows


def find_artifacts(root: Path) -> dict[str, Path | None]:
    load_root = root / "load"
    metas = []
    for p in load_root.rglob("meta.json") if load_root.exists() else []:
        obj = load_json(p)
        if isinstance(obj, dict) and all(k in obj for k in ("DURATION", "READ_RPS", "WRITE_RPS")):
            metas.append(p)
    meta = metas[0] if len(metas) == 1 else None
    raw = (meta.parent / "raw.ndjson") if meta else None
    summary = (meta.parent / "summary.json") if meta else None
    resources = next(iter(sorted(load_root.rglob("resources-full.csv"))), None) if load_root.exists() else None
    if resources is None and load_root.exists():
        resources = next(iter(sorted(load_root.rglob("resources*.csv"))), None)
    vitals = None
    if root.exists():
        candidates = [p for p in root.rglob("report.json") if "vital" in str(p).lower()]
        vitals = next((p for p in sorted(candidates, key=lambda p: ("under-load" not in str(p).lower(), str(p))) if isinstance(load_json(p), dict)), None)
    receipts = [root / "setup-receipt.json", root / "load" / "setup-receipt.json"]
    receipt = next((p for p in receipts if p.is_file()), None)
    status_candidates = [root / "load" / "run-status.json", root / "run-status.json"]
    run_status = next((p for p in status_candidates if p.is_file()), None)
    diagnostic = root / "diagnostic-summary.json"
    pins = [p for p in root.glob("*source*pins*.json")] + [p for p in root.glob("*source*pin*.json")]
    wrapper = next(iter(sorted(root.glob("*wrapper-result.json"))), None)
    return {"meta": meta, "raw": raw if raw and raw.is_file() else None,
            "summary": summary if summary and summary.is_file() else None,
            "resources": resources, "vitals": vitals, "receipt": receipt,
            "run_status": run_status, "source_pins": pins[0] if pins else None,
            "wrapper_result": wrapper,
            "diagnostic_summary": diagnostic if diagnostic.is_file() else None,
            "meta_candidates": metas}


def gate(observed: str | None, details: dict[str, Any], full: bool, missing_reason: str | None = None) -> dict[str, Any]:
    if observed is None:
        return {"status": "NOT_MEASURED", "observedStatus": "NOT_MEASURED", "reason": missing_reason or "required evidence missing", **details}
    return {"status": observed if full else "NOT_MEASURED",
            "observedStatus": observed,
            **({"reason": "partial run: full-profile acceptance cannot pass"} if not full else {}), **details}


def check(predicate: bool, full: bool, **details: Any) -> dict[str, Any]:
    return gate("PASS" if predicate else "FAIL", details, full)


def parse_resource_rows(path: Path | None) -> tuple[list[dict[str, Any]] | None, list[dict[str, Any]]]:
    if path is None or not path.is_file():
        return None, []
    try:
        with path.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        return rows, rows
    except (OSError, csv.Error):
        return None, []


def find_prior_batch_smoke(root: Path, receipt: Any) -> dict[str, Any] | None:
    """Report a linked two-lane correctness smoke without conflating it with this run's load."""
    retained = receipt.get("retainedStackRun") if isinstance(receipt, dict) else None
    if not isinstance(retained, str):
        return None
    stack_load = root.parent / retained / "load"
    candidates = sorted(stack_load.rglob("meta.json")) if stack_load.is_dir() else []
    for path in candidates:
        obj = load_json(path)
        lane = obj.get("lane") if isinstance(obj, dict) else None
        if not isinstance(lane, list) or len(lane) != 2:
            continue
        checks = []
        for item in lane:
            gas, block = num(item.get("gasUsed")), num(item.get("blockGasLimit"))
            checks.append({"tag": item.get("tag"), "items": num(item.get("items")),
                "verifiedSettlements": num(item.get("verifiedSettlements")), "gasUsed": gas,
                "blockGasLimit": block,
                "passed": item.get("ok") is True and num(item.get("items")) == 100 and
                    num(item.get("verifiedSettlements")) == 100 and gas is not None and
                    gas <= LIMITS["batch_gas_used"] and block is not None and
                    block >= LIMITS["minimum_block_gas_limit"]})
        if all(x["passed"] for x in checks):
            return {"status": "PASS", "runId": retained, "path": str(path),
                    "lanes": checks, "sameMeasurementRun": False,
                    "scope": "separate transaction-correctness smoke; not full-load evidence"}
    return {"status": "NOT_MEASURED", "runId": retained,
            "reason": "no linked two-lane 100-settlement smoke met the recorded gas/block assertions"}


def evaluate(run_id: str, root: Path) -> dict[str, Any]:
    artifacts = find_artifacts(root)
    meta = load_json(artifacts["meta"])
    raw = read_raw(artifacts["raw"])
    summary = load_json(artifacts["summary"])
    vitals = load_json(artifacts["vitals"])
    receipt = load_json(artifacts["receipt"])
    run_status = load_json(artifacts["run_status"])
    wrapper_result = load_json(artifacts["wrapper_result"])
    diagnostic_summary = load_json(artifacts["diagnostic_summary"])
    resources, resource_rows = parse_resource_rows(artifacts["resources"])

    partial_shape = bool(meta and num(meta.get("DURATION")) == EXPECTED["duration_s"] and
                         num(meta.get("READ_RPS")) == EXPECTED["read_rps"] and
                         num(meta.get("WRITE_RPS")) == EXPECTED["write_rps"] and
                         num(meta.get("SESSIONS")) == EXPECTED["sessions"] and
                         num(meta.get("SSE_N")) == EXPECTED["sse"])
    has_raw_rows = raw is not None and len(raw) > 0
    raw_span_s = None
    full_window = bool(partial_shape and has_raw_rows and
                       num(summary.get("durationS")) >= EXPECTED["duration_s"] if isinstance(summary, dict) else False)
    # A missing/partial summary cannot certify the complete 1,800-second observation window.
    if has_raw_rows and raw:
        raw_span_s = (max((num(r.get("t")) or 0) for r in raw) - min((num(r.get("t")) or 0) for r in raw)) / 1000
        full_window = full_window or (partial_shape and raw_span_s >= EXPECTED["duration_s"] - 2)
    full = bool(partial_shape and full_window)
    duration = num(meta.get("DURATION")) if isinstance(meta, dict) else None
    read_rps = num(meta.get("READ_RPS")) if isinstance(meta, dict) else None
    write_rps = num(meta.get("WRITE_RPS")) if isinstance(meta, dict) else None
    expected_reads = int(duration * read_rps) if duration is not None and read_rps is not None else None
    expected_writes = int(duration * write_rps) if duration is not None and write_rps is not None else None

    gates: dict[str, Any] = {}
    gates["summary_artifact_present"] = gate("PASS" if isinstance(summary, dict) else None,
        {"path": str(artifacts["summary"]) if artifacts["summary"] else None}, full, "summary.json missing")
    gates["full_1800s_profile"] = gate("PASS" if full else "FAIL" if duration and duration >= 1800 and has_raw_rows else None,
                                        {"durationSeconds": duration, "requiredSeconds": 1800,
                                         "configuredReadRps": read_rps, "configuredWriteRps": write_rps,
                                         "sessions": meta.get("SESSIONS") if meta else None, "sseSubscribers": meta.get("SSE_N") if meta else None,
                                         "rawWindowSeconds": round(raw_span_s, 3) if has_raw_rows else None,
                                         "summaryWindowSeconds": summary.get("durationS") if isinstance(summary, dict) else None},
                                        True, "full run artifacts unavailable" if not has_raw_rows else "run is capped/partial")

    if raw is not None:
        read_rows = [r for r in raw if r.get("cls") == "read"]
        write_rows = [r for r in raw if r.get("cls") == "write"]
        rw_rows = read_rows + write_rows
        actual_read_n, actual_write_n = len(read_rows), len(write_rows)
        read_p95 = percentile([x for r in read_rows if (x := num(r.get("ms"))) is not None])
        write_p95 = percentile([x for r in write_rows if (x := num(r.get("ms"))) is not None])
        errors = sum(1 for r in rw_rows if not (200 <= (num(r.get("st")) or 0) < 300))
        err_rate = errors / len(rw_rows) if rw_rows else None
        offered = meta.get("offeredRate", {}) if isinstance(meta, dict) else {}
        rmeta, wmeta = offered.get("read", {}), offered.get("write", {})
        read_sched_count_ok = (expected_reads is not None and actual_read_n == expected_reads and
                               num(rmeta.get("scheduledSlots")) == expected_reads and
                               num(rmeta.get("issuedSlots")) == expected_reads and
                               num(rmeta.get("completedSlots")) == expected_reads and
                               num(rmeta.get("actualHttpRequestsIssued")) == expected_reads and
                               num(rmeta.get("actualHttpRequestsCompleted")) == expected_reads)
        write_sched_count_ok = (expected_writes is not None and actual_write_n == expected_writes and
                                num(wmeta.get("scheduledSlots")) == expected_writes and
                                num(wmeta.get("issuedSlots")) == expected_writes and
                                num(wmeta.get("completedSlots")) == expected_writes and
                                num(wmeta.get("actualHttpRequestsIssued")) == expected_writes and
                                num(wmeta.get("actualHttpRequestsCompleted")) == expected_writes)
        read_window = num(rmeta.get("actualIssueWindowMs")); write_window = num(wmeta.get("actualIssueWindowMs"))
        read_period = 1000 / read_rps if read_rps else None; write_period = 1000 / write_rps if write_rps else None
        read_window_ok = bool(read_window is not None and duration is not None and read_period and abs(read_window - (duration * 1000 - read_period)) <= read_period)
        write_window_ok = bool(write_window is not None and duration is not None and write_period and abs(write_window - (duration * 1000 - write_period)) <= write_period)
        exact_ok = bool(read_sched_count_ok and write_sched_count_ok and read_window_ok and write_window_ok)
        gates["exact_offered_counts_and_window"] = check(exact_ok, full, expectedReadRequests=expected_reads,
            observedReadRequests=actual_read_n, expectedWriteRequests=expected_writes, observedWriteRequests=actual_write_n,
            readWindowMs=read_window, writeWindowMs=write_window, readWindowWithinOnePeriod=read_window_ok,
            writeWindowWithinOnePeriod=write_window_ok, latenessGate="none; telemetry only")
        gates["read_p95_ms_le_300"] = check(read_p95 is not None and read_p95 <= LIMITS["read_p95_ms"], full, p95Ms=read_p95, limitMs=LIMITS["read_p95_ms"], samples=len(read_rows))
        gates["write_p95_ms_le_500"] = check(write_p95 is not None and write_p95 <= LIMITS["write_p95_ms"], full, p95Ms=write_p95, limitMs=LIMITS["write_p95_ms"], samples=len(write_rows))
        gates["read_write_error_rate_lt_0_01"] = check(err_rate is not None and err_rate < LIMITS["error_rate_exclusive"], full,
            errors=errors, requests=len(rw_rows), rate=err_rate, exclusiveLimit=LIMITS["error_rate_exclusive"])
        iso = [r for r in raw if r.get("cls") == "isolation"]
        iso_defects = sum(1 for r in iso if num(r.get("st")) != 404)
        gates["outsider_isolation_defects_zero"] = gate(None if not iso else "PASS" if iso_defects == 0 else "FAIL",
            {"requests": len(iso), "defects": iso_defects, "expectedStatus": 404}, full, "no isolation requests in raw evidence")
        successful_writes = [r for r in write_rows if 200 <= (num(r.get("st")) or 0) < 300 and r.get("ep") in
                             ("POST /payables", "POST /contacts", "POST /payables/:id/review")]
    else:
        read_rows = write_rows = rw_rows = iso = successful_writes = []
        actual_read_n = actual_write_n = errors = iso_defects = None
        read_p95 = write_p95 = err_rate = None
        gates["exact_offered_counts_and_window"] = gate(None, {}, full, "raw.ndjson missing")
        gates["read_p95_ms_le_300"] = gate(None, {}, full, "raw.ndjson missing")
        gates["write_p95_ms_le_500"] = gate(None, {}, full, "raw.ndjson missing")
        gates["read_write_error_rate_lt_0_01"] = gate(None, {}, full, "raw.ndjson missing")
        gates["outsider_isolation_defects_zero"] = gate(None, {}, full, "raw.ndjson missing")

    sse = meta.get("sseLatency", {}) if isinstance(meta, dict) else {}
    event_metric = sse.get("dbEventAtToArrivalUpperBoundMs", {})
    raw_event_values = event_metric.get("values", []) if isinstance(event_metric, dict) else []
    event_values = [x for v in raw_event_values if (x := num(v)) is not None]
    clock_nonnegative = bool(event_values) and len(event_values) == len(raw_event_values) and all(v >= 0 for v in event_values)
    event_p95 = percentile(event_values)
    event_observed = None if not event_values else "PASS" if clock_nonnegative and event_p95 is not None and event_p95 <= LIMITS["event_at_arrival_upper_bound_p95_ms"] else "FAIL"
    gates["db_event_at_to_arrival_upper_bound_p95_le_2000"] = gate(
        event_observed, {"p95Ms": event_p95, "limitMs": LIMITS["event_at_arrival_upper_bound_p95_ms"],
        "samples": len(event_values), "allClocksNonnegative": clock_nonnegative,
        "measurementDefinition": event_metric.get("definition")}, full,
        "event.at upper-bound samples missing")
    sse_n = num(meta.get("SSE_N")) if isinstance(meta, dict) else None
    gates["sse_subscribers_exactly_10"] = gate(None if sse_n is None else "PASS" if sse_n == EXPECTED["sse"] else "FAIL",
        {"observed": sse_n, "expected": EXPECTED["sse"]}, full, "SSE subscriber count missing")
    # The configured subscriber count is not proof of successful EventSource connections.
    # Runner metadata records one HTTP status per initial subscriber connection.
    sse_statuses_raw = meta.get("sseConnectionStatuses") if isinstance(meta, dict) else None
    sse_statuses = [num(x) for x in sse_statuses_raw] if isinstance(sse_statuses_raw, list) else None
    accepted_count = sum(1 for x in sse_statuses or [] if x == 200)
    statuses_complete = sse_statuses is not None and len(sse_statuses) == EXPECTED["sse"] and all(x is not None for x in sse_statuses)
    accepted_observed = None if not statuses_complete else "PASS" if accepted_count == EXPECTED["sse"] and all(x == 200 for x in sse_statuses) else "FAIL"
    gates["sse_initial_connections_10_accepted_http_200"] = gate(accepted_observed,
        {"statuses": sse_statuses, "acceptedHttp200": accepted_count,
         "expectedAccepted": EXPECTED["sse"], "expectedStatus": 200}, full,
        "per-subscriber initial SSE HTTP connection statuses missing or incomplete")
    sse_errors = num(meta.get("sseErrors")) if isinstance(meta, dict) else None
    gates["sse_connection_errors_zero"] = gate(None if sse_errors is None else "PASS" if sse_errors == 0 else "FAIL",
        {"observed": sse_errors, "limit": 0}, full, "SSE connection error counter missing")
    samples = sse.get("matchedSamples", []) if isinstance(sse, dict) else []
    matched_event_ids = {str(x.get("eventId")) for x in samples if isinstance(x, dict) and x.get("eventId") is not None}
    coverage_pairs = {(str(x.get("subscriber")), str(x.get("eventId"))) for x in samples if isinstance(x, dict) and x.get("eventId") is not None}
    expected_event_count = len(successful_writes)
    expected_pairs = expected_event_count * int(sse_n or 0)
    coverage = (len(coverage_pairs) / expected_pairs) if expected_pairs else None
    coverage_id_ratio = (len(matched_event_ids) / expected_event_count) if expected_event_count else None
    matched_subscribers = {str(x.get("subscriber")) for x in samples if isinstance(x, dict) and x.get("subscriber") is not None}
    sse_coverage_report = {"status": "NOT_MEASURED", "matchedUniqueEvents": len(matched_event_ids), "successfulLoadWritesExpected": expected_event_count,
        "subscribersWithMatchedEvents": len(matched_subscribers), "matchedSubscriberIds": sorted(matched_subscribers),
        "matchedSubscriberEventPairs": len(coverage_pairs), "expectedSubscriberEventPairs": expected_pairs or None,
        "subscriberEventCoverage": coverage, "eventIdCoverage": coverage_id_ratio,
        "threshold": "not specified; descriptive metric only"}

    # Accounting and lane evidence are run-level assertions. Missing keys stay NOT_MEASURED.
    accounting = num(meta.get("accountingDefects")) if isinstance(meta, dict) else None
    gates["accounting_defects_zero"] = gate(None if accounting is None else "PASS" if accounting == 0 else "FAIL",
        {"observed": accounting, "limit": 0}, full, "accounting defect count missing")
    lane = meta.get("lane") if isinstance(meta, dict) else None
    lane_checks = []
    if isinstance(lane, list):
        for item in lane:
            gas = num(item.get("gasUsed")); block = num(item.get("blockGasLimit"))
            settlements = num(item.get("verifiedSettlements")); items = num(item.get("items"))
            lane_checks.append({"tag": item.get("tag"), "ok": item.get("ok"), "items": items,
                "verifiedSettlements": settlements, "gasUsed": gas, "blockGasLimit": block,
                "observedPass": bool(item.get("ok") is True and items == 100 and settlements == 100 and gas is not None and gas <= LIMITS["batch_gas_used"] and block is not None and block >= LIMITS["minimum_block_gas_limit"])})
    lanes_ok = len(lane_checks) == 2 and all(x["observedPass"] for x in lane_checks)
    gates["two_100_item_lanes_verified_gas_and_block_limits"] = check(isinstance(lane, list) and lanes_ok, full,
        lanes=lane_checks, requiredLaneCount=2, gasUsedLimit=LIMITS["batch_gas_used"], blockGasLimitMinimum=LIMITS["minimum_block_gas_limit"])

    # Resource pass includes the sampled process tree (including the vitals/Chrome child tree) plus PG container use.
    resource_nums = [num(r.get("p6_process_plus_pg_mb")) for r in resource_rows or []]
    valid_resource_nums = [x for x in resource_nums if x is not None]
    resource_errors = [r.get("sample_errors", "") for r in resource_rows or [] if str(r.get("sample_errors", "")).strip()]
    rss_max = max(valid_resource_nums) if valid_resource_nums else None
    resource_times = [r.get("utc") for r in resource_rows or [] if r.get("utc")]
    resource_coverage = None
    if resource_times and isinstance(meta, dict):
        try:
            from datetime import datetime
            lo = datetime.fromisoformat(meta["start"].replace("Z", "+00:00"))
            hi = datetime.fromisoformat(meta["end"].replace("Z", "+00:00"))
            rt = [datetime.fromisoformat(x.replace("Z", "+00:00")) for x in resource_times]
            resource_coverage = {"samples": len(rt), "startOffsetSeconds": round((min(rt)-lo).total_seconds(), 2),
                                 "endOffsetSeconds": round((max(rt)-hi).total_seconds(), 2), "sampleErrors": len(resource_errors)}
        except (ValueError, KeyError, TypeError):
            pass
    resource_complete = bool(full and valid_resource_nums and not resource_errors and resource_coverage and
                             resource_coverage["startOffsetSeconds"] <= 10 and resource_coverage["endOffsetSeconds"] >= 0)
    resource_observed = "FAIL" if rss_max is not None and rss_max > LIMITS["rss_including_pg_chrome_mib"] else "PASS" if resource_complete else None
    gates["peak_rss_including_postgres_and_chrome_le_8192_mib"] = gate(resource_observed,
        {"peakCombinedRssMiB": rss_max, "limitMiB": LIMITS["rss_including_pg_chrome_mib"], "samples": len(valid_resource_nums),
         "resourceCoverage": resource_coverage, "sampleErrors": resource_errors[:20],
         "measure": "p6_process_plus_pg_mb; process tree includes vitals/Chrome descendants; PG container working set added"}, full,
        "resource telemetry missing, incomplete, errored, or not full-window")

    # Vitals remain separate evidence; a preflight must never satisfy a during/full-load UX gate.
    vs = vitals.get("summary", {}) if isinstance(vitals, dict) else {}
    vitals_under_load = bool(artifacts["vitals"] and "under-load" in str(artifacts["vitals"]).lower())
    inp = num(vs.get("inpP95")) if vitals_under_load else None
    lcp = num(vs.get("lcpP95")) if vitals_under_load else None
    gates["vitals_report_is_under_load"] = gate("PASS" if vitals_under_load else None,
        {"path": str(artifacts["vitals"]) if artifacts["vitals"] else None}, full, "during-load vitals report missing; preflight is not a substitute")
    gates["inp_p95_le_200_ms"] = check(inp is not None and inp <= LIMITS["inp_p95_ms"], full, p95Ms=inp, limitMs=LIMITS["inp_p95_ms"], runs=vs.get("runs"))
    gates["cold_lcp_p95_le_2500_ms"] = check(lcp is not None and lcp <= LIMITS["cold_lcp_p95_ms"], full, p95Ms=lcp, limitMs=LIMITS["cold_lcp_p95_ms"], runs=vs.get("runs"))

    source_pin_obj = load_json(artifacts["source_pins"])
    pin_count = len(source_pin_obj) if isinstance(source_pin_obj, dict) else None
    source_hashes = source_pin_obj if isinstance(source_pin_obj, dict) else {}
    gates["source_pin_artifact_present"] = gate("PASS" if pin_count else None,
        {"path": str(artifacts["source_pins"]) if artifacts["source_pins"] else None,
         "pinnedFileCount": pin_count, "pinsReadOnly": True}, full, "source pin artifact missing")
    source_changes = wrapper_result.get("source_changed") if isinstance(wrapper_result, dict) else None
    if source_changes is None and isinstance(diagnostic_summary, dict):
        source_changes = diagnostic_summary.get("sourceChanged")
    gates["source_unchanged_during_run"] = gate(None if not isinstance(source_changes, list) else "PASS" if not source_changes else "FAIL",
        {"sourceChanged": source_changes, "wrapperResultPath": str(artifacts["wrapper_result"]) if artifacts["wrapper_result"] else None},
        full, "wrapper source-change evidence missing")
    receipt_matches = bool(isinstance(receipt, dict) and (receipt.get("measurementRun") == run_id or receipt.get("run") == run_id or receipt.get("retainedStackRun") == run_id))
    gates["setup_receipt_present_and_linked"] = gate("PASS" if receipt_matches else None,
        {"path": str(artifacts["receipt"]) if artifacts["receipt"] else None,
         "measurementRun": receipt.get("measurementRun") if isinstance(receipt, dict) else None,
         "retainedStackRun": receipt.get("retainedStackRun") if isinstance(receipt, dict) else None,
         "run": receipt.get("run") if isinstance(receipt, dict) else None}, full,
        "setup receipt missing or not linked to this measurement/retained stack")

    if isinstance(run_status, dict):
        exits = [run_status.get(k) for k in ("load_exit", "probe_exit", "sampler_exit", "summary_exit")]
        completed = all(isinstance(x, (int, float)) and x == 0 for x in exits)
        gates["run_processes_completed_cleanly"] = check(completed, full, exitCodes=dict(zip(("load", "probe", "sampler", "summary"), exits)),
            interrupted=run_status.get("interrupted"), cleanupReason=run_status.get("cleanup_reason"))
    else:
        gates["run_processes_completed_cleanly"] = gate(None, {}, full, "run-status.json missing")

    correctness_evidence = {"outsider_isolation_defects_zero", "sse_subscribers_exactly_10",
        "sse_initial_connections_10_accepted_http_200", "sse_connection_errors_zero",
        "accounting_defects_zero", "two_100_item_lanes_verified_gas_and_block_limits",
        "source_pin_artifact_present", "source_unchanged_during_run", "setup_receipt_present_and_linked",
        "run_processes_completed_cleanly"}
    for name, item in gates.items():
        item["category"] = "correctness_and_provenance_evidence" if name in correctness_evidence else "advisory_performance_capacity_or_recovery_speed"
    any_observed_miss = any(x.get("observedStatus") == "FAIL" for x in gates.values())
    all_measured_pass = all(x.get("observedStatus") == "PASS" for x in gates.values())
    overall = "ADVISORY_MISSES" if any_observed_miss else "ADVISORY_WITHIN_TARGETS" if full and all_measured_pass else "ADVISORY_NOT_MEASURED"
    prior_batch_smoke = find_prior_batch_smoke(root, receipt)
    paths = {k: str(v) if v else None for k, v in artifacts.items() if k != "meta_candidates"}
    return {"schema": "alder.p6-load-evaluation/v1", "runId": run_id,
            "classification": "FULL_1800S" if full else "PARTIAL_OR_INCOMPLETE",
            "acceptanceMode": "ADVISORY_ONLY", "overall": overall, "limits": LIMITS, "gates": gates,
            "policy": "docs/acceptance-policy-20261103.md",
            "measurementProfile": (diagnostic_summary.get("profile") if isinstance(diagnostic_summary, dict) else
                                    "full-reference-candidate" if full else "partial/incomplete; profile not evidenced"),
            "referenceBenchmark": full,
            "diagnosticSummary": diagnostic_summary,
            "metrics": {"readRequests": actual_read_n, "writeRequests": actual_write_n,
                        "readP95Ms": read_p95, "writeP95Ms": write_p95, "readWriteErrorRate": err_rate,
                        "sseEventAtArrivalUpperBoundP95Ms": event_p95, "sseMatchedCoverage": sse_coverage_report,
                        "peakCombinedRssMiB": rss_max, "accountingDefects": accounting,
                        "isolationDefects": iso_defects, "outsiderLeakResponses": iso_defects,
                        "sourcePinCount": pin_count},
            "artifacts": paths, "sourcePins": source_hashes, "vitalsReportIsUnderLoad": vitals_under_load,
            "setupReceipt": ({k: receipt.get(k) for k in ("run", "measurementRun", "retainedStackRun", "tables", "chain_head", "resourceProfile") if k in receipt}
                             if isinstance(receipt, dict) else None),
            "supplementalEvidence": {"priorTwoLaneBatchSmoke": prior_batch_smoke},
            "notes": ["Load, latency, capacity, hardware and recovery-speed outcomes are advisory and are not portfolio-completion blockers under the selected policy.",
                      "A partial or incomplete run cannot be an advisory full-profile PASS; observed metrics and misses remain reported as diagnostics.",
                      "Matched SSE coverage is descriptive because no acceptance threshold is defined.",
                      "event.at is inserted before commit; event.at-to-arrival is treated only as a conservative commit-to-arrival upper bound."]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_id", help="P6 run ID, e.g. p6-20261103T101837Z-capped")
    ap.add_argument("--runs-root", type=Path, default=RUNS_ROOT, help="runs directory (default: .local/scratch-r6/runs)")
    ap.add_argument("--output", type=Path, help="evaluation JSON path; default is <run-root>/load-evaluation.json")
    args = ap.parse_args()
    if not RUN_RE.fullmatch(args.run_id):
        ap.error("run_id must look like p6-YYYYMMDDTHHMMSSZ-suffix")
    root = (args.runs_root / args.run_id).resolve()
    base = args.runs_root.resolve()
    if root == base or base not in root.parents:
        ap.error("run path must stay under runs root")
    result = evaluate(args.run_id, root)
    output = args.output or (root / "load-evaluation.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"runId": args.run_id, "classification": result["classification"], "overall": result["overall"],
                      "evaluation": str(output), "gates": {k: v["status"] for k, v in result["gates"].items()}}, indent=2))
    return 0 if result["overall"] == "PASS" else 1 if result["overall"] == "FAIL" else 2


if __name__ == "__main__":
    sys.exit(main())
