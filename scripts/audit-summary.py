import json, os
p = os.path.join(os.path.dirname(__file__), '..', 'data', 'exposure-audit.json')
a = json.load(open(p))
print(f'Coverage: {a["coverage_pct"]}%')
print(f'Total: ${a["total_value"]/1e6:.1f}M  Decomposed: ${a["decomposed_value"]/1e6:.1f}M')
print(f'Opaque: ${a["opaque_offchain_value"]/1e6:.1f}M  Unknown: ${a["unknown_value"]/1e6:.1f}M')
print(f'Confidence: high=${a["by_confidence"]["high"]/1e6:.1f}M, medium=${a["by_confidence"]["medium"]/1e6:.1f}M, low=${a["by_confidence"]["low"]/1e6:.1f}M')
print()
print('By adapter:')
for k,v in sorted(a['by_adapter'].items(), key=lambda x:-x[1]['value']):
    print(f'  {k:<15} ${v["value"]/1e6:>7.1f}M  {v["positions"]} pos')
print()
print('Top 10 systemic exposures:')
for r in a['top_systemic_exposures'][:10]:
    print(f'  {r["asset_symbol"]:<25} {r["chain"]:<10} ${r["total_usd"]/1e6:>8.2f}M ({r["row_count"]} rows)')
print()
print(f'Acceptance: {a["acceptance"]}')
