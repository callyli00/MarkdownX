// P6 真机冒烟（CDP）：粘贴图片入库。
//
// 前提：应用带远程调试启动，工作区为夹具副本（alpha.md 可写）：
//   markdown-x.exe "C:/tmp/vault7"
// 运行：node tools/local-check/smoke-p7.mjs
//
// 判据：在源码模式里粘贴一张图片（合成 ClipboardEvent + DataTransfer，等价于 Ctrl+V），
// 1) 图片字节落到 <笔记目录>/assets/pasted-*.png；2) 编辑器里插入标准 Markdown 图片语法；
// 3) 保存后 .md 里确实写着这行；4) 界面上有"已存入"的提示（不静默吞掉）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { connect, sleep, check, waitFor, report } from './cdp-harness.mjs';

const VAULT = 'C:\\tmp\\vault7';
const ASSETS = `${VAULT}\\assets`;
const NOTE = `${VAULT}\\alpha.md`;

const cdp = await connect();

async function clickByTitle(cdp, title) {
  const box = await cdp.eval(
    `(() => { const el = Array.from(document.querySelectorAll('[title]')).find((e) => (e.getAttribute('title') || '').includes(${JSON.stringify(title)}));` +
      ` if (!el) return null; const r = el.getBoundingClientRect();` +
      ` return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  if (!box) throw new Error(`找不到 title 含「${title}」的元素`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(400);
}

async function openNote(cdp, name) {
  const box = await cdp.eval(
    `(() => { const el = Array.from(document.querySelectorAll('.file-tree-item, .sb-tree-row, .sidebar-doc-item, .sb-doc-item')).find((e) => (e.innerText || '').includes(${JSON.stringify(name)}));` +
      ` if (!el) return null; const r = el.getBoundingClientRect();` +
      ` return { x: r.left + Math.min(r.width / 2, 100), y: r.top + r.height / 2 }; })()`
  );
  if (!box) throw new Error(`侧栏里没有 ${name}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(700);
}

check('应用已渲染', await waitFor(cdp, `!!document.querySelector('.sb-searchbar')`));
check('工作区已打开', await waitFor(cdp, `!!document.querySelector('.file-tree-item, .sb-tree-row, .sidebar-doc-item, .sb-doc-item')`, 12000));

await openNote(cdp, 'alpha.md');
// 源码模式（textarea 只在这个视图存在）
await clickByTitle(cdp, '源码模式');
check('已进入源码模式', await waitFor(cdp, `!!document.querySelector('.typora-fullscreen-textarea')`, 8000));

// 合成一次粘贴：带一张 1x1 PNG 的 DataTransfer
const pasteResult = await cdp.eval(
  `(async () => {
     const ta = document.querySelector('.typora-fullscreen-textarea');
     if (!ta) return 'no-textarea';
     const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
     const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
     const file = new File([bytes], 'shot.png', { type: 'image/png' });
     const dt = new DataTransfer();
     dt.items.add(file);
     ta.focus();
     const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
     ta.dispatchEvent(event);
     return event.defaultPrevented ? 'handled' : 'not-prevented';
   })()`
);
check('粘贴事件已被应用接管（不是被 textarea 静默吞掉）', pasteResult === 'handled', String(pasteResult));

await sleep(2500);

const textareaValue = await cdp.eval(`document.querySelector('.typora-fullscreen-textarea')?.value || ''`);
check('编辑器里插入了 Markdown 图片语法', /!\[\]\(assets\/pasted-\d{8}-\d{6}-[0-9a-f]+\.png\)/.test(textareaValue), textareaValue.slice(-160));

check('assets 目录已创建', existsSync(ASSETS));
const files = existsSync(ASSETS) ? readdirSync(ASSETS).filter((f) => /^pasted-.*\.png$/.test(f)) : [];
check('图片以规范文件名落盘', files.length === 1, JSON.stringify(files));
check('落盘内容非空', files.length === 1 && statSync(`${ASSETS}\\${files[0]}`).size > 0);

check(
  '界面给了"已存入"的提示（不静默）',
  await waitFor(cdp, `(document.querySelector('.external-reload-toast')?.innerText || '').includes('图片已存入')`, 5000)
);

// 保存后 .md 里应当有这一行
await cdp.send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 's',
  code: 'KeyS',
  windowsVirtualKeyCode: 83,
  nativeVirtualKeyCode: 83,
  modifiers: 2
});
await cdp.send('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 's',
  code: 'KeyS',
  windowsVirtualKeyCode: 83,
  nativeVirtualKeyCode: 83,
  modifiers: 2
});
await sleep(1800);
const saved = existsSync(NOTE) ? readFileSync(NOTE, 'utf8') : '';
check('保存后 .md 里确有这行引用', /!\[\]\(assets\/pasted-.*\.png\)/.test(saved), saved.split('\n').filter((l) => l.includes('assets/')).join(' | '));

report(cdp);
