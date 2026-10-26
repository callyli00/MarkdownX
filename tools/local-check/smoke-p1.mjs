// P1 / P6 真机冒烟（CDP）：全库检索、命中跳转、任务复选框写回、全库替换。
//
// 前提：应用已带远程调试启动，并且工作区就是夹具仓库：
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334
//   markdown-x.exe "C:\tmp\smoke-vault"
// 运行：node tools/local-check/smoke-p1.mjs
//
// 这里全部用 CDP 的 Input.dispatchMouseEvent / Input.insertText 发**受信任**输入，
// 不用 el.click() —— React 18 的事件委托下 el.click() 触发的合成点击不会走 onClick
// （v2.7.0 冒烟时踩过这个坑）。
const PORT = process.env.MDX_CDP_PORT || '9334';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 应用还没起来
    }
    await sleep(500);
  }
  throw new Error(`CDP 未就绪（端口 ${PORT}）`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = message.id ? this.pending.get(message.id) : null;
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  static async attach(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 15000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面内异常');
    }
    return result.result.value;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

async function center(cdp, selector) {
  const box = await cdp.eval(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
      `if (!el) return null; const r = el.getBoundingClientRect();` +
      `if (!r.width || !r.height) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  if (!box) throw new Error(`找不到可点击元素：${selector}`);
  return box;
}

async function click(cdp, selector) {
  const { x, y } = await center(cdp, selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(150);
}

async function typeInto(cdp, selector, text) {
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  // 清空再输入：React 受控 input 需要真实 input 事件才会更新 state
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text });
  await sleep(250);
}

const countOf = (cdp, selector) => cdp.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const textOf = (cdp, selector) => cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);

async function waitFor(cdp, expression, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return true;
    await sleep(120);
  }
  return false;
}

const page = await findPage();
const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');

check('应用已渲染', await waitFor(cdp, `!!document.querySelector('.sb-searchbar')`));
check('工作区已打开（命令行参数）', await waitFor(cdp, `!!document.querySelector('.file-tree-item, .sb-doc-item, .sidebar-doc-item, .sb-tree-row')`, 12000));

// --- 打开搜索面板并切到全库 ---------------------------------------------------------
await click(cdp, '.sb-searchbar');
check('搜索面板出现', await waitFor(cdp, `document.querySelectorAll('.search-scope-btn').length === 2`));
await click(cdp, '.search-scope-btn:nth-of-type(2)');
check('已切到全库模式', (await cdp.eval(`document.querySelector('.search-input')?.placeholder ?? ''`)).includes('关键词'));

// --- 检索 ---------------------------------------------------------------------------
await typeInto(cdp, '.search-input', '湍流');
await sleep(400);
const hitCount = await countOf(cdp, '.vault-hit');
const countLabel = await textOf(cdp, '.search-count-label');
// alpha 有 4 处（同一行「湍流模型里 … #流体/湍流」算两处），gamma 有 1 处 → 5 处 / 2 个文件
check('命中 5 处 / 2 个文件', hitCount === 5 && /5 处/.test(countLabel) && /2 个文件/.test(countLabel), `面板显示：${countLabel}`);

// 过滤运算符：tag:力学 只应命中 alpha.md
await typeInto(cdp, '.search-input', 'tag:力学 湍流');
await sleep(400);
check('tag: 过滤生效（只留 alpha 的 4 处）', (await countOf(cdp, '.vault-hit')) === 4, `命中 ${await countOf(cdp, '.vault-hit')} 行`);

// --- 命中跳转 -----------------------------------------------------------------------
await typeInto(cdp, '.search-input', '湍流');
await sleep(400);
await click(cdp, '.vault-hit');
const activeName = await cdp.eval(`document.querySelector('.doc-tab.active .doc-tab-name, .doc-tab.active')?.innerText ?? ''`);
check('点命中后打开了 alpha.md', /alpha/.test(activeName), `当前标签：${activeName.trim()}`);
check('命中块被定位并闪烁', await waitFor(cdp, `!!document.querySelector('.jump-target-flash')`, 4000));

// --- 任务复选框写回 ----------------------------------------------------------------
const beforeChecked = await cdp.eval(
  `document.querySelector('.task-list-item input[type=checkbox]')?.hasAttribute('checked') ?? null`
);
check('预览里有任务项', beforeChecked !== null);
await click(cdp, '.task-list-item');
await sleep(1200);
const afterChecked = await cdp.eval(
  `document.querySelector('.task-list-item input[type=checkbox]')?.hasAttribute('checked') ?? null`
);
check('点击复选框写回源码（状态翻转）', beforeChecked !== afterChecked, `${beforeChecked} → ${afterChecked}`);

// --- 全库替换 -----------------------------------------------------------------------
await typeInto(cdp, '.search-input', '湍流');
await sleep(400);
await typeInto(cdp, '.replace-input', '紊流');
await click(cdp, '.replace-btns .replace-action-btn');
check('替换需要二次确认', await waitFor(cdp, `!!document.querySelector('.replace-action-btn.danger')`));
await click(cdp, '.replace-action-btn.danger');
const notice = await waitFor(cdp, `(document.querySelector('.search-view .sidebar-empty-hint')?.innerText ?? '').includes('已替换')`, 8000);
check('替换完成并给出提示', notice, `${await textOf(cdp, '.search-view .sidebar-empty-hint')}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
cdp.socket.close();
if (failed.length > 0) {
  console.log(`失败项：${failed.map((f) => f.name).join('、')}`);
  process.exitCode = 1;
}
