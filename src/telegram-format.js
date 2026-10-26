function label(value) {
  return String(value || '').replace(/[\r\n\t`\\]/g, ' ').trim();
}

export function formatTelegramNotification(computer, { title, project, session, sessionTitle, body }) {
  const heading = label(title).replace(/^[#*_ ]+|[#*_ ]+$/g, '') || 'Claude Code 通知';
  const tags = [computer, project, 'Claude Code'].map((value) => `\`${label(value)}\``).join(' · ');
  const namedSession = label(sessionTitle).slice(0, 100);
  const context = namedSession
    ? `\n会话 \`${namedSession}\`${session ? ` · ID \`${label(session)}\`` : ''}`
    : session ? `\n会话 \`${label(session)}\`` : '';
  return `**${heading}**\n\n${tags}${context}\n\n---\n\n${String(body || '').trim()}`;
}

export function formatTelegramApproval(title, id, tool, input) {
  const heading = label(title).replace(/[*_\[\]]/g, '');
  const name = label(tool).replace(/[*_\[\]]/g, '');
  if (tool === 'ExitPlanMode' && typeof input.plan === 'string') {
    const { plan, ...other } = input;
    const extra = Object.keys(other).length ? `\n\n\`\`\`json\n${JSON.stringify(other, null, 2)}\n\`\`\`` : '';
    return `**${heading} 请求 ${id}**\n\n**${name} · 计划**\n\n${plan}${extra}\n\n批准 ${id} / 拒绝 ${id}`;
  }
  return `**${heading} 请求 ${id}**\n\n**${name}**\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n\n批准 ${id} / 拒绝 ${id}`;
}

export function normalSizeHeadings(markdown) {
  let fence = null;
  return markdown.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!heading) return line;
    const content = heading[1].trim().replace(/^\*\*(.*)\*\*$/, '$1');
    return `**${content}**`;
  }).join('\n');
}
