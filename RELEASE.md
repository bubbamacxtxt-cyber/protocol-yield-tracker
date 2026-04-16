# Release Runbook: Dev → Prod

## Rule: Ship the whole repo
When releasing from dev to prod, replace the **entire** prod repo contents with the fully tested dev repo state. Do not cherry-pick individual files.

## Why
Partial sync causes drift between workflow, schema, export logic, and HTML. Shipping the whole repo prevents this.

## Steps

### 1. Verify dev is ready
- [ ] All changes tested locally
- [ ] Dev site (`protocol-yield-tracker-dev` Pages) shows correct data
- [ ] No broken links, no console errors
- [ ] Workflows tested (if changed)

### 2. Copy dev to prod
```bash
# From dev repo working tree
cd /home/node/.openclaw/workspace/protocol-yield-tracker-dev

# Sync prod repo contents (excluding .git)
rsync -av --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='yield-tracker.db' \
  . /home/node/.openclaw/workspace/protocol-yield-tracker/
```

### 3. Commit and push to prod
```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker
git add -A
git commit -m "release: dev → prod [DATE]"
git push origin main
```

### 4. Verify prod
- [ ] Prod site (`protocol-yield-tracker` Pages) loads correctly
- [ ] Data is current
- [ ] Workflows still running

### 5. Do not sync back
There is **no auto-sync** from prod to dev. If prod gets a manual emergency fix, record it and apply deliberately.
