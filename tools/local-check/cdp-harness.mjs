// 共享 CDP 冒烟脚手架：连接、受信任输入、断言汇总。
//
// 为什么不用 el.click()：React 18 的事件委托下，脚本里 `el.click()` 触发的合成点击不会走到
// React 的 onClick（v2.7.0 冒烟时踩过这个坑）。所有点击都走 `Input.dispatchMouseEvent`，
// 所有文本都走 `Input.insertText`，这样才是"用户真的点了/真的敲了"。
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function findPage(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 应用还没起来
    }
    await sleep(500);
  }
  throw new Error(`CDP 未就绪（端口 ${port}）`);
}

export class Cdp {
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

/** 连接并启用 Runtime。PORT 默认 9334，可用 MDX_CDP_PORT 覆盖。 */
export async function connect(port = process.env.MDX_CDP_PORT || '9334') {
  const page = await findPage(port);
  const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  return cdp;
}

export const results = [];

export function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

export async function center(cdp, selector) {
  const box = await cdp.eval(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
      `if (!el) return null; const r = el.getBoundingClientRect();` +
      `if (!r.width || !r.height) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  if (!box) throw new Error(`找不到可点击元素：${selector}`);
  return box;
}

export async function click(cdp, selector) {
  const { x, y } = await center(cdp, selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(150);
}

export async function typeInto(cdp, selector, text) {
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  // 清空再输入：React 受控 input 需要真实 input 事件才会更新 state
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text });
  await sleep(250);
}

/** 发一个受信任按键（用于方向键 / Enter / Escape）。 */
export async function pressKey(cdp, key, code, virtualKeyCode) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  });
  await sleep(150);
}

export const countOf = (cdp, selector) => cdp.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
export const textOf = (cdp, selector) => cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);

export async function waitFor(cdp, expression, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return true;
    await sleep(120);
  }
  return false;
}

/** 打印汇总并设置退出码。 */
export function report(cdp) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (cdp) cdp.socket.close();
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((f) => f.name).join('、')}`);
    process.exitCode = 1;
  }
}
