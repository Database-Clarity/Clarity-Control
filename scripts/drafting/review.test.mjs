import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { reviseReview } from './review.mjs';

const page = '<main><p class="lede">Review.</p><article><div class="cols"><section>Source</section><section><div class="lbl">Draft</div><pre>Old text</pre></section></div><div class="fb" data-hash="42"><button data-v="change" aria-pressed="false">Needs change</button><textarea></textarea><span class="st"></span></div></article></main><script>const state={};let db=null;\ncount();\n})();</script>';
it('keeps original text, feedback, and database handling while adding escaped revisions', () => {
  const feedback = { 42: { verdict: 'change', note: '</script>Keep ? and // notes', at: 'stamp' } };
  const html = reviseReview(page, { 42: '<solar Freeze />\nNew text' }, feedback, { 42: "Sturm's original text" });
  const doc = new JSDOM(html).window.document;
  expect(doc.querySelector('.cols').children).toHaveLength(3);
  expect(doc.querySelectorAll('pre')[0].textContent).toBe("Sturm's original text");
  expect(doc.querySelector('[data-redraft] pre').textContent).toBe('<solar Freeze />\nNew text');
  expect(doc.querySelector('textarea').textContent).toBe(feedback[42].note);
  expect(doc.querySelector('button').getAttribute('aria-pressed')).toBe('true');
  expect(doc.scripts).toHaveLength(1);
  expect(doc.scripts[0].textContent).toContain('\\u003c/script>');
  expect(feedback[42].at).toBe('stamp');
  expect(() => reviseReview(page, { 43: 'Unexpected draft' }, feedback)).toThrow('change verdict');
});
