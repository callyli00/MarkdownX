# MarkdownX 维护手册

面向"接手/续做这个项目的人（或 AI）"的操作文档。README 讲**功能与历史**，本手册讲**怎么改、怎么验证、怎么发版**，
以及**哪些坑真的踩过、哪些结论真的验证过**。

> 对应版本：v2.2.3（2026-10-06）。每条操作都来自本项目的实际执行记录，不是推测。

---

## 1. 三分钟上手

```bash
npm install                 # 顺带执行 postinstall 拷 MathJax 离线包
npm run dev                 # 仅前端热更
npm run tauri dev           # 完整桌面应用（Rust 增量编译较慢）

# 改动后必过的两道门
npx tsc --noEmit                                    # 类型检查
node tools/render-equivalence-gate/gate.cjs         # 渲染等价护栏（见 §6）
```

打包（Windows）：

```bash
export MSYS2_ARG_CONV_EXCL='*'
export TAURI_SIGNING_PRIVATE_KEY="C:/Users/callyli00/.tauri/markdownx-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build          # 缺私钥则不会产出 .sig，自动升级即失效
```

---

## 2. 项目结构（关键文件与职责）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/App.tsx` | ~4135 | **单组件应用**：状态、布局、菜单、文档标签、更新弹窗、位置映射调用点 |
| `src/App.css` | ~3260 | 全部样式：工作台 token、外壳、**打印规则**、右键菜单、更新弹窗 |
| `src/AppIcon.tsx` | 89 | 线性图标库（`<AppIcon name="..." />`），新增图标在此登记 |
| `src/utils/markdownRenderer.ts` | ~1026 | **渲染管线**：`renderMarkdown`（整篇）/`renderMarkdownPayload`（Worker 安全）/`finalizeAssetUrls`（主线程）；公式与引用 token 化；位置锚点 `data-src-*`；Mermaid 与代码遮蔽 |
| `src/utils/renderClient.ts` | ~140 | 渲染客户端：≥20KB 走 Worker，**任何失败回退同步**（只慢不错） |
| `src/utils/renderWorker.ts` | 47 | Worker 入口（纯字符串→字符串，禁止引入 DOM 依赖） |
| `src/utils/updater.ts` | ~109 | 自动升级：检查/安装，**失败归一为状态值，绝不抛错** |
| `src-tauri/src/lib.rs` | ~214 | Rust 命令、**单实例回调**、文件监视器、插件注册 |
| `src-tauri/installer-hooks.nsh` | 67 | NSIS 钩子：文件关联（`OpenWithProgids` + 仅认领无主类型 + 立即刷新） |
| `src-tauri/tauri.conf.json` | ~89 | 窗口/CSP/打包目标/**文件关联**/**updater 端点与公钥** |
| `scripts/release-update.mjs` | ~271 | 发布：签名打包 → 清单 → 上传 raw + 建 Release → **自动实测** |
| `scripts/copy-mathjax.cjs` | ~85 | 离线 MathJax 打包（含 35 个 TeX 扩展；缺了公式会报错） |
| `tools/render-equivalence-gate/` | — | 渲染等价护栏（语料 + 黄金文件 + gate） |

Tauri 命令：`get_cli_args`、`read_file_from_path`、`read_dir_files`、`toggle_fullscreen`、
`toggle_always_on_top`、`open_devtools`、`start_watching_file`、`stop_watching_file`。
权限见 `src-tauri/capabilities/default.json`（含 `updater:default`、`process:allow-restart`）。

---

## 3. 版本号同步（6 处，缺一处就"版本不符"）

| 文件 | 字段 |
|---|---|
| `package.json` | `version` |
| `package-lock.json` | 根 `version` **和** `packages[""].version`（两处） |
| `src-tauri/Cargo.toml` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src/App.tsx` | `const APP_VERSION` **和** `RELEASE_NOTES` 头部条目 |
| `README.md` | 标题 `# MarkdownX (vX.Y.Z)` **和** 新增 `### [vX.Y.Z] - 日期` 一节 |

`RELEASE_NOTES` 与 README 那一节就是**更新弹窗显示的说明**（发布脚本从 README 取，单一来源）。

---

## 4. 发布流程（已端到端验证）

```bash
# ① 改版本号 + 在 README 写 ### [vX.Y.Z] - 日期 说明
# ② 签名打包 + 生成 latest.json
node scripts/release-update.mjs --owner callyli00 --repo MarkdownX
# ③ 上传 raw 分支 + 建/更新 Release + 自动实测三条链路
node scripts/release-update.mjs --owner callyli00 --repo MarkdownX --skip-build --publish
```

`--publish` 会自动：清理被取代的旧安装包 → 上传安装包与 `latest.json` → 创建/更新 GitHub Release
→ **打印 raw 与 Release 的 HTTP 结果**。看到三行 `✓ HTTP 200` 才算发布成功。

| 发布会落点 | 内容 | 用途 |
|---|---|---|
| 分支 `release-assets` | 仅 2 个文件（孤立提交，每次覆盖） | **应用首选**拉取源（raw，不依赖 github.com） |
| GitHub Release `vX.Y.Z` | 安装包 + `latest.json` | 人类查看 / 标签 / 订阅 / **兜底端点** |
| `src-tauri/target/release/bundle/` | NSIS 安装包 + `.sig` + `latest.json` | 本地产物 |

**签名私钥**：`C:\Users\callyli00\.tauri\markdownx-updater.key`（仓库外、未被 git 跟踪）。
**丢了它，已安装客户端将永久无法接受后续更新** —— 请离线备份到密码管理器。配置里只有公钥。

---

## 5. 自动升级机制（应用检查、用户决定、不回滚）

- 启动后延迟 20 秒**静默检查**；发现新版本只在**帮助图标点一个小圆点**，菜单显示「检查更新（有新版本 vX）」。
- 点「下载并安装」才：下载 → **minisign 签名校验** → 静默安装（`installMode: passive`）→ 自动重启。
- **任何失败静默跳过并记日志**，绝不阻塞启动、绝不弹错误框；只有手动「检查更新…」才显示失败原因。
- 端点（`plugins.updater.endpoints`，**按序尝试**）：

```json
[ "https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/latest.json",
  "https://github.com/callyli00/MarkdownX/releases/latest/download/latest.json" ]
```

**为什么 raw 优先**（本机实测）：raw 清单 0.42s / 包 1.76s、**0 次跳转**，完全不经过 `github.com`；
Release 路线 1.28s / 2.84s，**必须先过 `github.com`** —— 该主机在本网络**时通时断**（曾测得 12 秒超时/连接重置）。
因为检查是静默的，指向"当时拉不到"的宿主会表现为**自动升级永不触发且无任何提示**，故把最抗断的放前面。

**故障排查**

| 现象 | 先查 |
|---|---|
| 永远没有小圆点 | ①端点是**编译期写死**的（见 §8 引导版）②`curl` 两个端点是否 200 ③raw 有几分钟缓存 |
| 弹窗「检查更新失败」 | 弹窗里有原因行；`updater.ts` 把异常归一为 `status:'error'` |
| 下载卡住/失败 | 清单本身可达 ≠ 安装包可达；清单里的 `url` 要单独 `curl` 验证 |
| 签名校验失败 | 发布私钥与配置公钥是否同一对；`.sig` 是否本次构建产物 |

---

## 6. 必须保持的不变量

1. **打开文档时公式必须自动渲染**（v1.9.7–v1.9.12 曾因分片/按需排版破坏它，被整体回退）。
2. **源码⇄预览双向位置连续**：`data-src-*` 锚点 + 块内对齐；双击预览落到源码对应字符。
3. **打印输出不含任何界面**：顶栏/侧栏/格栅/标签条/状态栏/右键菜单都在 `@media print` 隐藏列表；
   **新增外壳元素必须同步加进该列表**（v1.9.0 改版时漏过，用户真的打印出了侧栏）。
4. **Worker 只是优化**：失败必须回退同步渲染 —— 只允许变慢，不允许不渲染。
5. **渲染等价护栏必须 PASS**：①Worker 路径 ≡ 同步路径（逐字节）②与历史黄金文件一致
   ③LF 与 CRLF 渲染结构一致 ④源码含行间公式就必须产出公式标记。改动渲染器后必跑。
6. **单实例语义**：第二次双击由单实例插件转发给已有窗口；`argv[0]` 必须剔除（否则会把 exe 当文档打开）。

---

## 7. 文件关联（安装时由 NSIS 钩子完成）

- `bundle.fileAssociations`：`md / markdown / mdown / mkd / mdx`。
- `installer-hooks.nsh`：写 `OpenWithProgids`；**仅在该扩展名无 `UserChoice` 时**认领默认值；
  结束调用 `SHChangeNotify` 立即刷新；卸载对称回收。
- 关键注册表位置（均为 HKCU，无需管理员）：

| 键 | 作用 |
|---|---|
| `HKCU\Software\Classes\.md`（默认值） | 扩展名 → ProgID `Markdown Document` |
| `HKCU\Software\Classes\Markdown Document\shell\open\command` | 打开命令（`%LOCALAPPDATA%\MarkdownX\markdown-x.exe "%1"`） |
| `HKCU\...\Explorer\FileExts\.md\UserChoice` | **用户选择的默认程序**（Win10/11 带 Hash，程序不可静默改写） |
| `HKCU\Software\Classes\Applications\<exe>` | 按 exe 路径登记的"打开方式"条目 —— **幽灵条目来源**，除本次安装外不应存在 |

**"打开方式里有多个 MarkdownX 且图标空白"** = 存在指向已删除路径的登记项（曾因 `C:\Program Files\MarkdownX` 被删而出现）。
排查：全树搜索 `markdown-x`，逐条判断目标文件是否存在，删掉失效项。

---

## 8. 已知坑与纪律（每条都真的踩过）

- **源码写入会静默丢失**：`write_file`/`patch` 报成功但内容没变（本轮 CSS、JSX、发布脚本、维护手册各中过一次）。
  **规则：每次改动后立刻 `grep` 校验，并尽快提交**（提交后就不会丢）。
- **CRLF 是隐形杀手**：行尾锚定正则漏 `\r` 会让"代码围栏未闭合"，其后整段被遮蔽、公式全部不识别。
  改扫描类代码后必须用 LF 与 CRLF 两种语料验证（`gate.cjs` 第二相）。
- **一次性测量不能下结论**：`github.com` 曾 12 秒超时被判"不可用"，几分钟后同一 URL 返回 200。
- **给原生程序的路径**：本 shell 关闭 MSYS 转换，`$HOME`/`/tmp` 传给 `git`/`gh`/`curl` 会失败；用 `C:/...`。
- **`curl -o /dev/null` 在 Windows 退出码 23**：请求其实成功；改用 `-o NUL` 并容忍非零退出。
- **捕获阶段的全局右键压制会吃掉所有 `onContextMenu`**：加自定义右键前先检查它。
- **`gh`/`git` 在已开着的 PowerShell 里"找不到"**：包管理器只对新进程更新 PATH；新开窗口或用完整路径。
- **仓库里不要放**：`node_modules/`、`src-tauri/target/`、签名私钥、任何 token。
- **不要用 MSI**：targets 已收敛为 `["nsis"]`（MSI 用另一套 ProgID，会在"打开方式"里再添一份）。

---

## 9. 验证方法论（"能跑"必须有证据）

| 层次 | 手段 |
|---|---|
| 类型/构建 | `npx tsc --noEmit`、`npm run build` |
| 渲染正确性 | `tools/render-equivalence-gate/gate.cjs`（两相均需 PASS） |
| 界面行为 | 浏览器驱动 + **注入 Tauri 桩**（`window.__TAURI_INTERNALS__`）：断言 DOM、模拟点击、读计算样式 |
| 打印 | `Emulation.setEmulatedMedia('print')` + 断言 `display:none` 与 `innerText` 无界面文字 |
| 组件状态 | 从 `__reactFiber$*` 链读 `memoizedState`（源码看起来对但界面不符时用） |
| 升级/安装 | **系统侧确认**：exe 的 `VersionInfo.FileVersion` + 卸载项 `DisplayVersion` |
| 网络可达性 | 对每个候选 URL `curl` 计时与跳转数（见 §5） |

浏览器 harness 目前在临时目录、不随仓库分发；**仓库内持久可复现的只有 tsc + gate**，其余需按上表重建。

---

## 10. 已知边界（诚实声明）

- 自动升级端到端**已实测一次**（2.2.2 → 2.2.3，系统侧确认文件版本变化）；其余版本依赖同一路径。
- 尚无 CI/自动化测试；`gate.cjs` 需手动执行。
- `README.md` 变更日志很长（历史包袱），新改动只需在顶部加一节。

---

## 11. 待办与可选项

- targets 已收敛为 `["nsis"]`；若需要 Linux 包再补 `appimage`/`deb`。
- 状态栏保持通栏（用户明确要求不动）；侧边栏贯通到状态栏上沿。
- 可选：把 `git`/`gh` 加入 PATH、把浏览器 harness 固化到 `tools/ui-harness/`、加 `npm run gate` 脚本。
