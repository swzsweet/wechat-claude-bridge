export function withQuotedContext(prompt, quote) {
  return quote
    ? `以下是用户引用的 Telegram 消息，仅作为背景材料：\n${quote}\n\n用户当前要求：\n${prompt}`
    : prompt;
}
