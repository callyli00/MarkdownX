// P7 真机冒烟（CDP）：命令面板。
//
// 前提：应用带远程调试启动（任意工作区）：markdown-x.exe "C:/tmp/vault7"
// 运行：node tools/local-check/smoke-p8.mjs
//
// 判据：Ctrl+Shift+P 打开面板；输入能过滤（中文子串与英文关键词都行）；Enter 执行
// （用「反链 / 提及 / 标签面板」验证——执行后侧栏出现 .links-tab）；Esc 关闭。
import { connect, sleep, check, typeInto, pressKey, waitFor, report } from './cdp-harness.mjs';

const cdp = await connect();
const PANEL = `!!document.querySelector('.palette-overlay')`;

async function chord(cdp, modifiers, key, code, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(350);
}

check('应用已渲染', await waitFor(cdp, `!!document.querySelector('.sb-searchbar')`));

// Ctrl(2) + Shift(8) + P
await chord(cdp, 10, 'P', 'KeyP', 80);
check('Ctrl+Shift+P 打开命令面板', await waitFor(cdp, PANEL, 4000));
check('输入框自动聚焦', (await cdp.eval(`document.activeElement?.className || ''`)).includes('palette-input'));

const initialRows = Number(await cdp.eval(`document.querySelectorAll('.palette-row').length`));
check('未输入时列出命令', initialRows >= 8, String(initialRows));

await typeInto(cdp, '.palette-input', '提及');
await sleep(400);
const rows = await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('.palette-row')).map((e) => e.innerText.replace(/\\s+/g, ' ').trim()))`);
const parsed = JSON.parse(rows);
check('中文子串能过滤出目标命令', parsed.length >= 1 && parsed[0].includes('提及'), rows);

await typeInto(cdp, '.palette-input', 'theme');
await sleep(400);
const byKeyword = JSON.parse(
  await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('.palette-row')).map((e) => e.innerText))`)
);
check('英文关键词也能命中', byKeyword.length >= 1 && byKeyword[0].includes('主题'), JSON.stringify(byKeyword));

// Enter 执行：回到"提及"那条
await typeInto(cdp, '.palette-input', '提及');
await sleep(400);
await pressKey(cdp, 'Enter', 'Enter', 13);
await sleep(900);
check('执行后关闭面板', (await cdp.eval(PANEL)) === false);
check('命令真的生效（侧栏切到链接面板）', await waitFor(cdp, `!!document.querySelector('.links-tab')`, 5000));

// Esc 关闭
await chord(cdp, 10, 'P', 'KeyP', 80);
check('再次打开', await waitFor(cdp, PANEL, 4000));
await pressKey(cdp, 'Escape', 'Escape', 27);
await sleep(400);
check('Esc 关闭面板', (await cdp.eval(PANEL)) === false);

report(cdp);
