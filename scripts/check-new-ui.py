import json, os
d = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'data.json')))
print('data.json whales:', list(d['whales'].keys()))
print()
# Check each whale
for name, w in d['whales'].items():
    er = w.get('exposure_rollup')
    pos_with_tree = sum(1 for p in w.get('positions', []) if p.get('exposure_tree'))
    total = len(w.get('positions', []))
    print(f'{name:<15} positions={total:>3} with_tree={pos_with_tree:>3} rollup?{"Y" if er else "N"}')
    if er:
        print(f'  by_protocol top3:', [(t['label'], f"${t['usd']/1e6:.1f}M") for t in er['by_protocol'][:3]])
        print(f'  by_token top3:   ', [(t['label'], f"${t['usd']/1e6:.1f}M") for t in er['by_token'][:3]])
        print(f'  by_market top3:  ', [(t['label'], f"${t['usd']/1e6:.1f}M") for t in er['by_market'][:3]])
    # Check for stale fields
    stale = [k for k in ['secondary_exposure'] if k in w]
    if stale:
        print(f'  STALE FIELDS:', stale)
    for p in w.get('positions', [])[:1]:
        if p.get('lookthrough') is not None:
            print(f'  STALE p.lookthrough found')
