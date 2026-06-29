# AGENTS.md — Jarvis AI Agent

Companion to `CLAUDE.md`. Only what's easy to get wrong.

## Two add-on directories

| Directory | Status | Slug | Version |
|-----------|--------|------|---------|
| `jarvis/` | **Active** — edit here | `jarvis_ai_agent` | 3.35.2 |
| `ClaudeInHassio/` | **Stale/legacy** — do not modify | `claude_ha_chat` | 1.1.0 |

The `ClaudeInHassio/` directory is an old version of the project with a different structure. All work goes in `jarvis/`.

## No test / lint / CI

- `package.json` has **no scripts field** — no `npm test`, `npm run lint`, etc.
- No CI workflows (`.github/workflows/` does not exist)
- The only syntax check available: `node --check path/to/file.js`
- After adding a tool, verify with: `node --check tools/executor.js && node --check tools/definitions.js`

## Version must bump in 4 files

1. `jarvis/config.yaml` — `version:` field
2. `jarvis/run.sh` — `bashio::log.info` message
3. `jarvis/utils/state.js` — `JARVIS_VERSION` constant
4. `jarvis/Dockerfile` — `ARG VERSION=X.Y.Z`

Also update `CHANGELOG.txt` before push.

## Add-on rules (non-negotiable)

- All add-on files **must** stay inside `jarvis/` — never move them to root
- Frontend fetch paths must be **relative**: `"api/chat"` not `"/api/chat"` (HA ingress prefix)
- Use **CommonJS** (`require`), not ES modules (`import`)
- `node-fetch` must stay at **v2.x** (v3 is ESM-only)
- Frontend is single-file `index.html` — vanilla JS, no build tools

## Filesystem map (from config.yaml)

| Path | Access |
|------|--------|
| `/config` | rw |
| `/addons` | ro |
| `/share` | rw |
| `/media` | ro |
| `/data` | rw |

Persistence (memory, learnings, history) goes to JSON files in `/data`.

## Model routing in callLLM

```
claude-*  → callAnthropic
deepseek-* → callDeepSeek  (R1: no tools)
default    → callOpenAI
```

## Adding a tool requires 3 files

1. `tools/definitions.js` — add `{name, description, input_schema}`
2. `tools/executor.js` — add `case 'name':` before the final `default:`
3. `nexus/experts.js` — add name to relevant expert's `tools[]`
