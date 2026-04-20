# TOOLING_GOTCHAS

## 2026-04-20 Euler position discovery

- Goldsky Euler subgraphs were fine for vault registry reads, but account-level reads were not reliable for this workflow.
- `accountAggrVaults` did not expose the fields the scanner expected, and forcing subgraph account queries led to empty or misleading results.
- Reliable pattern:
  1. use Euler indexer `https://indexer.euler.finance/v2/vault/list?chainId=...&take=1000` for vault registry
  2. use Alchemy `alchemy_getTokenBalances` per wallet/chain
  3. intersect wallet token balances with Euler vault addresses
  4. write one position per held vault
- Keep wallet matching case-insensitive when cleaning/replacing prior scanner output, or old mixed-case rows will survive as ghosts.
- Current enabled Alchemy-backed Euler chains in scanner: eth, base, arb, sonic, op. Monad and Berachain endpoints are wired but depend on network enablement in Alchemy.
