// P2 真机冒烟（CDP）：`[[` 补全（笔记 / 标题 / 块）、接受插入、未解析链接新建笔记。
//
// 前提：应用已带远程调试启动，工作区是夹具仓库的副本：
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334
//   markdown-x.exe "C:\tmp\vault2"
// 运行：node tools/local-check/smoke-p2.mjs
import { existsSync, rmSync } from 'node:fs';
import { connect, sleep, check, click, waitFor, countOf, textOf, report } from './cdp-harness.mjs';

const VAULT = 'C:\\tmp\\vault2';
// 每次跑用不同名字：上一轮建过的笔记会留在索引里，重名会让链接不再「未解析」。
const NEW_NOTE = `P2新建验证${Date.now() % 1000000}`;
const NEW_NOTE_PATH = `${VAULT}\\${NEW_NOTE}.md`;

/** 点到第一个存在的选择器（侧栏在不同宽度下用不同类名）。 */
async function clickFirst(cdp, selectors) {
  for (const selector of selectors) {
    const found = await cdp.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (found) {
      await click(cdp, selector);
      return selector;
    }
  }
  throw new Error(`找不到可点击元素：${selectors.join(' / ')}`);
}

/** 按下标点击（视图切换标签没有稳定 id）。 */
async function clickNth(cdp, selector, index) {
  const box = await cdp.eval(
    `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];` +
      `if (!el) return null; const r = el.getBoundingClientRect();` +
      `if (!r.width || !r.height) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  if (!box) throw new Error(`找不到第 ${index} 个 ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(200);
}

/** 把光标放到源码编辑区末尾，返回当前长度。 */
const caretToEnd = (cdp) =>
  cdp.eval(
    `(() => { const ta = document.querySelector('.typora-fullscreen-textarea');` +
      `if (!ta) return -1; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); return ta.value.length; })()`
  );

const editorText = (cdp) => cdp.eval(`document.querySelector('.typora-fullscreen-textarea')?.value ?? ''`);

const cdp = await connect();

check('应用已渲染', await waitFor(cdp, `!!document.querySelector('.sb-searchbar')`));
check(
  '工作区已打开（命令行参数）',
  await waitFor(cdp, `!!document.querySelector('.file-tree-item, .sb-doc-item, .sidebar-doc-item, .sb-tree-row')`, 12000)
);

// --- 打开一篇笔记并切到源码模式 -----------------------------------------------------
await clickFirst(cdp, ['.sb-tree-row', '.file-tree-item', '.sidebar-doc-item']);
check('打开了笔记（预览可见）', await waitFor(cdp, `!!document.querySelector('.typora-paper-article, .academic-article')`));
await clickNth(cdp, '.wb-view-tab', 1);
check('切到源码模式', await waitFor(cdp, `!!document.querySelector('.typora-fullscreen-textarea')`));

// --- 笔记补全 -----------------------------------------------------------------------
await caretToEnd(cdp);
await cdp.send('Input.insertText', { text: '\n\n[[gam' });
check('输入 [[gam 后弹出补全', await waitFor(cdp, `document.querySelectorAll('.wiki-suggest-row').length > 0`, 4000));
const labels = await cdp.eval(
  `Array.from(document.querySelectorAll('.wiki-suggest-row .wiki-suggest-label')).map((el) => el.innerText)`
);
check('补全里出现 gamma', Array.isArray(labels) && labels.some((l) => /gamma/i.test(l)), `候选：${labels}`);
const kinds = await cdp.eval(
  `Array.from(document.querySelectorAll('.wiki-suggest-row .wiki-suggest-kind')).map((el) => el.innerText)`
);
check('候选标注了类型（笔记）', Array.isArray(kinds) && kinds.includes('笔记'), `类型：${kinds}`);

// 键盘接受第一条（Enter），随后文本里应出现完整的 [[gamma]]
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(400);
const afterAccept = await editorText(cdp);
check('回车接受补全，写入 [[gamma]]', /\[\[gamma\]\]/.test(afterAccept), JSON.stringify(afterAccept.slice(-40)));
check('补全弹窗已关闭', (await countOf(cdp, '.wiki-suggest-row')) === 0);

// --- 标题补全 -----------------------------------------------------------------------
await caretToEnd(cdp);
await cdp.send('Input.insertText', { text: '\n[[alpha#' });
check('输入 [[alpha# 弹出标题候选', await waitFor(cdp, `document.querySelectorAll('.wiki-suggest-row').length > 0`, 4000));
const headingKinds = await cdp.eval(
  `Array.from(document.querySelectorAll('.wiki-suggest-row .wiki-suggest-kind')).map((el) => el.innerText)`
);
check('候选类型是标题', Array.isArray(headingKinds) && headingKinds.includes('标题'), `类型：${headingKinds}`);
// 夹具里 alpha.md 的标题是「应力张量」，按「张」过滤才应该只剩一条
await cdp.send('Input.insertText', { text: '张' });
await sleep(300);
const headingLabels = await cdp.eval(
  `Array.from(document.querySelectorAll('.wiki-suggest-row .wiki-suggest-label')).map((el) => el.innerText)`
);
check('按标题过滤（只剩含「张」的）', Array.isArray(headingLabels) && headingLabels.length > 0, `候选：${headingLabels}`);
// Esc 关闭，不插入
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(250);
check('Esc 关闭补全', (await countOf(cdp, '.wiki-suggest-row')) === 0);

// --- 未解析链接点击新建笔记 ---------------------------------------------------------
if (existsSync(NEW_NOTE_PATH)) rmSync(NEW_NOTE_PATH); // 上一轮同名残留（正常不会命中）
await caretToEnd(cdp);
await cdp.send('Input.insertText', { text: `\n\n[[${NEW_NOTE}]]\n` });
await sleep(700);
await clickNth(cdp, '.wb-view-tab', 0);
check('回到预览视图', await waitFor(cdp, `!!document.querySelector('.typora-paper-article, .academic-article')`));
check('未解析链接有专门样式', await waitFor(cdp, `!!document.querySelector('.wikilink-unresolved')`, 6000));
await click(cdp, '.wikilink-unresolved');
const created = await waitFor(cdp, `true`, 400);
await sleep(1500);
check('点击后磁盘上出现新笔记', existsSync(NEW_NOTE_PATH), NEW_NOTE_PATH);
check('新笔记已打开', await waitFor(cdp, `(document.querySelector('.doc-tab.active')?.innerText ?? '').includes(${JSON.stringify(NEW_NOTE)})`, 5000));
const seeded = existsSync(NEW_NOTE_PATH) ? (await import('node:fs')).readFileSync(NEW_NOTE_PATH, 'utf8') : '';
check('新笔记带同名标题种子', seeded.includes(`# ${NEW_NOTE}`), JSON.stringify(seeded.slice(0, 40)));

report(cdp);
