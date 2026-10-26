import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramHtml, telegramHtmlChunks } from '../src/telegram-html.js';

test('Telegram HTML fallback preserves headings, emphasis, lists and code', () => {
  const html = telegramHtml('**结果**\n\n- **完成** `a<b`\n- 第二项\n\n```js\nconst x = 1;\n```');
  assert.match(html, /^<b>结果<\/b>/);
  assert.match(html, /• <b>完成<\/b> <code>a&lt;b<\/code>/);
  assert.match(html, /• 第二项/);
  assert.match(html, /<pre>const x = 1;<\/pre>/);
});

test('Telegram HTML fallback escapes raw HTML and rejects unsafe links', () => {
  const html = telegramHtml('<script>bad</script>\n\n[click](javascript:alert(1)) [site](https://example.com/?a=1&b=2)');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<a href="https:\/\/example.com\/\?a=1&amp;b=2">site<\/a>/);
});

test('long HTML keeps formatting balanced in every segment', () => {
  const markdown = `**${'重点内容'.repeat(900)}**\n\n\`\`\`json\n${'代码内容'.repeat(900)}\n\`\`\``;
  const chunks = telegramHtmlChunks(markdown);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 3000));
  for (const chunk of chunks) {
    const tags = [];
    for (const match of chunk.matchAll(/<\/?(b|i|s|code|pre|a)(?:\s[^>]*)?>/g)) {
      if (match[0].startsWith('</')) assert.equal(tags.pop(), match[1]);
      else tags.push(match[1]);
    }
    assert.deepEqual(tags, []);
  }
  const visible = (value) => value.replace(/<[^>]+>/g, '');
  assert.equal(chunks.map(visible).join(''), visible(telegramHtml(markdown)));
  assert.ok(chunks.some((chunk) => chunk.startsWith('<b>') && chunk.endsWith('</b>')));
  assert.ok(chunks.some((chunk) => chunk.startsWith('<pre>') && chunk.endsWith('</pre>')));
});
