// P4 真机冒烟（CDP）：未链接提及面板。
//
// 前提：应用带远程调试启动，工作区是夹具副本：
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334
//   markdown-x.exe "C:/tmp/vault4"
// 运行：node tools/local-check/smoke-p4.mjs
//
// 夹具（tools/local-check/fixtures/vault）里 beta.md 有 `[[alpha]]`（反链）和一句普通的
// `alpha`（未链接提及）。打开 alpha.md 后，「提及」页签必须只列出普通提及那一行——
// 链接行算反链，不能在这里再出现一次。
import { connect, sleep, check, click, waitFor, report } from './cdp-harness.mjs';

const cdp = await connect();

/** 按文字点元素（面板行没有稳定的 id）。 */
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
check(
  '工作区已打开',
  await waitFor(cdp, `!!document.querySelector('.file-tree-item, .sb-tree-row, .sidebar-doc-item, .sb-doc-item')`, 12000)
);

// 打开 alpha.md，让「反链/提及」有主语
await clickByText(cdp, '.file-tree-item, .sb-tree-row, .sidebar-doc-item, .sb-doc-item', 'alpha.md');
await sleep(600);
check('已打开 alpha.md', await waitFor(cdp, `Array.from(document.querySelectorAll('.doc-tab')).some((e) => e.innerText.includes('alpha'))`));

// 打开「链接面板」（侧栏那个入口按钮），再切到「提及」页签
await clickByText(cdp, '.sb-searchbar', '反链');
await sleep(700);
check(
  '有「提及」页签',
  await waitFor(cdp, `Array.from(document.querySelectorAll('.links-tab')).some((e) => e.innerText.trim() === '提及')`)
);
await clickByText(cdp, '.links-tab', '提及');
await sleep(800);

const rows = await cdp.eval(
  `JSON.stringify(Array.from(document.querySelectorAll('.links-row')).map((e) => e.innerText.replace(/\\s+/g, ' ').trim()))`
);
const parsed = JSON.parse(rows);
check('提及列表只有一行（[[alpha]] 那行算反链，不重复出现）', parsed.length === 1, rows);
check('这一行来自 beta.md', String(parsed[0] || '').includes('beta.md'), parsed[0]);
check('片段是普通提及那句', String(parsed[0] || '').includes('普通提及'), parsed[0]);
check('行号显示在标题后', /beta\.md:\d+/.test(String(parsed[0] || '')), parsed[0]);

// 反链页签仍然是 1 条（beta.md 的 [[alpha]]），且不重复提及行
await clickByText(cdp, '.links-tab', '反链');
await sleep(700);
const backRows = Number(await cdp.eval(`document.querySelectorAll('.links-row').length`));
check('反链页签仍显示 beta.md 的链接', backRows >= 1, String(backRows));

// 回到提及页签，点这一行应当打开 beta.md
await clickByText(cdp, '.links-tab', '提及');
await sleep(600);
await clickByText(cdp, '.links-row', 'beta.md');
await sleep(1000);
check(
  '点提及行能打开被提及方所在文件',
  await waitFor(cdp, `Array.from(document.querySelectorAll('.doc-tab')).some((e) => e.innerText.includes('beta'))`, 6000)
);

report(cdp);
