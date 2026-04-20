# Dev Build Cleanup Checklist

_Updated: 2026-04-20_

This checklist turns the DeBank replacement plan into a concrete cleanup pass for the current `protocol-yield-tracker-dev` build.

Use this document to track structural cleanup before or alongside new scanner work.

## Goal

Make the dev build internally consistent so future protocol work lands on a clean source model.

Specifically:

- one canonical architecture doc
- explicit source typing
- clear distinction between scanner / protocol API / manual / DeBank fallback
- source-aware validation
- fewer misleading comments, names, and files

## 1. Canonical docs cleanup

### Done now

- [x] Add obsolete banner to `docs/hybrid-architecture.md`
- [x] Add obsolete banner to `docs/scanner-architecture-v2.md`
- [x] Create canonical plan at `docs/debank-replacement-plan.md`

### Remaining

- [ ] Update `docs/IMPROVEMENTS.md` so it points to `docs/debank-replacement-plan.md`
- [ ] Add a short section to README or top-level docs explaining source types
- [ ] Remove or archive outdated claims about Alchemy-first discovery and DeBank-as-core

## 2. Source typing schema

Current issue:

- API-derived positions and true manual/off-chain positions are both often marked `manual: true`
- this causes conceptual drift in export, validation, and planning

## Proposed source fields

Add these fields to all generated positions:

```json
{
  "source_type": "scanner | protocol_api | manual | debank",
  "source_name": "aave-scanner | morpho-scanner | infinifi-api | anzen-api | re-chainlink | fetch.js",
  "discovery_type": "onchain | offchain | mixed"
}
```

### Rules

- `manual: true` only for true manual/off-chain positions
- `source_type: "protocol_api"` for positions fetched from project/protocol APIs
- `source_type: "scanner"` for scanner-produced on-chain positions
- `source_type: "debank"` for fallback/broad-scan positions

### Concrete file targets

- [ ] `src/fetch-infinifi.js`
- [ ] `src/fetch-anzen.js`
- [ ] `src/fetch-pareto.js`
- [ ] `src/fetch-re.js`
- [ ] `src/aave-scanner.js`
- [ ] `src/morpho-scanner.js`
- [ ] `src/euler-scanner.js`
- [ ] `src/fetch.js`
- [ ] `src/export.js`
- [ ] `src/validate.js`

## 3. Reclassify current generators correctly

## Keep as scanner / on-chain source

- [ ] `src/aave-scanner.js`
- [ ] `src/morpho-scanner.js`
- [ ] `src/euler-scanner.js`

## Keep as protocol API source

These are not “manual” even if they currently write into manual storage.

- [ ] `src/fetch-infinifi.js`
- [ ] `src/fetch-pareto.js`
- [ ] `src/fetch-re.js` for its on-chain and external-derived parts
- [ ] `src/fetch-anzen.js` for API-derived deal metadata, while still marking positions off-chain/manual in discovery terms

## Keep as true manual/off-chain lane

- [ ] `data/manual-positions.json`
- [ ] any entries with `wallet: "off-chain"`
- [ ] explicitly manual overrides or analyst-maintained positions

## 4. Storage cleanup

Current issue:

`manual-positions.json` is acting as a mixed storage bucket for:

- true off-chain/manual positions
- protocol API-derived positions
- generated positions from custom fetchers

## Recommended target structure

Option A, minimal change:

- keep `manual-positions.json`
- add `source_type`, `source_name`, `discovery_type`
- stop relying on `manual: true` as the only indicator

Option B, cleaner change:

- split into:
  - `data/source/manual-positions.json`
  - `data/source/protocol-api-positions.json`
- merge them in export

### Recommendation

Start with **Option A** for lower risk, then consider Option B after scanner migration stabilizes.

### Tasks

- [ ] Decide Option A vs Option B
- [ ] If Option A, update export and validation to use source fields
- [ ] If Option B, add new storage files and merge logic

## 5. Validation cleanup

Current issue:

`src/validate.js` uses whale-name exceptions:

- `InfiniFi`
- `Anzen`
- `Pareto`
- `Re Protocol`

That is brittle.

## Replace with source-aware rules

Validation should work from position metadata, not whale names.

### Proposed rule set

- DB-backed totals only apply to `source_type in (scanner, debank)`
- off-chain/manual totals should be validated by source freshness + schema, not DB parity
- mixed entities should validate per source slice, not as one total bucket

### Tasks

- [ ] add source-aware validation paths to `src/validate.js`
- [ ] remove whale-name skip list once source fields exist
- [ ] add stale-manual-data warning rules

## 6. Workflow cleanup

Current issue:

`.github/workflows/update.yml` comments no longer match the real architecture.

## Tasks

- [ ] update comments to distinguish:
  - DeBank broad scan
  - protocol scanners
  - custom protocol/API generators
  - export / validation
- [ ] document authoritative source expectations per protocol group
- [ ] consider moving source classification into a checked-in config file rather than workflow comments

## 7. Add source ownership config

We need one config file that says which source owns which protocol or exposure.

## Proposed file

`data/source-policy.json`

Example:

```json
{
  "Aave V3": {
    "owner": "aave-scanner",
    "source_type": "scanner",
    "fallback": ["debank"]
  },
  "Morpho": {
    "owner": "morpho-scanner",
    "source_type": "scanner",
    "fallback": ["debank"]
  },
  "Anzen": {
    "owner": "fetch-anzen",
    "source_type": "manual",
    "discovery_type": "offchain"
  }
}
```

### Tasks

- [ ] create `data/source-policy.json`
- [ ] wire export to optionally consult it
- [ ] wire validation to use it
- [ ] use it to replace whale-name special casing

## 8. Script classification review

These files look like mixed production/dev/experiment territory and should be classified.

## Review list

- [ ] `src/hybrid-scanner.js`
- [ ] `src/wallet-scanner.js`
- [ ] `src/vault-discoverer.js`
- [ ] `src/scan-whale.js`
- [ ] `src/scan-makina.js`
- [ ] `src/build-token-list.js`
- [ ] `src/export-vaults.js`
- [ ] `src/dedup-wallet-tokens.js`

For each file, assign one label:

- `production`
- `dev-utility`
- `archive`

## 9. Concrete refactor order

Recommended order of execution:

1. [ ] Add source fields to all producers
2. [ ] Update `export.js` to preserve and use source fields
3. [ ] Update `validate.js` to use source fields instead of whale-name exceptions
4. [ ] Create `data/source-policy.json`
5. [ ] Update workflow comments / architecture notes
6. [ ] Classify ambiguous scripts
7. [ ] Archive or label old experiments
8. [ ] Begin next scanner implementation work

## 10. Definition of cleaned-up dev build

The cleanup pass is complete when:

- every position has explicit source metadata
- `manual: true` only means true manual/off-chain
- validation is source-aware
- stale docs are clearly obsolete
- script roles are classified
- source ownership is documented in one place

## Suggested immediate next coding task after cleanup

Once the cleanup above is in place, the next build task should be:

- **Ethena scanner**, because it is high-value and fits the scanner-first architecture cleanly
