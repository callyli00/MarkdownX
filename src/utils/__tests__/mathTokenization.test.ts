import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdownRenderer';

/**
 * Regression tests for math tokenization around HTML-looking text.
 *
 * `isInsideHtmlTag` decides whether a match sits in HTML attribute space. It used to
 * accept ANY '<' followed by a letter as a tag opener, so `\sum_{l<m}` counted as an
 * open tag; since such a "tag" never closes, every later match was skipped by the
 * display-math pass, fell through to the inline pass, and its '$' paired with the
 * next one - leaving raw LaTeX in the document (and, when the swallowed text was a
 * '#' heading, a bogus "macro parameter character #" TeX error).
 */
const rows = (html: string) => (html.match(/class="math-equation-row"/g) || []).length;
const inlines = (html: string) => (html.match(/class="math-inline"/g) || []).length;

describe('math tokenization with a < inside maths', () => {
  it('a < in an earlier equation does not break the NEXT display equation', async () => {
    const md = '$$\\kappa=\\frac{\\sum_{l<m}\\phi_l}{g^3}$$\n\n$$\\phi_{xx}=\\frac{a}{b}$$\n';
    const html = await renderMarkdown(md, '');
    expect(rows(html)).toBe(2);
    expect(inlines(html)).toBe(0);
  });

  it('inline math right after a display equation still tokenizes', async () => {
    const md = '$$a=b$$\n\n（$\\phi_{xz}$ 类推，下标 $\\pm1$ 只改对应维度）。\n';
    const html = await renderMarkdown(md, '');
    expect(rows(html)).toBe(1);
    expect(inlines(html)).toBe(2);
  });

  it('escapes < inside maths so the emitted DOM keeps the formula intact', async () => {
    const md = '$$\\sum_{l<m}\\phi_l$$\n';
    const html = await renderMarkdown(md, '');
    expect(html).toContain('&lt;m');
    expect(html).not.toContain('<m}');
  });

  it('does NOT rewrite maths that lives inside an HTML attribute', async () => {
    // This is the invariant isInsideHtmlTag exists for: attribute text is not a text
    // node, so injecting a math span there would shred the tag. The maths must be
    // left exactly as written and no span may be invented.
    const md = '<img src="a.png" alt="formula $x^2$ stays">\n';
    const html = await renderMarkdown(md, '');
    expect(html).toContain('$x^2$');
    expect(inlines(html)).toBe(0);
  });

  it('still tokenizes maths that FOLLOWS a genuine tag', async () => {
    const md = '<img src="a.png" alt="no maths">\n\n$$x=1$$\n';
    const html = await renderMarkdown(md, '');
    expect(rows(html)).toBe(1);
  });
});