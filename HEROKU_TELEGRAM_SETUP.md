# Heroku Telegram + Ludo setup

This deployment runs the Ludo API, Ludo web app, and Telegram bot in the same `web.1` dyno.

## Required Heroku config vars

- `BOT_TOKEN` = the token from @BotFather
- `APP_URL` = the public HTTPS URL of this Heroku app, for example `https://your-app-name.herokuapp.com`

`PUBLIC_URL` can be used instead of `APP_URL`. If neither is set and Heroku provides `HEROKU_APP_NAME`, the bot will derive the standard Heroku URL automatically.

## Procfile

```text
web: pnpm --filter @workspace/api-server start
```

## Telegram commands

- `/start` sends the Ludo launch button.
- `/ludo` sends the Ludo launch button.

The bot uses Telegram long polling, so no Telegram webhook URL is required.
