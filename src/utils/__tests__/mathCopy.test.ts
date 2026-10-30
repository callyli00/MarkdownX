import { describe, expect, it } from 'vitest';
import {
  MATH_TEX_ATTR,
  assembleClipboardText,
  containsMath,
  flattenForCopy,
  mathHostSource,
  wrapTex,
  type CopyTreeNode
} from '../mathCopy';

/** Minimal stand-ins for DOM nodes: these tests run in the Node environment, no jsdom. */
function text(value: string): CopyTreeNode {
  return { nodeType: 3, nodeValue: value };
}

function el(
  tagName: string,
  options: { attrs?: Record<string, string>; classes?: string[]; children?: CopyTreeNode[] } = {}
): CopyTreeNode {
  const attrs = options.attrs ?? {};
  const classes = options.classes ?? [];
  return {
    nodeType: 1,
    tagName,
    childNodes: options.children ?? [],
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    classList: { contains: (token: string) => classes.includes(token) }
  };
}

/** A typeset formula as MathJax leaves it: glyph SVG + the (unselectable) MathML copy. */
function typesetMath(tex: string, display: boolean): CopyTreeNode {
  const glyphs = el('svg', { children: [el('g', { children: [el('use')] })] });
  const assistive = el('mjx-assistive-mml', { children: [el('mi', { children: [text('x')] })] });
  return el(display ? 'div' : 'span', {
    attrs: { [MATH_TEX_ATTR]: tex },
    classes: [display ? 'math-equation-row' : 'math-inline'],
    children: [
      el('mjx-container', { children: [glyphs, assistive] })
    ]
  });
}

describe('mathHostSource', () => {
  it('reads the LaTeX source the renderer stamped on the host', () => {
    expect(mathHostSource(typesetMath('x^2', false))).toEqual({ tex: 'x^2', display: false });
  });

  it('marks display rows as display', () => {
    expect(mathHostSource(typesetMath('\\frac{a}{b}', true))).toEqual({
      tex: '\\frac{a}{b}',
      display: true
    });
  });

  it('falls back to the tag name when no classList is exposed', () => {
    const div: CopyTreeNode = {
      nodeType: 1,
      tagName: 'div',
      childNodes: [],
      getAttribute: () => 'a+b'
    };
    expect(mathHostSource(div)).toEqual({ tex: 'a+b', display: true });
  });

  it('ignores nodes without the attribute, without attributes, and empty sources', () => {
    expect(mathHostSource(el('p'))).toBeNull();
    expect(mathHostSource({ nodeType: 1, tagName: 'p' })).toBeNull();
    expect(mathHostSource(el('span', { attrs: { [MATH_TEX_ATTR]: '' } }))).toBeNull();
  });
});

describe('flattenForCopy', () => {
  it('keeps the text and replaces the formula with its source', () => {
    // 设 x 满足 $x^2$ 即可  — the shape of a paragraph where the copy used to lose the math.
    const paragraph = el('p', {
      children: [text('设 x 满足 '), typesetMath('x^2', false), text(' 即可')]
    });
    expect(assembleClipboardText(flattenForCopy(paragraph))).toBe('设 x 满足 $x^2$ 即可');
  });

  it('never descends into a formula: glyph paths and assistive MathML stay out', () => {
    const runs = flattenForCopy(typesetMath('x^2', false));
    expect(runs).toEqual([{ kind: 'math', tex: 'x^2', display: false }]);
    expect(assembleClipboardText(runs)).toBe('$x^2$');
    // The assistive copy holds a literal "x"; a descent would have produced it.
    expect(assembleClipboardText(runs)).not.toContain('x$x');
  });

  it('puts display math on its own lines so the paste stays a block', () => {
    const article = el('div', {
      children: [
        el('p', { children: [text('上一步')] }),
        typesetMath('E = mc^2', true),
        el('p', { children: [text('下一步')] })
      ]
    });
    expect(assembleClipboardText(flattenForCopy(article))).toBe(
      '上一步\n$$\nE = mc^2\n$$\n下一步'
    );
  });

  it('turns <br> into a newline', () => {
    const paragraph = el('p', { children: [text('a'), el('br'), text('b')] });
    expect(assembleClipboardText(flattenForCopy(paragraph))).toBe('a\nb');
  });

  it('walks nested inline markup (strong/em/a) without losing their text', () => {
    const paragraph = el('p', {
      children: [
        el('strong', { children: [text('注意')] }),
        text('：'),
        el('a', { attrs: { href: '#x' }, children: [text('链接')] }),
        typesetMath('\\alpha', false)
      ]
    });
    expect(assembleClipboardText(flattenForCopy(paragraph))).toBe('注意：链接$\\alpha$');
  });
});

describe('containsMath', () => {
  it('is true only when a formula is inside', () => {
    expect(containsMath(el('p', { children: [text('纯文本')] }))).toBe(false);
    expect(
      containsMath(el('p', { children: [text('文本'), typesetMath('y', false)] }))
    ).toBe(true);
  });

  it('finds a formula nested several levels down', () => {
    expect(
      containsMath(el('div', { children: [el('ul', { children: [el('li', { children: [typesetMath('z', true)] })] })] }))
    ).toBe(true);
  });
});

describe('wrapTex', () => {
  it('uses the delimiters this renderer accepts', () => {
    expect(wrapTex('a+b', false)).toBe('$a+b$');
    expect(wrapTex('a+b', true)).toBe('$$\na+b\n$$');
  });

  it('trims stray whitespace around the source', () => {
    expect(wrapTex('  \\theta \n', false)).toBe('$\\theta$');
  });
});
