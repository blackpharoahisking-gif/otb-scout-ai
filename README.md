# OTB Scout AI v1.1

Cache-first Cloudflare Worker for team-role intelligence and xMins evidence.

## Runtime bindings

The existing Cloudflare Worker must retain these dashboard bindings:

- `DB` — D1 database
- `AI` — Workers AI
- `BROWSER` — Browser Run (reserved as fallback)

## API

- `GET /api/health`
- `GET /api/role-intelligence?team=SUN`
- `GET /api/scout/team/SUN`
- `GET /api/scout/team/SUN?fresh=1` — force live scan
- `POST /api/role-sync` with `{ "team": "SUN" }`
- `GET /api/role-latest`

Normal team requests return the newest saved report immediately. If the report is stale, the Worker refreshes it in the background. A forced refresh performs the live scan during the request.

## First GitHub deployment

This repository intentionally omits a Wrangler configuration file. The connected Cloudflare Worker will open an automatic configuration pull request. Review its generated `wrangler.jsonc` and verify that it contains the existing `DB`, `AI`, and `BROWSER` bindings before merging.
