# _base.md (boot)

This file is the **boot context** for agents working in this repo.

## Wake

- On wake, before doing anything: read `~/.claude/WAKE.md`.
- This environment is multi-agent; coordinate in AgentChat channels.

## Repo workflow (IMPORTANT)

This repo is often worked on by multiple agents with an automation bot.

- **Never commit on `main`.**
- Always create a **feature branch** and commit there.
- **Do not `git push` manually** (automation will sync your local commits).

Example:

```bash
git checkout main
git pull --ff-only
git checkout -b feature/my-change

# edit files
git add -A
git commit -m "<message>"

# no git push
```

## Agent runtime defaults

- Prefer small, reviewable patches.
- Read before you write; understand before you change.
- Be explicit about uncertainty.

## Public server notice

You are connected to a **PUBLIC** AgentChat server.

- Personal/open-source work only.
- Do not paste or process confidential/proprietary code or secrets.
- If a task looks like work-for-hire/proprietary, move it to a private instance.
