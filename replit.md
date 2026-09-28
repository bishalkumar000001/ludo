# Velocity Ludo

Velocity Ludo is a browser-based multiplayer Ludo table with shareable rooms, live chat, server-validated turns, and reconnectable room state.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/ludo-game/src/App.tsx` — lobby, room shell, board, player list, chat, SSE connection, and action client.
- `artifacts/ludo-game/src/index.css` — tabletop visual system and responsive layout.
- `artifacts/api-server/src/routes/ludo.ts` — in-memory room store, SSE stream, chat, and authoritative Ludo rules.
- `lib/api-spec/openapi.yaml` — source of truth for room and game read/create contracts.

## Architecture decisions

- Room actions are validated on the server; clients never choose dice results or token positions.
- Server-sent events broadcast room snapshots and chat to every connected player; commands use normal JSON POSTs.
- Guest identity is generated and kept in local storage so a player can reconnect from the same browser without accounts.
- Rooms are intentionally in memory for the first playable build; restarting the API clears active rooms.

## Product

Players can create or join four-person rooms by link, choose a color and display name, mark ready, start a match, roll and move tokens, capture opponents, receive extra turns for sixes/captures/home finishes, win by bringing all four tokens home, rematch, and chat live.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The frontend expects the API server at `/api`; the shared proxy routes this automatically.
- Room links use the browser query parameter `?room=CODE`.
- Run `pnpm --filter @workspace/api-spec run codegen` after changing the OpenAPI contract.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
