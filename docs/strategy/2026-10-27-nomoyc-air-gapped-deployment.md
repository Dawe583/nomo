# AI for the Air-Gapped Economy: product and readiness plan

> Stage: later deployment option. No customer has presented a written no-egress requirement or committed budget. A local model is not automatically air-gapped.

## What the promise means

A true air-gapped deployment has no network path to an external service during use. This includes model inference, telemetry, analytics, crash reporting, licensing checks, update checks, remote support, documentation fetches, and dependency downloads. Define the exact system boundary and test it with the customer.

Distinguish four profiles in sales and contracts:

1. **Approved managed API:** data crosses to a named service under the customer's approved settings and contract.
2. **Customer VPC or private cloud:** customer controls network boundaries, but the system remains connected and the vendor may have operational access.
3. **On-premises connected:** the customer hosts the runtime, but approved outbound services or update channels may exist.
4. **Air-gapped:** external network egress is blocked and offline operation is proven.

Do not use "private", "local", "on-prem", "customer-hosted", and "air-gapped" as synonyms.

## Product customer

Likely buyers include organizations with a written policy that prevents external model calls for a named class of work. The actual user may be a local operator. A security owner, infrastructure owner, model owner, data owner, procurement, and budget owner all affect approval. The buyer must describe the prohibited routes precisely and own the production network test.

Regulated industry alone is not enough. A bank, hospital, or manufacturer may already allow approved cloud services, while a less regulated company may ban all egress. Ask what is forbidden and why.

## Build only after these demand gates

- A qualified buyer provides the written no-egress requirement and identifies the approver.
- A paid pilot is funded with source data, use case, and success criteria.
- The workflow has already passed a read-only quality and value gate in an acceptable environment.
- The contract supports offline software/model delivery and defines customer and vendor support duties.
- Expected contract value pays for packaging, model validation, hardware, security review, updates, and ongoing support.

Without these, test approved API, customer VPC, or on-prem separately. Do not build an offline platform speculatively.

## Minimum engineering scope

- Reproducible signed install bundle containing runtime, model artifacts, dependencies, licence notices, and software bill of materials.
- Customer-held or customer-approved keys. Document key rotation, revocation, bootstrap, and recovery.
- No optional or hidden external network calls. Enforce outbound allow/deny at host and network layers.
- Local model routing with no automatic cloud fallback. Configuration drift fails closed.
- Offline source ingestion, evaluation, update, backup, restore, audit export, and administrator workflow.
- Signed update media, provenance verification, rollback, and compatibility matrix.
- Hardware reference profile with measured throughput, memory, concurrency, latency, storage, and temperature under representative workloads.
- Local monitoring with approved export controls. Do not ship content-bearing telemetry by default.
- Incident response, support access, replacement media, data deletion, recovery, and end-of-contract procedures.
- Model and dependency licence review for commercial offline distribution and permitted updates.

## Acceptance test

1. Disconnect or physically block external routes, DNS, proxies, and optional radios as agreed.
2. Start the complete system from the signed offline bundle.
3. Run the selected workflow, source retrieval, evaluation, approval, and local audit paths.
4. Capture firewall counters and packet evidence. Confirm zero unauthorized egress across idle, normal, error, restart, update-check, and telemetry states.
5. Verify model version, source version, binary signatures, SBOM, and policy configuration.
6. Restore from backup, apply a signed update offline, reject a modified bundle, and roll back.
7. Export an audit package using customer-controlled media.
8. Have the customer's security owner witness and sign the boundary result.

A passing test is limited to the exact hardware, version, configuration, and network boundary. Do not generalize one customer test into a universal no-egress claim.

## NOMO responsibilities

NOMO may enforce local agent identity, policy, approval, operation lifecycle, and local ledger verification. A local JSONL ledger or local process does not establish a distributed fleet, tamper-proof record, independent signer, hardware security, or air-gap. Customer-controlled local signing keys and independent verification should be evaluated.

The TUI may support the local operator, but offline usability must include installation, update, backup, restore, incident response, and evidence export, not just a terminal dashboard.

## Economics and support

Estimate the fully loaded cost per customer: installation, model validation, hardware, integration, security review, offline release cadence, customer support, incident response, and renewal. Charge separately for offline deployment only if a buyer recognizes its value and accepts a sustainable support contract. Do not quote a fixed air-gap price before measuring an actual deployment.

## Positioning boundary

Say: "This tested deployment runs without external network access on the documented hardware and release." Only say it after the witnessed test.

Do not say: "Your data never leaves" without defining logs, backup, support, model artifacts, and physical media. Do not say "air-gapped" for a local model that can reach an API, download updates, or send telemetry.
