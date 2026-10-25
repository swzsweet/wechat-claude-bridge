import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramHtml } from '../src/telegram-html.js';

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
