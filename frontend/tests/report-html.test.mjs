import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeHtml } from '../src/utils/escapeHtml.js';
for (const component of ['Step4Report', 'Step5Interaction']) {
  const source = readFileSync(new URL(`../src/components/${component}.vue`, import.meta.url), 'utf8');
  const start = source.indexOf('const renderMarkdown = (content) => {');
  const body = source.slice(start, source.indexOf('  return html', start) + '  return html\n}'.length);
  const render = new Function('escapeHtml', body + '; return renderMarkdown;')(escapeHtml);
  test(`${component} renders untrusted HTML as text`, () => {
    for (const input of ['<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<script>alert(1)</script>', '```html\n<img src=x onerror=alert(1)>\n```', '`<iframe srcdoc="attack">`']) {
      const output = render(input);
      assert.doesNotMatch(output, /<(img|svg|script|iframe)\b/i);
      assert.match(output, /&lt;/);
    }
  });
  test(`${component} preserves ordinary markdown`, () => {
    assert.match(render('**bold**'), /<strong>bold<\/strong>/);
    assert.match(render('> quote'), /<blockquote[^>]*>quote<\/blockquote>/);
  });
}
test('answer text escapes markup and existing entities', () => {
 assert.equal(escapeHtml('<img>&lt;'), '&lt;img&gt;&amp;lt;');
});
