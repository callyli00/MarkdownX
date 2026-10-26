// P3 真机冒烟（CDP）：右键重命名 + 链接自动改指向。
//
// 前提：应用已带远程调试启动，工作区是夹具仓库的副本：
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334
//   markdown-x.exe "C:/tmp/vault2"
// 运行：node tools/local-check/smoke-p3.mjs
//
// 夹具里 beta.md 有一句 `这里引用回 [[alpha]]`，所以把 alpha.md 改名后，beta.md 必须变成
// `[[alpha-renamed]]`；同时先测一次「改到已存在的名字」必须被拒绝。
import { existsSync, readFileSync } from 'node:fs';
import { connect, sleep, check, typeInto, pressKey, waitFor, report } from './cdp-harness.mjs';

const VAULT = 'C:\\tmp\\vault2';
const ALPHA = `${VAULT}\\alpha.md`;
const RENAMED = `${VAULT}\\alpha-renamed.md`;
const BETA = `${VAULT}\\beta.md`;

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** 某个选择器里「文字包含 needle」的第一个元素的中心点。 */
async function rectOfText(cdp, selector, needle) {
  return cdp.eval(
    `(() => { const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));` +
      `const el = els.find((e) => (e.innerText || '').includes(${JSON.stringify(needle)}));` +
      `if (!el) return null; const r = el.getBoundingClientRect();` +
      `if (!r.width || !r.height) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
}

async function rightClick(cdp, box) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'right',
    buttons: 2,
    clickCount: 1
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'right',
    buttons: 0,
    clickCount: 1
  });
  await sleep(300);
}

/** 点菜单项（菜单项只有文字可认）。 */
async function clickMenuItem(cdp, label) {
  const box = await rectOfText(cdp, '.ctx-menu .dropdown-item', label);
  if (!box) throw new Error(`菜单里没有「${label}」`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(250);
}

const cdp = await connect();

check('应用已渲染', await waitFor(cdp, `!!document.querySelector('.sb-searchbar')`));
check(
  '工作区已打开（命令行参数）',
  await waitFor(cdp, `!!document.querySelector('.file-tree-item, .sb-doc-item, .sidebar-doc-item, .sb-tree-row')`, 12000)
);
check('夹具就位：alpha.md 存在', existsSync(ALPHA));

// --- 右键 alpha.md → 重命名 ---------------------------------------------------------
const treeSelector = '.file-tree-item, .sb-tree-row, .sidebar-doc-item, .sb-doc-item';
const alphaBox = await rectOfText(cdp, treeSelector, 'alpha.md');
check('侧栏里能找到 alpha.md', !!alphaBox);
await rightClick(cdp, alphaBox);
check('右键菜单弹出', await waitFor(cdp, `!!document.querySelector('.ctx-menu .dropdown-item')`));
check(
  '菜单里有「重命名…」',
  await waitFor(cdp, `Array.from(document.querySelectorAll('.ctx-menu .dropdown-item')).some((e) => e.innerText.includes('重命名'))`)
);
await clickMenuItem(cdp, '重命名');
check('重命名对话框弹出', await waitFor(cdp, `!!document.querySelector('.rename-dialog')`));
check(
  '输入框预填当前文件名',
  (await cdp.eval(`document.querySelector('.rename-input')?.value ?? ''`)) === 'alpha.md'
);

// --- 先撞名：改到已存在的 beta ------------------------------------------------
await typeInto(cdp, '.rename-input', 'beta');
await sleep(200);
await pressKey(cdp, 'Enter', 'Enter', 13);
await sleep(1200);
check('撞名被拒绝：alpha.md 还在', existsSync(ALPHA));
check('撞名后对话框保持打开（可改名重试）', await waitFor(cdp, `!!document.querySelector('.rename-dialog')`, 2000));
check('撞名时没有覆盖 beta.md', read(BETA).includes('# beta 笔记'));

// --- 正式改名 alpha.md → alpha-renamed --------------------------------------
await typeInto(cdp, '.rename-input', 'alpha-renamed');
await sleep(200);
await pressKey(cdp, 'Enter', 'Enter', 13);
await sleep(2000);

check('新文件已落盘', existsSync(RENAMED), RENAMED);
check('旧文件已消失', !existsSync(ALPHA));
check('对话框已关闭', (await cdp.eval(`!!document.querySelector('.rename-dialog')`)) === false);
const betaText = read(BETA);
check('引用方的链接已改写为 [[alpha-renamed]]', betaText.includes('[[alpha-renamed]]'), betaText.split('\n').find((l) => l.includes('[[')) || '');
check('旧名字不再出现在链接里', !betaText.includes('[[alpha]]'));
check(
  '侧栏显示新文件名',
  await waitFor(cdp, `Array.from(document.querySelectorAll('.file-tree-item, .sb-tree-row, .sidebar-doc-item')).some((e) => (e.innerText || '').includes('alpha-renamed'))`, 6000)
);

report(cdp);
