import { marked } from 'marked';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function inline(tokens = []) {
  return tokens.map(token => {
    if (token.type === 'text') return token.tokens ? inline(token.tokens) : escapeHtml(token.text);
    if (token.type === 'strong') return `<b>${inline(token.tokens)}</b>`;
    if (token.type === 'em') return `<i>${inline(token.tokens)}</i>`;
    if (token.type === 'del') return `<s>${inline(token.tokens)}</s>`;
    if (token.type === 'codespan') return `<code>${escapeHtml(token.text)}</code>`;
    if (token.type === 'br') return '\n';
    if (token.type === 'image') return escapeHtml(token.text || '图片');
    if (token.type === 'link') {
      const text = inline(token.tokens);
      try {
        const url = new URL(token.href);
        if (['http:', 'https:'].includes(url.protocol))
          return `<a href="${escapeHtml(url.href)}">${text}</a>`;
      } catch { /* Unsupported link destination is shown as text. */ }
      return text;
    }
    return escapeHtml(token.text || '');
  }).join('');
}

function blocks(tokens = []) {
  return tokens.map(token => {
    if (token.type === 'space') return '';
    if (token.type === 'heading') return `<b>${inline(token.tokens)}</b>`;
    if (token.type === 'paragraph' || token.type === 'text')
      return token.tokens ? inline(token.tokens) : escapeHtml(token.text);
    if (token.type === 'code') return `<pre>${escapeHtml(token.text)}</pre>`;
    if (token.type === 'list') return token.items.map((item, index) =>
      `${token.ordered ? `${Number(token.start) + index}.` : '•'} ${blocks(item.tokens) || escapeHtml(item.text)}`
    ).join('\n');
    if (token.type === 'blockquote') return blocks(token.tokens).split('\n').map(line => `│ ${line}`).join('\n');
    if (token.type === 'hr') return '────────';
    if (token.type === 'table') {
      const row = cells => cells.map(cell => inline(cell.tokens)).join(' | ');
      return [row(token.header), ...token.rows.map(row)].join('\n');
    }
    return escapeHtml(token.text || token.raw || '');
  }).filter(Boolean).join('\n\n');
}

export function telegramHtml(markdown) {
  return blocks(marked.lexer(markdown, { gfm: true }));
}
