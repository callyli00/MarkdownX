// P4a 真机冒烟（CDP）：区块级 / 章节级嵌入。
//
// 前提：应用带远程调试启动，工作区是夹具副本 + 两份本脚本专用的笔记：
//   source.md  三个块，其中「第一段落」带 ^b1，「另一段」不带
//   embed.md   正文里只有 ![[source#^b1]] 与 ![[source#小节]]
// 运行：node tools/local-check/smoke-p5.mjs
//
// 要点：带锚点的嵌入必须只出现那一段——整篇出现在这里就是这个功能没生效。
import { connect, sleep, check, waitFor, report } from './cdp-harness.mjs';

const cdp = await connect();

async function clickByText(cdp, selector, needle) {
  const box = await cdp.eval(
    `(() => { const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));` +
      `const el = els.find((e) => (e.innerText || '').includes(${JSON.stringify(needle)}));` +
      `if (!el) return null; const r = el.getBoundingClientRect();` +
      `return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 }; })()`
  );
  if (!box) throw new Error(`找不到含「${needle}」的元素`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(300);
}

check('应用已渲染', await waitFor(cdp, `!!document.querySelector('.sb-searchbar')`));
check('工作区已打开', await waitFor(cdp, `!!document.querySelector('.file-tree-item, .sb-tree-row, .sidebar-doc-item, .sb-doc-item')`, 12000));

await clickByText(cdp, '.file-tree-item, .sb-tree-row, .sidebar-doc-item, .sb-doc-item', 'embed.md');
await sleep(1500);

const paper = `document.querySelector('.typora-paper-article')?.innerText || ''`;
check('预览已渲染', await waitFor(cdp, `${paper}.length > 0`, 8000));
const text = await cdp.eval(paper);

check('区块嵌入带出了目标块', text.includes('第一段落写点内容'), text.slice(0, 200));
check('区块嵌入没有带出同一篇的其它块', !text.includes('另一段无关内容'), text.slice(0, 300));
check('章节嵌入带出了小节内容', text.includes('小节里的正文'), text.slice(0, 300));
check('章节嵌入没有越过下一个同级标题（另一个小节的内容）', !text.includes('另一个小节的内容'), text.slice(0, 300));
check('嵌入表头写清了锚点（source.md#^b1）', await waitFor(cdp, `${paper}.includes('source.md#^b1')`, 4000), text.slice(0, 200));
check(
  'DOM 上带了 data-embed-anchor',
  await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('.embedded-note')).map((e) => e.getAttribute('data-embed-anchor')))`) ===
    '["^b1","小节"]'
);
check(
  '两个嵌入体各自只含自己的片段',
  await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('.embedded-note-body')).map((e) => e.innerText.trim()))`) ===
    '["第一段落写点内容","小节里的正文"]'
);

report(cdp);
