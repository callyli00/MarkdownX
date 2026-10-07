# MarkdownX 维护手册

面向"接手/续做这个项目的人（或 AI）"的操作文档。README 讲**功能与历史**，本手册讲**怎么改、怎么验证、怎么发版**，
以及**哪些坑真的踩过、哪些结论真的验证过**。

> 对应版本：v2.3.7（2026-10-07）。每条操作都来自本项目的实际执行记录，不是推测。

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
| `src/pdf/` | — | PDF 预览/标注/结构编辑（v2.3.0 新增；纯逻辑带 Vitest 覆盖） |
| `scripts/copy-pdfjs.cjs` / `scripts/copy-cjk-font.cjs` | — | 离线拷贝 PDF.js 资源与 CJK 便签字体 |

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

- `bundle.fileAssociations`：两个类型 —— `md / markdown / mdown / mkd / mdx`（`Markdown Document`，
  role=Editor）与 `pdf`（`PDF Document`，role=Viewer）。
- `installer-hooks.nsh`：写 `OpenWithProgids`；**仅在该扩展名无 `UserChoice` 时**认领默认值；
  结束调用 `SHChangeNotify` 立即刷新；卸载对称回收。
- **新增一个文件类型要同时改三处，缺一处就会"能手选但看不到/或能看到但关联不上"**：
  1. `tauri.conf.json` → `bundle.fileAssociations` 增加条目（决定 ProgID、图标、打开命令）。
  2. `installer-hooks.nsh` → `MDXClaimExt` / `MDXReleaseExt` 各加一行（宏已参数化为
     `PROGID EXT` 两参，新类型用自己的 ProgID）。只改 ① 不改 ②：能关联但不会出现在
     "打开方式"里；只改 ② 不改 ①：ProgID 没有 command，双击会失败。
  3. 若该类型要出现在**侧栏工作区文件树**，还要在 `src-tauri/src/lib.rs` 的
     `read_dir_files` 扩展名白名单里加上它（这是独立的一处，与系统关联无关）。
- PDF 关联的默认行为：`.pdf` 通常已被 Edge/Acrobat 占用 `UserChoice`，所以安装**不会**抢占默认，
  只是把 MarkdownX 加进"打开方式"；用户可在「设置 → 默认应用 → 按文件类型选择默认应用」指定。
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

## 8.5 Contents API 上传大文件的坑（v2.3.1 实测）

- `scripts/release-update.mjs --publish` 走 GitHub **Contents API**（`PUT /repos/.../contents/<file>`）
  上传安装包。安装包 ≤ 5.4 MB（v2.2.4）时能过；到 13 MB（v2.3.0 / v2.3.1）时该请求**稳定返回
  `401 Bad credentials`** —— 而同一时刻 `gh api user`（读）和 `gh release create`（资产上传）都正常，
  所以这是**大 body 的上传被拒**，不是凭据真的坏了。**不要**因此去动凭据。
- 可靠替代路径（两条都用 git/gh 的正常能力）：
  1. **分支发布**：临时目录 `git init` → 放 `MarkdownX_<ver>_x64-setup.exe` + `latest.json`
     → `git push -f origin HEAD:release-assets`（git push 走 credential manager，不受影响）。
  2. **Release 兜底**：`gh release create v<ver> --notes ... <exe> <latest.json>`；
     若上传中断，用 `gh release upload v<ver> <exe> --clobber` 补传（13 MB 约需 2–3 分钟），
     再用 `gh release edit v<ver> --draft=false --latest` 把 Draft 转正。
- 症状自查：`gh release list` 里出现 **Draft** 且资产不全 → 就是上传被中断。

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
- 单元测试：`npm run test`（Vitest，覆盖 `src/pdf/` 纯逻辑）；**渲染护栏 `gate.cjs` 仍需手动执行**；无 CI。
- `README.md` 变更日志很长（历史包袱），新改动只需在顶部加一节。

---

## 11. 待办与可选项

- targets 已收敛为 `["nsis"]`；若需要 Linux 包再补 `appimage`/`deb`。
- 状态栏保持通栏（用户明确要求不动）；侧边栏贯通到状态栏上沿。
- 可选：把 `git`/`gh` 加入 PATH、把浏览器 harness 固化到 `tools/ui-harness/`、加 `npm run gate` 脚本。
- PDF 后续可选：页面缩略图导航、PDF 内文本搜索、标注清单导出、原生 `/Annots` 字典。

---

## 12. PDF 模块（v2.3.0 新增）

### 12.1 分层

| 文件 | 职责 |
|---|---|
| `src/pdf/pathKind.ts` | 零依赖 `isPdfPath`（可在 Node 测） |
| `src/pdf/openPdf.ts` | 经 plugin-fs `readFile` 读字节；`%PDF` 魔数在前 1024 字节内搜索 |
| `src/pdf/pdfjs.ts` | PDF.js 启动：worker(`?url`) + 离线 cMaps/标准字体 |
| `src/pdf/PdfViewer.tsx` | 多页 canvas + 工具条 + 可见页追踪（IntersectionObserver） |
| `src/pdf/PdfAnnotLayer.tsx` | SVG 标注覆盖层（高亮/下划线/删除线/便签/墨迹） |
| `src/pdf/annotations.ts` | 标注模型（归一化坐标 0..1，top-left 原点） |
| `src/pdf/coords.ts` | CSS 像素 ↔ 归一化 ↔ PDF 点（含 /Rotate 处理） |
| `src/pdf/annotStore.ts` | 标注嵌入 PDF 目录私有键 `MarkdownXAnnots`（base64 JSON） |
| `src/pdf/flatten.ts` | 压平到内容流；CJK 便签用 Noto Sans SC 子集 |
| `src/pdf/structuralOps.ts` | 旋转/删页/插页/重排/提取/合并/拆分/元数据 |
| `src/pdf/cjkFont.ts` | 记忆化 fetch `/fonts/NotoSansSC-Regular.ttf` |

### 12.2 三条必须记住的坑

1. **`bytes.slice()` 是强制的**：pdf.js 会把 `data` 的 ArrayBuffer **转移（transfer）**给 worker；
   不复制的话调用方手里的 `Uint8Array` 会变成零长度，保存时写出空文件。
2. **中文 PDF 必须有 cMaps**：否则 pdf.js 渲染成方框（空白/豆腐块）。资源靠
   `scripts/copy-pdfjs.cjs` 从 node_modules 拷到 `public/pdfjs/`；换 pdfjs 版本后要重跑。
3. **不要把 pdf-lib 静态导入 `App.tsx`**：pdf-lib + fontkit ≈ 1 MB。它们在各个调用点用
   `await import()` 动态引入；一旦改回静态导入，启动包会从 ~350 kB 涨回 ~1.4 MB。
4. **文字选择依赖文本层**：pdf.js 只把字形画进 `<canvas>` 的像素里，**必须**在每页再叠一层
   `TextLayer`（`.pdf-text-layer`，透明文字 spans）。少了它，PDF 里的文字不可选中、不可复制，
   高亮/下划线也就无从实现。另外：高亮类工具的事件必须**穿透**标注层（`pointer-events: none`）
   才能选字，只有便签/墨迹/框选删除才让标注层接收指针事件。
5. **文本层必须设 `--scale-factor`**：pdf.js 的 span 用 `calc(var(--scale-factor) * Xpx)` 定位、
   层宽也用它推导，但 **pdf.js 自己不会设这个变量**（那是宿主 viewer 的职责）。
   每页渲染前执行 `textDiv.style.setProperty('--scale-factor', String(scale))`；
   同时**不要**手动写 `textDiv.style.width/height`，交给 `TextLayer.render()` 推导。
   漏设的症状：低缩放时选中高亮与文字明显错位，放大后"看起来好转"。

### 12.3 保存语义（用户拍板）

- **Ctrl+S**：标注写回 PDF 内嵌私有键 → **仍可再编辑**（不压平）。
- **导出压平副本**：烧进页面内容流 → 任何阅读器可见、不可再编辑；中文便签用
  Noto Sans SC（SIL OFL）子集嵌入。

### 12.4 已核实的字体来源

`@expo-google-fonts/noto-sans-sc@0.4.4` 的 `400Regular/NotoSansSC_400Regular.ttf`
（10,559,284 B，SIL OFL，允许再分发）。
**反例**：`@fontsource/noto-sans-sc` 只发按 Unicode 分片的 woff2，字形表不完整，pdf-lib 不能用。
**禁用**：Windows 系统字体（微软 EULA 不允许把其字体嵌入再分发的 PDF）。

### 12.5 PDF 打印为什么不能用 `window.print()` 直接打

直接打印实时查看器会把 canvas **塞进通用 A4 打印样式表重新排版**：结果既带上工具条/界面元素，
又被按 A4 重新分页（尤其实 PDF 本身不是 A4 时）。正确做法（v2.3.4 起）：

1. `PdfViewer` 把每页 canvas 转成 `data:image/png`；
2. **写进一个隐藏 iframe 的独立文档**再打印 —— 这是关键：把内容放进应用自己的 DOM 里
   （哪怕离屏、哪怕 `@page` 后注入）都会被应用打印样式表干扰，实测出现空白页/首张空白。
   iframe 文档只含 `@page { size: <W>mm <H>mm; margin: 0 }` + `html,body{margin:0}` +
   每页一张 `<img>`（`width:100%`、`img:not(:last-child){page-break-after:always}`）；
3. 纸张尺寸取 `viewport.rawDims`（72dpi 页面单位）换算 mm（`× 25.4 / 72`），与 PDF 自身一致；
4. **打印前必须等图像解码**：轮询 `img.complete && naturalWidth > 0` 后再 `contentWindow.print()`
   （留 5s 兜底），否则打印管线可能对着未绘制的图像输出空白；
5. **每页图像必须用一个严格小于页面的盒子**：`width: calc(<W>mm - 0.6mm)` /
   `height: calc(<H>mm - 0.6mm)` + `margin: 0 auto` + `object-fit: contain`。
   用 `width:100%; height:auto` 看似正确，但**只要图像纵横比比纸张高一丁点**（画布尺寸取整、
   或该页尺寸与第一页不同），就会溢出当前页并多出一个近乎空白的 sheet —— 表现为
   **"一页正常、一页空白"**；0.3mm 边距在成品上不可见，但换来"任何纵横比都不溢出"的确定性；
6. 打印结束后移除 iframe。

> 复现与验证方法（建议照做，别再靠猜）：把同样的 CSS 与若干张 N 页图像放进一个独立 HTML，
> 用真实打印管线（CDP `Page.printToPDF`，`preferCSSPageSize: true`）输出，统计 PDF 的
> `/Count` 页数是否等于图像数。上面第 5 条就是这么定位的：3 张图打出 6 页 → 改 CSS 后 3 页。

已知边界：**逐页尺寸不同的 PDF 只能按第一页的纸张尺寸输出**（CSS 一个文档只能有一条 `@page size`）。

### 12.6 标注的两种操作习惯都要支持

- **先选工具再选文字**：松手即标注（`PdfViewer` 内部完成）。
- **先选文字再按工具按钮**：`PdfViewer` 通过 `onSelectionChange` 把待应用选区上报给 `App`，
  由工具栏按钮触发；按完保持该工具激活，方便连续标注。

两条路径共用同一份归一化选区数据，避免两套逻辑漂移。
