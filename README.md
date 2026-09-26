# Velocity Ludo — MongoDB Edition

Heroku-ready Telegram Mini App Ludo backend with persistent rooms.

## Required Heroku config vars

- `BOT_TOKEN` — Telegram bot token
- `MONGODB_URI` — MongoDB Atlas connection string
- `MONGODB_DB` — optional, defaults to `velocity_ludo`
- `WEBAPP_URL` — your public Heroku URL, for example `https://your-app.herokuapp.com`

## Deploy

```bash
npm install
npm start
```

For Heroku:

```bash
heroku config:set BOT_TOKEN="..."
heroku config:set MONGODB_URI="mongodb+srv://..."
heroku config:set MONGODB_DB="velocity_ludo"
heroku config:set WEBAPP_URL="https://YOUR-APP.herokuapp.com"
git push heroku main
```

## MongoDB

The server automatically creates indexes for room codes, player IDs, and `expiresAt`. Rooms expire after 24 hours of inactivity and are removed by MongoDB's TTL index.

## Telegram deep links

The frontend accepts all common room sources:

- `?room=ABC123`
- `?tgWebAppStartParam=ABC123`
- Telegram Mini App `initDataUnsafe.start_param`

So `?tgWebAppStartParam=...` in Heroku logs is now handled correctly.

## Important

This version keeps live WebSocket connections in the dyno but persists room state in MongoDB. For multiple Heroku dynos, add Redis/pub-sub later so WebSocket clients on different dynos share live events.
