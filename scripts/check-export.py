import json, os
d = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'data.json')))
print('Summary keys:', list(d['summary'].keys()))
sys_exp = d['summary'].get('systemic_exposure') or []
print(f'Systemic exposures: {len(sys_exp)}')
for s in sys_exp[:10]:
    print(f'  {s["asset"]:<25} {s["chain"]:<10} ${s["usd"]/1e6:>8.2f}M ({s["rows"]} rows)')
print()
# Check one whale's positions have exposure_tree
for wname, w in d['whales'].items():
    secexp = w.get('secondary_exposure') or {}
    by_token = secexp.get('by_token', [])[:5]
    by_proto = secexp.get('by_protocol', [])[:5]
    print(f'--- {wname}: {len(w["positions"])} positions ---')
    print('  by_token:', [(t["label"], f"${t['usd']/1e6:.1f}M") for t in by_token])
    print('  by_protocol:', [(t["label"], f"${t['usd']/1e6:.1f}M") for t in by_proto])
    # Pick a position with exposure_tree
    for p in w['positions']:
        tree = p.get('exposure_tree') or []
        if len(tree) > 3:
            print(f'  sample position: {p["protocol_name"]} {p["chain"]} ${p["net_usd"]/1e6:.2f}M, tree has {len(tree)} rows')
            for row in tree[:8]:
                indent = '    ' + '  '*row['depth']
                pct = f"{row['pct_of_parent']:.1f}%" if row.get('pct_of_parent') is not None else ''
                print(f'{indent}{row["kind"]:<18} {row["asset_symbol"] or row["venue"] or "":<30} ${row["usd"]/1e6:.2f}M {pct}')
            break
    break
