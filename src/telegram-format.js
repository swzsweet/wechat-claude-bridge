function label(value) {
  return String(value || '').replace(/[\r\n\t`\\]/g, ' ').trim();
}

export function formatTelegramNotification(computer, { title, project, session, body }) {
  const heading = label(title).replace(/^[#*_ ]+|[#*_ ]+$/g, '') || 'Claude Code 通知';
  const tags = [computer, project, 'Claude Code'].map((value) => `\`${label(value)}\``).join(' · ');
  const context = session ? `\n会话 \`${label(session)}\`` : '';
  return `## ${heading}\n\n${tags}${context}\n\n---\n\n${String(body || '').trim()}`;
}
