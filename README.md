# Ludo Arena

This repository contains the original Heroku-ready Ludo entrypoint at the root and the upgraded realtime Telegram Mini App in replit-app/.

## Upgraded app

The upgraded app includes a polished four-player board, server-authoritative dice and token movement, room creation and joining, spectators, live room chat, WebRTC voice signaling, Telegram Mini App deep links, reconnect handling, and a Heroku-compatible HTTP/WebSocket API service.

Run it from the upgraded workspace with pnpm:

    cd replit-app
    pnpm install
    PORT=8080 pnpm --filter @workspace/api-server run dev
    # in another terminal
    PORT=26079 BASE_PATH=/ pnpm --filter @workspace/ludo-arena run dev

The root Procfile and root server.js remain available for the existing MongoDB-backed Heroku deployment.
