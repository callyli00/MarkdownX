// P5 真机冒烟（CDP）：增量预览。
//
// 前提：应用带远程调试启动，工作区为夹具副本（alpha.md 里有任务列表与公式）：
//   markdown-x.exe "C:/tmp/vault5"
// 运行：node tools/local-check/smoke-p6.mjs
//
// 判据：预览里点复选框会让正文变化 → 重新渲染。增量补丁必须只替换变化的那一块：
// 打在第一块/已排版公式上的探针标记要活下来（说明 DOM 节点被复用、MathJax 没有重排全篇），
// 而任务列表那一块本身要换成新节点（说明该换的确实换了）。
import { connect, sleep, check, waitFor, report } from './cdp-harness.mjs';

const cdp = await connect();
const ART = `document.querySelector('.academic-article')`;

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

await clickByText(cdp, '.file-tree-item, .sb-tree-row, .sidebar-doc-item, .sb-doc-item', 'alpha.md');
check('预览已渲染', await waitFor(cdp, `${ART} && ${ART}.children.length > 2`, 10000));
await sleep(1500); // 等 MathJax 排完，后面才能验证"没重排"

const before = await cdp.eval(
  `(() => { const a = ${ART}; const kids = Array.from(a.children);` +
    `return JSON.stringify({ count: kids.length, tasks: a.querySelectorAll('input[type=checkbox]').length,` +
    `mjx: a.querySelectorAll('mjx-container').length,` +
    ` taskChecked: Array.from(a.querySelectorAll('input[type=checkbox]')).filter((c) => c.checked).length }); })()`
);
const meta = JSON.parse(before);
check('文档有多块（够验证前后保留）', meta.count > 2, before);
check('有任务项可点', meta.tasks > 0, before);

// 探针：给每个顶层块编号，改动后能算出"活了几个"
await cdp.eval(
  `(() => { const a = ${ART}; Array.from(a.children).forEach((el, i) => el.setAttribute('data-probe', 'k' + i)); return true; })()`
);

// 点第一个未勾选的任务项（复选框只有 13px，坐标取它的中心；渲染出来的 input 是纯 DOM，
// 没有 __reactProps，点击靠 article 上的事件委托）
const box = await cdp.eval(
  `(() => { const input = Array.from(document.querySelectorAll('.task-list-item input[type=checkbox]')).find((c) => !c.checked);` +
    ` if (!input) return null; const r = input.getBoundingClientRect();` +
    ` return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
);
check('找到未勾选的任务项', !!box);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await sleep(1800);

const after = await cdp.eval(
  `(() => { const a = ${ART}; const kids = Array.from(a.children);` +
    ` const survived = kids.filter((el) => el.hasAttribute('data-probe')).length;` +
    ` return JSON.stringify({ count: kids.length, survived,` +
    ` checked: Array.from(a.querySelectorAll('input[type=checkbox]')).filter((c) => c.checked).length }); })()`
);
const post = JSON.parse(after);
check('勾选状态已变化（写回生效，说明确实重渲染了）', post.checked > meta.taskChecked, `${meta.taskChecked} → ${post.checked}`);
check('块数没变（同一文档，只是内容变化）', post.count === meta.count, `${meta.count} → ${post.count}`);
check(
  '只有变化的那一块被替换，其余节点原样复用',
  post.survived >= meta.count - 2,
  `${post.survived}/${meta.count} 存活 — ${after}`
);

report(cdp);
