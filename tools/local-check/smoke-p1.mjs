// P1 / P6 真机冒烟（CDP）：全库检索、命中跳转、任务复选框写回、全库替换。
//
// 前提：应用已带远程调试启动，并且工作区就是夹具仓库的副本：
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334
//   markdown-x.exe "C:\tmp\vault2"
// 运行：node tools/local-check/smoke-p1.mjs
//
// 脚手架在 cdp-harness.mjs（受信任输入、断言汇总），两个冒烟脚本共用。
import { connect, sleep, check, click, typeInto, waitFor, countOf, textOf, report } from './cdp-harness.mjs';

const cdp = await connect();

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

report(cdp);
