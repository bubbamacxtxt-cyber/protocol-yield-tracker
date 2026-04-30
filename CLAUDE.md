# Claude Code — protocol-yield-tracker-dev

## Working clone
Always use this folder as your working copy:
`/Users/bubba/code/protocol-yield-tracker-dev`

Do NOT use bub2's live repo folder as a working copy:
`/Users/bubba/.openclaw/bub2-data/workspace/protocol-yield-tracker-dev`

## GitHub remote
`https://github.com/bubbamacxtxt-cyber/protocol-yield-tracker-dev.git`

GitHub auth is already set up on the host as `bubbamacxtxt-cyber` via HTTPS. Use existing host auth — do not invent a new credential flow.

## Frontend validation / deployment reality
The real frontend preview for development is **GitHub Pages from `main` of `protocol-yield-tracker-dev`**.

Important:
- A PR by itself does **not** update the dev GitHub Pages site.
- The dev frontend updates only after the PR is **merged into `main`** of the dev repo.
- Use PRs as a review/safety checkpoint, not as the live preview itself.
- For frontend tasks, verify locally first when possible, then treat the merged dev `main` Pages site as the real preview target.

## Two-bot memory system
This project is worked on by two bots: Claude Code (you) and bub2. We share memory via files on disk so each bot can catch up on what the other did.

### Before starting any session — read memory
Read these files to get current context:
- **Today's bub2 daily note:** `/Users/bubba/.openclaw/bub2-data/workspace/memory/YYYY-MM-DD.md` (use today's actual date)
- **Canonical repo note:** `/Users/bubba/.openclaw/bub2-data/workspace/life/Resources/repos/protocol-yield-tracker.md`

If today's note is thin or missing context, also read yesterday's note.

### After finishing any session — save handoff
Append a handoff block to today's bub2 daily note:
`/Users/bubba/.openclaw/bub2-data/workspace/memory/YYYY-MM-DD.md`

Use this exact format:

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

## Hard rules
- Do NOT write directly to `/Users/bubba/.openclaw/bub2-data/workspace/MEMORY.md` unless explicitly asked
- Do NOT use bub2's live repo folder as your normal working copy
- Do NOT treat chat history as the durable source of truth — always read the memory files
- Do NOT skip reading memory + commits before starting if continuity matters
