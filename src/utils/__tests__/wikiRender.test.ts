import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownPayload, type WikiContext } from '../markdownRenderer';
import type { WikiLookup } from '../wikiLink';

const lookup: WikiLookup = {
  byName: { note: ['C:\\v\\note.md'], other: ['C:\\v\\other.md'] },
  byPath: {}
};

const ctx = (extra: Partial<WikiContext> = {}): WikiContext => ({
  docPath: 'C:\\v\\doc.md',
  lookup,
  ...extra
});

describe('wiki links', () => {
  it('degrades to an unresolved span without an index', async () => {
    const html = await renderMarkdownPayload('see [[Note]]');
    expect(html).toContain('class="wikilink wikilink-unresolved"');
    expect(html).toContain('data-wikilink="Note"');
  });

  it('renders a resolved link with a relative href', async () => {
    const html = await renderMarkdownPayload('see [[Note]]', ctx());
    expect(html).toContain('<a class="wikilink" href="note.md"');
    expect(html).toContain('>Note</a>');
  });

  it('appends a heading fragment matching the renderer heading id', async () => {
    const html = await renderMarkdownPayload('see [[Note#Some Heading]]', ctx());
    expect(html).toContain('href="note.md#heading-some-heading"');
  });

  it('appends a block fragment', async () => {
    const html = await renderMarkdownPayload('see [[Note#^blk1]]', ctx());
    expect(html).toContain('href="note.md#blk-blk1"');
  });

  it('resolves a same-page heading link', async () => {
    const html = await renderMarkdownPayload('see [[#Local]]', ctx());
    expect(html).toContain('href="#heading-local"');
  });

  it('uses the alias as display text', async () => {
    const html = await renderMarkdownPayload('[[Note|别名]]', ctx());
    expect(html).toContain('>别名</a>');
  });

  it('leaves links inside code fences and code spans alone', async () => {
    const fenced = await renderMarkdownPayload('```\n[[Note]]\n```', ctx());
    expect(fenced).toContain('[[Note]]');
    expect(fenced).not.toContain('wikilink');
    const span = await renderMarkdownPayload('`[[Note]]`', ctx());
    expect(span).toContain('[[Note]]');
    expect(span).not.toContain('class="wikilink"');
  });

  it('leaves links inside math alone', async () => {
    const html = await renderMarkdownPayload('$[[Note]]$', ctx());
    expect(html).not.toContain('class="wikilink"');
  });
});

describe('embeds', () => {
  it('renders an image with the Obsidian width syntax', async () => {
    const html = await renderMarkdownPayload('![[pic.png|300]]', ctx({ lookup: { byName: {}, byPath: {} } }));
    expect(html).toContain('class="embedded-image embedded-image-unresolved"');
    expect(html).toContain('src="pic.png"');
    expect(html).toContain('width="300"');
  });

  it('renders an embedded note body supplied by the host', async () => {
    const html = await renderMarkdownPayload('![[Other]]', ctx({ embeds: { 'C:\\v\\other.md': '# 标题\n\n正文' } }));
    expect(html).toContain('class="embedded-note"');
    expect(html).toContain('embedded-note-body');
    expect(html).toContain('正文');
    expect(html).not.toContain('@@EMBED_NOTE');
  });

  it('degrades a note whose body was not loaded', async () => {
    const html = await renderMarkdownPayload('![[Other]]', ctx());
    expect(html).toContain('embedded-note-missing');
    expect(html).not.toContain('@@EMBED_NOTE');
  });

  it('terminates when notes embed each other', async () => {
    const embeds = {
      'C:\\v\\note.md': 'note body with ![[Other]]',
      'C:\\v\\other.md': 'other body with ![[Note]]'
    };
    const html = await renderMarkdownPayload('![[Note]]', ctx({ embeds }));
    expect(html).toContain('note body with');
    // The nested embed is NOT expanded a second time: it degrades to a chip.
    expect(html).toContain('embedded-note-missing');
  });

  it('只嵌入锚点指向的那个区块', async () => {
    const embeds = { 'C:\\v\\other.md': '第一段\n\n目标块 ^b1\n\n第三段' };
    const html = await renderMarkdownPayload('![[Other#^b1]]', ctx({ embeds }));
    expect(html).toContain('目标块');
    expect(html).not.toContain('第一段');
    expect(html).not.toContain('第三段');
    expect(html).toContain('data-embed="C:\\v\\other.md"');
    expect(html).toContain('data-embed-anchor="^b1"');
    // 表头要能看出嵌的是那个区块，而不是整篇。
    expect(html).toContain('>Other#^b1</a>');
  });

  it('只嵌入锚点指向的那个章节，且不重复渲染标题行', async () => {
    const embeds = {
      'C:\\v\\other.md': '# 前言\n\n前言正文\n\n# 目标\n\n目标正文\n\n# 结尾\n\n结尾正文'
    };
    const html = await renderMarkdownPayload('![[Other#目标]]', ctx({ embeds }));
    expect(html).toContain('目标正文');
    expect(html).not.toContain('前言正文');
    expect(html).not.toContain('结尾正文');
    // 章节正文里不含标题行，所以嵌入结果里不该出现标题元素。
    expect(html).not.toContain('<h1');
    expect(html).toContain('>Other#目标</a>');
  });

  it('锚点不存在时给「未找到」壳，而不是退回整篇', async () => {
    const embeds = { 'C:\\v\\other.md': '只有这一段正文 ^real' };
    const html = await renderMarkdownPayload('![[Other#^nope]]', ctx({ embeds }));
    expect(html).toContain('embedded-note-missing');
    expect(html).toContain('data-embed="C:\\v\\other.md"');
    expect(html).toContain('未找到区块 ^nope');
    expect(html).not.toContain('只有这一段正文');
  });
});

describe('tags', () => {
  it('wraps an inline tag', async () => {
    const html = await renderMarkdownPayload('about #力学 and #mechanics/sub');
    expect(html).toContain('<span class="md-tag" data-tag="力学">#力学</span>');
    expect(html).toContain('data-tag="mechanics/sub"');
  });

  it('does not claim headings, URL fragments, entities or escaped hashes', async () => {
    const html = await renderMarkdownPayload('# Title\n\nhttps://x/y#frag\n\n&#39;\n\n\\#literal');
    expect(html).not.toContain('md-tag');
    expect(html).toContain('<h1');
  });

  it('does not tag the fragment of a wiki link', async () => {
    const html = await renderMarkdownPayload('[[Note#Some Heading]]', ctx());
    expect(html).not.toContain('md-tag');
  });

  it('ignores tags inside code', async () => {
    const html = await renderMarkdownPayload('```\n# notatag\n```');
    expect(html).not.toContain('md-tag');
  });
});

describe('block ids', () => {
  it('puts the id on the block element and removes the marker', async () => {
    const html = await renderMarkdownPayload('段落到此结束 ^my-block');
    expect(html).toContain('id="blk-my-block"');
    expect(html).toContain('data-block-id="my-block"');
    expect(html).not.toContain('^my-block');
  });

  it('leaves a superscript alone', async () => {
    const html = await renderMarkdownPayload('x ^2');
    expect(html).not.toContain('blk-');
  });
});

describe('source anchors', () => {
  it('still stamps the true source span when a wiki link precedes the block', async () => {
    const raw = '[[Note]] 在第一段\n\n第二段';
    const html = await renderMarkdownPayload(raw, ctx());
    expect(html).toContain('data-src-start="0"');
    const second = html.indexOf('data-src-start', html.indexOf('第二段') - 400);
    expect(second).toBeGreaterThan(0);
  });
});

describe('renderMarkdown (host path)', () => {
  it('resolves asset URLs and keeps wiki markup', async () => {
    const html = await renderMarkdown('![[Note]]\n\n[[Note]]', 'C:\\v\\doc.md', ctx());
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('note.md');
  });
});
