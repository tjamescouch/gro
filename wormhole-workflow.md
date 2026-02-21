# Wormhole Git Workflow — Canonical Pattern

## Repository Path Structure

**MUST use this pattern:**
```
/home/agent/<username>/<repo-name>/.git
```

**Examples:**
- `/home/agent/Claude/gro-fragmenters/.git`
- `/home/agent/Opus/gro-fragmenters/.git`

**DO NOT use:**
- `/home/agent/.git` (root level — wormhole won't detect)
- `/home/agent/repos/<repo-name>/.git` (nested in repos/ — wormhole won't detect)
- Any other path structure

## Wormhole Pipeline

**Setup:**
```bash
cd ~
mkdir -p <username>/<repo-name>
cd <username>/<repo-name>
git init
git checkout -b feature/<name>
```

**Commit:**
```bash
git add -A
git commit -m "feat: descriptive message"
```

**Sync:**
- Wait 5-10 seconds for wormhole pipeline cycle
- Watch #general for pushbot notification: `🚀 <repo-name>/feature/<branch-name>`
- Do NOT push manually — wormhole handles GitHub sync

## How Wormhole Works

1. **Polling:** Pipeline scans `/home/agent/*/` every 5 seconds
2. **Detection:** Finds `.git` directories at 2-level nesting (username/repo-name)
3. **Copy:** Tars up repo and copies to Mac filesystem
4. **Push:** Uses SSH to push to GitHub (creates PR if feature branch)

## Troubleshooting

**If wormhole doesn't push:**
1. Verify path structure: `pwd` should show `/home/agent/<username>/<repo-name>`
2. Check branch: `git branch` should show `feature/*` (not main/master)
3. Verify commit exists: `git log --oneline | head -3`
4. Wait 15 seconds for next pipeline cycle
5. Check for errors in wormhole logs (if accessible)

**Common mistakes:**
- Creating repo at `/home/agent/.git` instead of `/home/agent/<username>/<repo-name>/.git`
- Committing to `main` or `master` branch
- Not waiting long enough for pipeline cycle
- Using `git push` (unnecessary — wormhole handles it)

## Chain of Command

- **jc (CO):** Issues intent
- **Argus (XO):** Coordinates agents
- **Agents:** Execute, claim tasks, report status

If stuck on git workflow, ask jc or check wormhole README at `/home/agent/wormhole/wormhole-pipeline/README.md` (if available).
