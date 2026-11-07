# Alder Treasury

Exact multisig payment authorization and independent settlement reconciliation.

A treasury application must bind the obligations being approved to the exact transfers a wallet authorizes, and establish what settled before closing the corresponding payable records.

Built from scratch as a local research software engineering project. The implementation includes application code, tests, and documented experiments.

## Engineering scope

Solidity, Foundry tests, transaction identity, exact token effects, replay rejection, and reconciliation between chain state and private business records.

A Safe quorum authorizes exact bounded operations. The executor binds chain, token, recipients, time window, and authority. The backend keeps durable attempts and reservations, while separate indexing and verification code reconcile canonical effects and handle replaced chain history.

## Review the work

- [Reproduce the focused checks](docs/reproduction.md)
- [Trace claims to implementation and tests](REVIEWER_GUIDE.md)
- [Inspect current verification and remaining setup work](docs/verification.md)
- [Watch the one-minute application walkthrough](docs/demos/alder-walkthrough.mp4)
- [Read the recorded project results](docs/acceptance-portfolio-ready-20261103.md)

## Repository layout

`contracts/src/` and `contracts/test/` contain Solidity and Foundry tests. `apps/api/` and `apps/web/` contain the application. `services/` contains indexing and verification. `packages/` contains shared code. `db/` contains SQL. `tests/round6-repro/` contains the isolated Linux replay tooling. `vendor/` retains Safe source and attribution.

## Recorded result

The existing isolated payout report records three exact local transfers and zero duplicate effects after resynchronization. The portfolio packet still lists final independent approval and companion-manifest binding as pending. Local depth 12 is the test deployment confirmation policy.

The recorded experiment reports describe the original development runs. The publication candidate has its own verification record, linked above, with the commands executed against this copy.

## Start here

Follow [the reproduction guide](docs/reproduction.md) to install the pinned dependencies, run the focused tests, and build the web application. The guide identifies the extra infrastructure and private inputs needed for larger experiments.

Third-party source retains its original copyright and license notices. A repository-wide distribution license is pending the author's publication review.
