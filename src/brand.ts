/** The assistant's name, used in the prompt, messages and the connect page. Set BOT_NAME to rename it. */
export const botName = (): string => (process.env.BOT_NAME || "").trim() || "Pallas";
