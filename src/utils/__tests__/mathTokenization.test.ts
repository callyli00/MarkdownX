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

/**
 * Inline math must never step over a well-formed HTML tag opener.
 *
 * Real defect (a merged book, 7 occurrences): an upstream conversion truncated an
 * `<img alt="...">` value in the middle of `$(\hat{\mathbf{e}}_1, ...)$`, leaving an
 * orphan `$` in attribute space. The inline pass paired that `$` with the next one it
 * found - paragraphs later - so the closing `>` of the tag, the `</figcaption>`, the
 * `</figure>` and the prose between them were all consumed as "math". The figure block
 * disappeared from the output and every later formula was re-paired.
 *
 * Refusing the pairing is the right trade: the orphan `$` stays literal (a local blemish
 * in an attribute nobody reads) instead of the document being shredded from that point on.
 */
describe('inline math does not cross an HTML tag', () => {
  const doc = [
    '<figure>',
    '<img src="images/ch01-001.jpg" alt="Figure 1.2.1 A rectangular Cartesian coordinate '
      + 'system, $(x_{1}, x_{2}, x_{3}) = (x, y, z)$; $(\\hat{" width="555" height="362" '
      + 'style="width: 555px; max-width: 100%; height: auto;">',
    '<figcaption>Figure 1.2.1 A rectangular Cartesian coordinate system, '
      + '$(x_{1}, x_{2}, x_{3}) = (x, y, z)$; $(\\hat{\\mathbf{e}}_1)$ are the unit basis '
      + 'vectors.</figcaption>',
    '</figure>',
    '',
    'and an $n$th-order tensor has the form',
    '',
    '$$\\boldsymbol{\\Phi} = \\varphi_{ijk} \\tag{1.2.9}$$',
  ].join('\n');

  it('keeps the figure block in the output', async () => {
    const html = await renderMarkdown(doc, '');
    expect(html).toContain('<figure');
    expect(html).toContain('</figure>');
    expect(html).toContain('<figcaption>');
  });

  it('does not swallow the closing > of the truncated tag', async () => {
    const html = await renderMarkdown(doc, '');
    // The tag must still end where it should: the next thing after it is the caption.
    expect(html).not.toMatch(/&lt;\/figcaption&gt;/);
    expect(html).toContain('are the unit basis vectors.');
  });

  it('still tokenizes inline math written after the figure', async () => {
    const html = await renderMarkdown(doc, '');
    expect(html).toContain('data-tex-source="n"');
  });

  it('still tokenizes the display equation written after the figure', async () => {
    const html = await renderMarkdown(doc, '');
    expect(rows(html)).toBe(1);
  });
});