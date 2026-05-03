# Coding agent instructions — protocol-yield-tracker-dev

You are the coding agent for **protocol-yield-tracker-dev** ("protocol yield scanner").

## Working clone
Always use this folder as your working copy:
`/Users/bubba/code/protocol-yield-tracker-dev`

Do NOT use bub2's live repo folder as a working copy:
`/Users/bubba/.openclaw/bub2-data/workspace/protocol-yield-tracker-dev`

## GitHub remote
`https://github.com/bubbamacxtxt-cyber/protocol-yield-tracker-dev.git`

GitHub auth is already set up on the host as `bubbamacxtxt-cyber` via HTTPS. Use existing host auth — do not invent a new credential flow.

## Dev-only rule
Only change and dev-test in the **dev** repo/workflow unless Bubba explicitly says "prod".

## Frontend validation / deployment reality
The real frontend preview for development is **GitHub Pages from `main` of `protocol-yield-tracker-dev`**.

Important:
- A PR by itself does **not** update the dev GitHub Pages site.
- The dev frontend updates only after the PR is **merged into `main`** of the dev repo.
- Use PRs as a review/safety checkpoint, not as the live preview itself.
- For frontend tasks, verify locally first when possible, then treat the merged dev `main` Pages site as the real preview target.

## Two-bot memory system
This project is worked on by coding agents and bub2. We share memory via files on disk so each bot can catch up on what the other did.

### Start-of-session catch-up
Do this at the start of every session, and anytime Bubba says "catch up":
- Read today's bub2 daily note:
  `/Users/bubba/.openclaw/bub2-data/workspace/memory/YYYY-MM-DD.md`
- Read the canonical repo note:
  `/Users/bubba/.openclaw/bub2-data/workspace/life/Resources/repos/protocol-yield-tracker.md`
- Run `git status` and `git log -10 --oneline` in `/Users/bubba/code/protocol-yield-tracker-dev`.
- Summarize current state + next task in 5 bullets.

If today's note is thin or missing context, also read yesterday's note.

### Memory files
- **Today's bub2 daily note:** `/Users/bubba/.openclaw/bub2-data/workspace/memory/YYYY-MM-DD.md` (use today's actual date)
- **Canonical repo note:** `/Users/bubba/.openclaw/bub2-data/workspace/life/Resources/repos/protocol-yield-tracker.md`

### End-of-session handoff
Every time you finish work, append a section titled **`Codex handoff`** to today's bub2 daily note:
`/Users/bubba/.openclaw/bub2-data/workspace/memory/YYYY-MM-DD.md`

Include:
- what changed + why
- commands run
- commit hash / PR link, if any
- what to do next

Use this format for Codex:

```md
## Codex handoff - YYYY-MM-DD HH:MM TZ

### What changed / why
- ...

### Commands run
- ...

### Commit hash / PR
- ...

### What bub2 should do next
- ...
```

Claude Code may use this format:

```md
## Claude Code handoff - YYYY-MM-DD HH:MM TZ

### What I changed
- ...

### Files changed
- path/to/file

### Commits
- abc1234 message

### Key findings
- ...

### Blockers / warnings
- ...

### Recommended next steps
- ...
```

### What the user's commands mean
- **"Read the memory file"** → read today's bub2 daily note + canonical repo note to catch up
- **"Save to memory"** → append the Claude Code handoff block to today's bub2 daily note

## Pre-flight checklist (MANDATORY before any code change)
Before writing ANY code, do ALL of these:

1. **Check what already works.** Look at the live site / current data.json / current output FIRST. Don't assume something is broken or missing without verifying.
2. **Say it back.** Tell Bubba in plain English: "The fix is [X], I'm changing [Y file], it's ~[N] lines." Wait for confirmation before writing code.
3. **If the fix is more than ~30 lines, stop.** Ask Bubba if that scope seems right. A "label change" should not turn into an architecture redesign.
4. **Minimal change bias.** The default is ALWAYS the smallest possible fix. If you think you need a new API integration, new data pipeline, or architectural change — that's a red flag. Raise it with Bubba first, don't just go build it.
5. **Listen to what Bubba is actually asking.** If he says "the label is wrong," fix the label. Don't redesign the system that produces the label. Re-read the request if you're unsure.

## Hard rules
- Do NOT write directly to `/Users/bubba/.openclaw/bub2-data/workspace/MEMORY.md` unless explicitly asked
- Do NOT use bub2's live repo folder as your normal working copy
- Do NOT treat chat history as the durable source of truth — always read the memory files
- Do NOT skip reading memory + commits before starting if continuity matters
- Do NOT build new integrations or pipelines without explicit approval — fix with what's already there first
