# Alder Treasury engineering overview

A treasury application must bind the obligations being approved to the exact transfers a wallet authorizes, and establish what settled before closing the corresponding payable records.

A Safe quorum authorizes exact bounded operations. The executor binds chain, token, recipients, time window, and authority. The backend keeps durable attempts and reservations, while separate indexing and verification code reconcile canonical effects and handle replaced chain history.

## Source map

`contracts/src/` and `contracts/test/` contain Solidity and Foundry tests. `apps/api/` and `apps/web/` contain the application. `services/` contains indexing and verification. `packages/` contains shared code. `db/` contains SQL. `tests/round6-repro/` contains the isolated Linux replay tooling. `vendor/` retains Safe source and attribution.

[The reviewer guide](../REVIEWER_GUIDE.md) maps the claims to concrete tests and expected outputs.

## Repository byte integrity

Git preserves the raw source, vendor, and fixture bytes used by the provenance checks. Shell scripts use LF line endings across platforms. Runtime state and dependency installations are ignored.
