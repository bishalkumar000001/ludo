# Velocity Ludo — Telegram Multiplayer Mini Game

A deployable Telegram Ludo project with:
- 2–4 player rooms
- 6-character room codes
- Group-created rooms
- Telegram user name/avatar integration
- WebSocket real-time state
- Server-side dice and move validation
- Reconnect support
- Canvas renderer using requestAnimationFrame (capable of 120Hz where the device/WebView allows)
- Heroku-ready Procfile

## 1. Create the Telegram bot
Create a bot with @BotFather and copy the bot token.

Set the bot's Main Mini App / direct-link configuration to the deployed HTTPS app as appropriate for your Telegram setup. The bot's username is used to create:
`https://t.me/<BOT_USERNAME>?startapp=<ROOM_CODE>`

## 2. Deploy to Heroku

Set these config vars:
- `BOT_TOKEN`
- `BOT_USERNAME` (without @)
- `APP_URL` = your HTTPS Heroku URL

Then deploy:

```bash
heroku create your-velocity-ludo
heroku config:set BOT_TOKEN="YOUR_TOKEN"
heroku config:set BOT_USERNAME="YourBotUsername"
heroku config:set APP_URL="https://your-velocity-ludo.herokuapp.com"
git push heroku main
```

The project starts with:
```bash
node server.js
```

## 3. Test

Open:
`https://YOUR_APP.herokuapp.com/?room=ABC123`

For the bot:
- `/ludo` creates a room
- `/ludo ABC123` opens/reuses a specific room
- `/ludostop` closes rooms associated with the current group

## 4. Important production notes

This starter keeps rooms in RAM. A Heroku dyno restart will clear active rooms. For persistent/scalable production play, move room state to Redis and player statistics to PostgreSQL.

For stronger anti-cheat, validate Telegram `initData` on the server and use a persistent player identity instead of trusting the browser-supplied ID.

The game renderer is designed around `requestAnimationFrame`; 120 FPS cannot be guaranteed because Telegram/WebView/device refresh rate controls the actual frame rate.
