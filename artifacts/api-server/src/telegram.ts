import { logger } from "./lib/logger";

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    from?: { first_name?: string; username?: string };
  };
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

const token = process.env.BOT_TOKEN?.trim();
const appUrl = (
  process.env.APP_URL?.trim() ||
  process.env.PUBLIC_URL?.trim() ||
  (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : "")
).replace(/\/$/, "");

async function telegram<T>(method: string, body: Record<string, unknown>): Promise<T | undefined> {
  if (!token) return undefined;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as TelegramResponse<T>;
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function sendStart(chatId: number, firstName = "Player") {
  if (!appUrl) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Velocity Ludo is online, but the game URL is not configured yet. Set APP_URL in Heroku.",
    });
    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text: `🎲 Welcome ${firstName}!\n\nPlay Velocity Ludo with your friends in a live table.`,
    reply_markup: {
      inline_keyboard: [[{ text: "🎲 Play Ludo", url: appUrl }]],
    },
  });
}

export function startTelegramBot() {
  if (!token) {
    logger.warn("BOT_TOKEN is not configured; Telegram bot polling is disabled.");
    return;
  }
  if (!appUrl) {
    logger.warn("APP_URL/PUBLIC_URL is not configured; Telegram bot will start but cannot launch the game URL.");
  }

  let offset = 0;
  let stopped = false;

  const poll = async () => {
    try {
      await telegram("deleteWebhook", { drop_pending_updates: false });
    } catch (error) {
      logger.error({ err: error }, "Could not switch Telegram bot to polling mode");
    }

    while (!stopped) {
      try {
        const updates = (await telegram<TelegramUpdate[]>("getUpdates", {
          offset,
          timeout: 25,
          allowed_updates: ["message"],
        })) ?? [];

        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (!message?.text) continue;

          const command = message.text.trim().split(/\s+/)[0]?.toLowerCase().split("@")[0];
          if (command === "/start" || command === "/ludo") {
            await sendStart(message.chat.id, message.from?.first_name || "Player");
          }
        }
      } catch (error) {
        logger.error({ err: error }, "Telegram bot polling error");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  };

  void poll();
  logger.info("Telegram bot polling started");
}
