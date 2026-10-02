# MarkdownX (v1.8.1)

> 一款专为计算力学、材料科学及算法推导文档设计的高性能、极简 Typora 风格桌面 Markdown & LaTeX 编辑/排版应用。
> 采用 **Tauri v2 + Rust** 原生内核与 **React 18 + TypeScript + Vite** 前端架构，实现毫秒级启动与超低内存占用。

---

## 核心特性

- **纯正 Typora 沉浸式单栏排版**：默认采用居中出版级纸质版式（标准宽度 860px），优雅自适应留白，支持通过快捷键 `Ctrl + /` 或双击正文一秒在全屏沉浸排版与全屏源码编辑之间来回切换。
- **自主 AST 公式编号与交叉引用引擎**：在前端 AST 编译层自主管理 `\tag{...}` 与 `\label{...}`，彻底杜绝 MathJax 动态渲染中的 `(???)` 标签失效问题；正文中 `\eqref{...}` 自动生成交互式原生直链，点击可平滑滚动定位到对应公式。
- **参数级细粒度排版与字体系统**：
  - **字体族自由混搭**：西文字体族（Times New Roman、Cambria、Georgia、Garamond、Segoe UI、JetBrains Mono、Fira Code）与中文字体族（思源宋体/SimSun、微软雅黑/苹方、楷体、仿宋）独立选择。
  - **段落与间距全控制**：正文字号（12~26px 滑块无级调节）、行高（1.4~2.5）、段间距自由调节。
  - **对齐与缩进规范**：支持两端对齐（末行强制靠左，杜绝尾行拉伸空白）与自然左对齐切换；支持正文首行缩进 2 字符。
  - **版心自适应宽度**：支持 760px（窄版）、860px（标准）、1020px（宽版大图）、1280px 及 100% 全屏自适应。
  - **偏好永久记忆**：所有排版选项自动持久化存储于本地。
- **Typora 原生下拉菜单与文档管理**：
  - 完整复刻 `文件(F)`、`编辑(E)`、`段落/格式(O)`、`视图(V)` 原生菜单。
  - 支持历史打开文件（Recent Files）快捷访问与清空。
  - 顶部中央配备已打开文档下拉管理面板，实时掌握文件存储路径、未保存状态（`•`）并支持多标签一秒切换。
- **大 M 艺术体全新视觉体系**：配备精心设计的大 M 艺术体（Artistic M）全套桌面多尺寸高分辨率图标及 `.ico` 资源，界面菜单与下拉列表均统一嵌入品牌 Logo。
- **科学计算代码高亮**：原生内置 `highlight.js`，针对 Fortran、C++、Python、JSON 等工程计算语言深度调优。
- **文本绘图引擎（Text-to-Diagram）**：原生集成 `mermaid`，在 Markdown 中以 ` ```mermaid ` 围栏直接绘制流程图、时序图、状态图与甘特图，完全离线可用，自动适配纯白/深色/原木三套主题；语法出错时优雅降级为可读源码。

---

## 版本更新履历 (Changelog)

### [v1.8.1] - 2026-10-01

#### 定位可见性与原始 HTML 图片修复 (Landing Highlight & Raw-HTML Figures)
- **双击定位增加落地高亮 (Landing Highlight)**：
  - 从预览双击跳入源码时，在光标所在行绘制一条淡蓝色高亮条（左侧带主题色竖标），并以 1.6 秒淡出；此后只要开始输入即刻清除，不留视觉噪音。
  - 高亮位置依据 textarea 的实际计算样式（行高、内边距）与滚动量精确计算，实测与光标行**逐像素对齐（偏差 0.00px）**；滚动采用绝对定位，目标行恒落在视口上三分之一处。
  - 三套主题（纯白 / 深色 / 原木）均有对应配色。
- **修复原始 HTML 图片无法显示 (Raw HTML `<img>` inside `<figure>`)**：
  - 典型场景：从出版社 HTML 或 LaTeX 导出物粘贴 `<figure><img src="images/ch01-001.jpg">…<figcaption>…</figcaption></figure>`。
  - **根因**：Markdown 图片语法 `![]()` 会经渲染器解析为 `asset://` 本地协议，但原始 HTML 块由 marked 原样透传，`src` 保持为裸相对路径，在 WebView 中永不加载。
  - **修复**：新增 `resolveRawHtmlImageSources()`，在渲染管线末端统一重写原始 HTML 内的 `<img src>`，与 Markdown 图片共用同一套路径解析规则（文档相对路径、`./` 前缀、Windows 盘符、绝对路径），并跳过 `http(s):`/`data:`/`asset:`/`blob:` 等无需处理的来源。`width`/`height`/`style` 等属性完整保留。
  - 补齐 `<figure>` / `<figcaption>` / 裸 `<img>` 的排版样式（图片居中、图注左对齐小字弱化色），并将 `figure` 纳入打印分页保护。

---

### [v1.8.0] - 2026-10-01

#### 沉浸式双向位置连续性 (Typora-Style Position Continuity)
- **双击预览即定位源码 (Double-Click to Source)**：
  - 在沉浸排版视图中双击任意位置，立即切入源码模式，且光标精确落在所双击的那一段（标题、段落、表格行、公式、代码块、Mermaid 图、定理卡片均可定位）。
  - 定位采用「渲染文本 ↔ Markdown 源码」折叠匹配：剥离空白与 Markdown 标记后比对，因此粗体、行内代码、行内公式等行内标记不会阻断定位。
  - 表格单元格定位到所在数据行（而非表格开头）；公式定位到 `$$` 块的数学源码；Mermaid 图定位到其围栏源码；未闭合提示条回溯至对应围栏。
- **修改后返回不再跳回顶部 (No More Scroll-to-Top)**：
  - 从源码模式切回沉浸排版时，预览自动滚动至刚才编辑的位置，连续写作不再被打断。
  - 切换瞬间会先刷新防抖队列，并以「渲染所依据的文档版本」为闸门校验，杜绝异步渲染竞态导致定位落到错误位置。
  - 所有切换入口（`Ctrl + /`、视图菜单、顶栏按钮、状态栏、打印）均已统一走位置携带逻辑。
- **实现要点**：
  - 新增 `.math-equation-row[data-tex-source]` 属性，使已排版为 SVG 的公式仍可反查其 LaTeX 源码。
  - 位置映射为纯函数（`foldForMatch` / `buildSourceIndex` / `locateRenderedText` / `sourceOffsetForElement` / `blockForSourceOffset`），独立于组件状态，便于测试。

---

### [v1.7.0] - 2026-10-01

#### 文本绘图引擎 Text-to-Diagram (Mermaid Integration)
- **原生 Mermaid 图表渲染**：
  - 集成 `mermaid` v11.17.2，支持流程图（flowchart）、时序图（sequenceDiagram）、状态图、类图、甘特图、ER 图等全部图表语法。
  - 编写 ` ```mermaid ` 围栏即在沉浸排版视图中直接绘制，源码模式与打印/PDF 导出同样保留可读回退。
  - 完全离线：`mermaid.min.js` 由 `postinstall` / `vite` 构建钩子自动内联进 `dist/mermaid/`，断网环境零延迟启动。
- **与既有渲染管线的严格隔离（架构关键点）**：
  - 围栏代码块在 v1.6.1 起已被遮蔽机制（`maskVerbatimRegions`）保护，若沿用旧顺序，图表源码会被当作逐字代码显示。故新增 `extractMermaidBlocks()`，在遮蔽之前先将图表提离文本流。
  - 图表内的 `$\sigma$` 等 LaTeX 片段保持原样，交由 Mermaid 自身解析，互不干扰。
  - 图表源码经 `escapeHtml` 转义后写入 `data-mermaid-source` 属性，杜绝属性注入。
- **健壮性与可观测性**：
  - 语法错误时 `mermaid.render()` 抛错被捕获，自动展开源码回退块并显示红色错误说明，绝不白屏或静默失败。
  - 未闭合的 ` ```mermaid ` 围栏降级为普通段落，不吞掉后续文档内容。
  - 每次渲染使用随机 `mmd-` 渲染 ID，连续输入不会发生 ID 冲突。
  - 主题切换时重新 `initialize()`（default / dark / neutral），图表随主题同步换色。
- **安全加固**：`securityLevel: 'strict'` 关闭 Mermaid 的 HTML 标签注入能力；CSP `script-src` 增补 `blob:` 以允许其临时 SVG 资源。

---

### [v1.6.1] - 2026-10-01

#### React 状态机严谨性重构与多标签冲突防御加固 (State Purity & Per-Tab Conflict Hardening)
- **彻底消除状态更新器内的副作用 (Eliminate Side Effects Inside State Updaters)**：
  - 在 `src/App.tsx` 中引入 `openFilesRef` 与 `dirChildrenCacheRef` 两个 ref 镜像引用，作为状态向异步回调暴露的只读快照。
  - 文件监控回调中的 `readTextFile` 磁盘读取、目录惰性展开中的 `read_dir_files` 调用、`openFileByPath` 中的去重探测与标签追加，全部迁移至状态更新器之外。
  - 恢复 `StrictMode` 语义正确性：更新器不再被双次调用，杜绝重复磁盘 IO、重复同步气泡与被丢弃的结果。
- **外部修改冲突改为按标签键控 (Per-Tab Conflict Registry)**：
  - 原单例 `conflictBanner` 状态重构为 `fileConflicts: Record<string, FileConflict>` 字典，横幅对象由当前活动标签派生。
  - 后台标签的外部修改冲突不再被静默丢弃：磁盘新内容完整缓存于字典中，切回该标签即呈现警示横幅。
  - 磁盘读取完成后重新校验标签生命周期（标签是否已关闭或路径是否已重定向），杜绝向已销毁标签写入陈旧数据。
  - 顶栏文档下拉与侧栏文档列表新增 ⚠️ 冲突角标；后台标签发生冲突时右下角提示气泡明确指引。
- **构建版本号统一升级至 v1.6.1**：同步更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、锁文件及界面内版本标识。

---

### [v1.6.0] - 2026-09-27

#### 重磅大版本特性：Rust 原生文件监控与智能冲突热重载 (Native File Watcher - Approach B)
- **Rust `notify` 底层事件驱动架构 (Rust-Native Event-Driven Watcher)**:
  - 在 `src-tauri` 后端深度集成 `notify` (v6.1) crate，实现操作系统级原生文件变更监听（Windows ReadDirectoryChangesW / Linux inotify / macOS kqueue）。无需前端高耗能轮询，实现零 CPU 冗余开销、毫秒级响应。
- **无冲突自动平滑热重载 (Silent Auto-Reload)**:
  - 当外部程序（VS Code、Git、Obsidian、外部计算与绘图脚本等）更新磁盘文件且当前编辑器无未保存修改时，自动静默重载磁盘最新文本并无缝刷新预览，并伴有右下角优雅反馈气泡。
- **有冲突安全防御与交互横幅 (Conflict Protection Banner)**:
  - 当外部文件被修改但 MarkdownX 中存在未保存本地内容时，主动拦截重载并弹出顶部冲突警示栏：
    - 提供 **「🔄 载入磁盘最新版」**（放弃本地修改同步磁盘）与 **「💾 覆盖为当前版本」**（以本地为准强制覆写）两大决断选项，彻底防范多编辑器协同冲突。
- **防自触发与操作系统写入防抖 (Self-Save Shield & OS Debounce)**:
  - 内置 1.5 秒自身保存时间戳屏蔽窗口，杜绝用户在 MarkdownX 内按 `Ctrl + S` 触发自循环报警；结合 400ms 写入防抖，过滤操作系统突发的多重写入事件。
- **偏好设置自由开关 (File Watcher Preferences Toggle)**:
  - 偏好设置面板（`Ctrl + ,`）新增「外部修改监控」单选开关，支持用户按需随时开启或禁用实时监控。

---

### [v1.5.0] - 2026-09-27

#### 离线打包完善与定界符渲染重构 (Offline Packaging & Delimiter Normalization)
- **修复正文方括号与文献引用换行异常 (Fix Citation Square Bracket Linebreak)**:
  - 规范 MathJax 全局定界符配置为纯净 `$$` 块级定义，移除产生冲突的转义方括号定界符。彻底解决正文中诸如 `[35]`、`[1]` 等文献引用被错误当作 Display Math 强制换行并居中的问题，恢复标准行内显示。
- **TypeScript 构建类型检查全面通过 (Resolve TS2741 Strict Type Error)**:
  - 完善 `src/App.tsx` 中向后兼容配置解析的类型定义与默认继承，顺利通过 `tsc` 严格类型检测，保证 `pnpm tauri build` 顺利打包。
- **完整内嵌离线打包与工具脚本 (Full Offline Bundling Pipeline)**:
  - 随源码附带自动化离线分发工具与 Windows 批处理脚本，支持断网环境 100% 离线秒开渲染公式。

---

### [v1.4.9] - 2026-09-27

#### MathJax 纯离线本地化打包全套方案 (Offline Localized MathJax Packaging)
- **100% 纯本地离线优先加载架构 (Offline-First Loading Pipeline)**：
  - 在 `index.html` 中重构加载链路：优先通过 `./mathjax/tex-svg.js` / `./mathjax/tex-chtml.js` 加载本地打包资源（纳秒级从磁盘读取），断网环境下公式渲染依然毫秒级响应。
  - 保留 CDN 多级容灾回退（jsDelivr -> cdnjs），在源码未构建或开发模式无离线包时自动平滑回退，永不报错。
- **全自动离线打包流水线 (Automated Build & Bundling Pipeline)**：
  - **npm 官方包依赖整合**：`package.json` 添加 `"mathjax": "^3.2.2"` 依赖与 `"postinstall": "node scripts/copy-mathjax.js"` 自动化钩子，执行 `pnpm install` 时全自动将官方矢量引擎提取并同步至 `public/mathjax/`。
  - **Vite 本地化开发与构建双重保障**：在 `vite.config.ts` 中内置 `mathjaxLocalPlugin`，开发服务直接劫持本地资源路由，打包构建时自动写入 `dist/mathjax/`，使 Tauri 产物（Windows NSIS/MSI、Linux deb/AppImage）天然内嵌完整 MathJax 运行时。
- **独立一键离线资源下载工具 (Standalone Offline Download Scripts)**：
  - 提供 `scripts/download-mathjax.bat`（Windows 双击即用）、`scripts/download-mathjax.ps1` 与 `scripts/download-mathjax.js`，支持免 npm 依赖直接一键下载离线文件到 `public/mathjax/`。

---

### [v1.4.8] - 2026-09-27

#### 落地方案 3：偏好设置双公式引擎自主切换（默认 SVG）
- **公式渲染引擎自由切换 (Dual Math Engine Selector in Preferences)**：
  - 在偏好设置（`Ctrl + ,`）的「程序默认启动设置」专区新增 **公式渲染引擎单选面板**：
    1. **`📐 矢量 SVG (默认推荐)`**：高保真矢量渲染，行内复杂高分式微米级基准线对齐，绝不压盖上下行正文，默认出厂值为 SVG；
    2. **`⚡ 高速 CHTML`**：轻量级 HTML 渲染，脚本仅 1MB，启动秒开，并在 CSS 层加固了垂直居中与行高缓冲，杜绝文字重叠。
- **按需动态轻量加载架构 (Dynamic Lightweight Loading)**：
  - 启动阶段自动根据用户的偏好设置动态注入 `tex-svg.js`（纯净版矢量引擎）或 `tex-chtml.js`（纯净版高速引擎），彻底移除了此前冗余的 MathML 解析组件（直接减重 600KB+），兼备 CDN 故障自愈回退机制。
- **配置持久化与恢复出厂支持**：
  - 所选引擎支持通过 `⭐ 设为程序默认值` 固化为软件永久默认值，或通过 `🔄 恢复出厂设置` 还原为默认推荐的矢量 SVG 模式。

---

### [v1.4.7] - 2026-09-27

#### MathJax 公式全面切换为高保真矢量 SVG 渲染
- **默认采用 SVG 矢量渲染引擎 (Switch MathJax to Vector SVG)**：
  - 将 MathJax 默认渲染后端从 HTML-CSS / CommonHTML（`tex-mml-chtml.js`）全面切换为出版级 **SVG 渲染引擎（`tex-mml-svg.js`）**。
  - **彻底解决行内复杂公式与文字层叠的缺陷**：SVG 模式将字符计算为精确的矢量路径（Vector Paths），不依赖客户端网络字体，彻底避免了 CHTML 在行内复杂高分式时与上一行文字互相重叠压盖的排版问题。
  - **完美基准线对其与色彩继承**：自动采用精准的 `vertical-align` 基准对其，公式字符随主题（纯白/深色/原木）与打印媒体自适应同步着色，打印导出永不失真。

---

### [v1.4.6] - 2026-09-27

#### 公式渲染右键菜单禁用与自愈机制 (Fix MathJax Menu "Activate" Issue)
- **彻底禁用公式右键弹出菜单 (Disable MathJax Context Menu)**：
  - 在全局 MathJax 配置中明确设置 `options.enableMenu = false`，彻底封禁右键公式弹出的 MathJax 原生设置菜单。
  - 在前端添加捕获级 `contextmenu` 拦截，在公式（`<mjx-container>`）及方程行上右键时静默阻止默认菜单冒泡，杜绝用户误触导致误改渲染模式。
- **启动自愈清理机制 (Auto-heal Corrupted MathJax Settings)**：
  - 在应用初始化与组件挂载首层增加了对 `localStorage` 的自愈检测，自动清除历史因误触产生的 `mjx.`、`mjx.menu` 或 `MathJax-Menu-Settings` 脏缓存，确保任何误触的用户在刷新或重启软件后公式渲染瞬间复活。

---

### [v1.4.5] - 2026-09-27

#### Rust 后端类型适配与编译保障
- **修复开发者工具指令类型错误 (Fix E0599: no method named `open_devtools` found for struct `tauri::Window`)**：
  - 在 Tauri 2.0 中，`open_devtools()` 归属于带有 Web 渲染上下文的 `tauri::WebviewWindow` 结构体，而非 `tauri::Window`。
  - 将 `open_devtools` 指令形参调整为 `app: tauri::AppHandle`，通过 `app.get_webview_window("main")` 提取活动窗口并调用原生调试面板，彻底消除 Rust 编译错误。

---

### [v1.4.4] - 2026-09-27

#### 侧边栏文件树 N 级子目录无限展开支持
- **原生文件树递归目录展开 (N-Level Recursive Directory Tree)**：
  - 彻底重构侧边栏文件树架构，引入递归树节点组件 `FileTreeNode`。
  - 支持对任意深度的子文件夹进行逐层展开（`▼ 📂`）与折叠（`▶ 📁`）。
  - 点击子文件夹时自动调用 Rust 底层原生 `read_dir_files` 进行异步惰性加载并缓存结果，毫秒级响应。
  - 增加层级缩进自适应与树状导轨连接线，各层级文件夹状态独立记忆。
  - 点击任意深层子目录内的 Markdown 文件直接在应用内新建/切换标签页打开。

---

### [v1.4.3] - 2026-09-27

#### Rust 编译警告清理与构建环境适配
- **消除 Rust 条件编译警告 (Clean Rust `unexpected_cfgs: devtools` Warning)**：
  - 在 `src-tauri/src/lib.rs` 中移除了指令函数上多余的局部宏判断 `#[cfg(feature = "devtools")]`，改由 `Cargo.toml` 依赖中配置的 `tauri` feature 直接提供支持，彻底消除 Rust 编译器 `unexpected_cfgs` 警告。
- **清理 pnpm 废弃配置提示**：
  - 移除了 `package.json` 中已被 pnpm v10+ 废弃的 `"pnpm.onlyBuiltDependencies"` 字段，使现代包管理器构建流程无任何冗余警报。

---

### [v1.4.2] - 2026-09-27

#### JSX 字符转义修复与编译严密性校验
- **修复公式帮助面板中的 JSX 表达式转义异常 (Fix TS2304: Cannot find name 'ij')**：
  - 修复了 `App.tsx` 的 LaTeX 数学公式指南弹窗中，示例代码 `\sigma_{ij}` 与 `C_{ijkl}` 中的大括号被 React JSX 语法解析器误识别为 JavaScript 插值表达式的问题。
  - 将所有示例公式以 JSX 纯字符串字面量规范包裹（`{'...'}`），彻底根除 TS2304 类型查找错误，确保构建过程畅通。

---

### [v1.4.1] - 2026-09-27

#### 语法树修复与 TypeScript 编译保障
- **修复键盘监听事件中的括号不匹配异常 (Fix TS1005: ',' expected at line 630)**：
  - 修复了 `App.tsx` 中 `handleKeyDown` 事件监听函数内多余嵌套的 `if (e.ctrlKey || e.metaKey)` 条件语句导致的语法解析失衡，确保全局键盘快捷键监听结构规范严谨，彻底消除 TypeScript 编译阻断。

---

### [v1.4.0] - 2026-09-27

#### 全面合入 Typora 原生「视图(V)」菜单、侧边栏体系与沉浸写作增强
- **全新侧边栏多面板系统 (Sidebar Panels - `Ctrl+Shift+L`)**：
  - **大纲 (Outline / TOC - `Ctrl+Shift+1`)**：实时解析 Markdown H1～H6 标题层级，生成可视化树形目录；点击标题平滑滚动至对应正文位置。
  - **文档列表 (Document List - `Ctrl+Shift+2`)**：直观展示当前会话所有打开的标签页，支持直接点击切换与快捷关闭。
  - **文件树 (File Tree - `Ctrl+Shift+3`)**：集成工作区目录文件浏览器，支持“打开...”选择本地文件夹并在侧栏树中直接点击打开其它 Markdown 文件。
  - **全文搜索与替换 (Search & Replace - `Ctrl+Shift+F`)**：提供关键词检索、实时匹配计数、上一个/下一个遍历与单项/全部替换能力。
- **沉浸写作增强模式 (Focus & Typewriter Modes)**：
  - **专注模式 (Focus Mode - `F8`)**：高亮聚焦当前光标所在段落，自动淡化非活跃背景段落，减少视觉干扰。
  - **打字机模式 (Typewriter Mode - `F9`)**：使输入光标所在行自动保持在屏幕垂直正中央。
- **状态栏控制与专业度量统计窗口 (Status & Word Count)**：
  - 支持一键显示/隐藏底部状态栏。
  - 新增独立字数统计详细窗口：精准度量中文字数、英文词数、字符数（计空格/不计空格）、总行数、自然段落数与预估阅读时间。
- **窗口控制与视图缩放**：
  - **切换全屏 (`F11`)** 与 **保持窗口在最前端 (Always on Top)** 原生集成。
  - **视图缩放系统**：实际大小 100% (`Ctrl+Shift+9`)、放大 (`Ctrl+Shift+=`)、缩小 (`Ctrl+Shift+-`)。
  - **应用内标签页循环轮转 (`Ctrl+Tab`)**。
  - **开发者工具 (`Shift+F12`)**。
- **顶栏顶级菜单架构全面升级**：
  - 顶栏正式重构为：`文件(F)` | `编辑(E)` | `段落/格式(O)` | `视图(V)` | `主题(T)` | `帮助(H)`。
  - 独立出 `主题(T)` 一级菜单（纯白 / 深色 / 原木 / 偏好设置）。
  - 新增 `帮助(H)` 一级菜单（快捷键手册、学术公式排版指南、关于 MarkdownX）。

---

### [v1.3.4] - 2026-09-27

#### 菜单全套深色/原木主题与顶栏排版按钮精简升级
- **子菜单全套深色模式适配 (Fix Submenu Dark Theme & White Text Bug)**：
  - 全面重构 `.typora-submenu` 样式体系，修复了此前“导出”子菜单（`.export-submenu`）及最近文件子菜单（`.recent-files-submenu`）背景硬编码为纯白，导致在深色模式下展开出现“白底白字”无法看清菜单项的缺陷。
  - 在深色模式（`#0f172a` 背景、`#f1f5f9` 正文、`#1e293b` 悬停项）和原木模式（`#fbf6ec` 背景、`#3d352a` 正文）下，子菜单的所有层级均与主下拉菜单实现 100% 视觉对齐。
  - 为导出子菜单修正 `flex-direction: row`，使格式名称（如 PDF、HTML、Word）与类型标注（出版级、单文件网页）左右整齐分列。
- **右上角排版设置按钮彻底移除 (Top-Right Typography Button Removed)**：
  - 彻底删除了顶栏右侧的 `🎨 排版设置` 按钮，只保留主题快速切换器（`☀️ / 🌙 / 📜`）与源码切换器（`</>`），顶栏布局更显凝练专注。
  - 排版与偏好配置已无缝收拢至 `段落/格式(O) ➔ 排版与偏好设置...`、`文件(F) ➔ 偏好设置...` 与经典快捷键 `Ctrl + ,` 中。

---

### [v1.3.3] - 2026-09-27

#### 原生文件关联双击直接打开与单实例联动支持 (Double-Click & File Association)
- **双击 Markdown 文件直接打开与加载 (Direct Open from Explorer)**：
  - 在 Rust 底层与前端核心中新增了 CLI 启动参数捕获通道（`get_cli_args`）与原生跨域文件直读指令（`read_file_from_path`）。
  - 双击操作系统中已关联的 `.md` / `.markdown` / `.mdown` / `.mkd` 文件时，MarkdownX 将自动接收文件绝对路径并在启动瞬间完成正文加载与 MathJax 渲染，直接呈现在视野中，无需手动“文件 ➔ 打开”。
- **单实例运行与跨进程联动 (Single Instance Routing)**：
  - 集成 `tauri-plugin-single-instance` 插件并在窗口与前端间建立了 `open-file-from-cli` 事件管道。
  - 当软件已在运行状态下，再次双击打开其他外部 Markdown 文件，会自动唤醒聚焦当前窗口并在全新标签页中无缝加载该文档，避免频繁弹出多个重复应用进程。
- **安装包文件关联与全局访问域授权**：
  - 在 `tauri.conf.json` 打包配置中正式注册系统级 `fileAssociations`（`.md`, `.markdown`, `.mdown`, `.mkd`），安装后自动将 Markdown 图标与打开命令绑定至系统注册表。
  - 在应用安全策略中放行了全局文件域（`fs:scope: ["**"]`），彻底解除从外部任意深层目录双击打开文件时的访问沙箱拦截。
- **TypeScript 严格模式全面校验通过**：
  - 彻底清理了所有未引用的局部变量及 catch 参数，严格契合 `"noUnusedLocals": true` 与 `"noUnusedParameters": true` 编译规范，杜绝 TS6133 报错。

---

### [v1.3.2] - 2026-09-27

#### 紧急热修复：彻底消除启动白屏与增加错误边界守护
- **修复启动白屏与引用异常 (Fix Startup Blank Screen / TDZ ReferenceError)**：
  - 修复了 `App.tsx` 顶层常量声明顺序引发的 JavaScript 暂时性死区（TDZ）错误（`DEFAULT_TYPOGRAPHY` 声明在 `FACTORY_PREFERENCES` 之后导致启动模块解析失败）。
  - 调整了 `App` 组件内 `initialPrefs` 引用与状态初始化的声明拓扑顺序，确保所有响应式状态在获取默认值时依赖项均已完成初始化。
- **引入生产级全局错误边界守护 (React Error Boundary)**：
  - 在 `main.tsx` 中为根组件挂载了具备自动容错与缓存重置能力的 `ErrorBoundary`。即便极端情况下出现未知运行时异常或本地存储脏数据，应用也能优雅展示排查详情并提供「一键重置缓存并快速恢复」按钮，彻底告别无响应白屏。

---

### [v1.3.1] - 2026-09-27

#### 导出对比度、界面精简与程序默认值能力升级
- **彻底修复深色主题导出看不清文字问题 (Print & Export Contrast Fix)**：
  - **PDF 打印重构**：全面重构 `@media print` 样式，在导出 PDF 或调用系统打印时，无论当前是否处于深色或原木主题，所有段落正文、标题、数据表格、代码块以及 MathJax 数学公式与编号标签均强制覆盖为高对比度印刷级黑色（`#111827` / `#000000`），背景重置为纯白，彻底根除深色模式下导出 PDF “白底白字”导致公式与文字看不清的缺陷。
  - **HTML 导出色彩动态协同**：单文件自包含 HTML 导出时，自动同步当前界面的激活主题配色（深色模式下导出为深曜石底色与冷白公式，浅色模式下导出为纯白高对比度），保持数字分发的高度一致。
- **界面右上角视觉精简**：
  - 移除了右上角重复的 `🎨 排版设置` 按钮，将全部排版与字体配置统一收拢集成于顶栏菜单中（`段落/格式(O) ➔ 排版与偏好设置...` 与 `文件(F) ➔ 偏好设置...`），支持经典快捷键 `Ctrl + ,`，界面更专注纯粹。
- **新增修改与保存程序全局默认值能力 (Custom Program Defaults)**：
  - **启动外观自主设定**：在偏好设置面板中可自由指定软件启动时的默认外观主题（纯白 / 深色 / 原木）以及默认启动模式（沉浸排版 / 纯源码）。
  - **一键固化默认值**：新增 **`⭐ 设为程序默认值`** 按钮，可将当前个性化调整的中西文字体、正文字号、行距、段距、对齐方式与主题固化为软件全局启动默认值，下次打开或新建文档即刻自动继承。
  - **一键恢复出厂**：新增 **`🔄 恢复出厂设置`** 按钮，便于随时还原出厂初始排版标准。

---

### [v1.3.0] - 2026-09-26

#### 导出体系重大升级 (Full Typora Export Suite)
- **独立保留“打印...”核心功能**：
  - “打印... (Print)”作为一级常用操作完整保留在 `文件(F)` 菜单中（快捷键 `Ctrl + P`），随时直连实体打印机或调用操作系统虚拟打印服务。
- **全新构建 Typora 原生“导出 ›”二级子菜单**：
  - **PDF...**：出版级 A4 页面排版，公式防撕裂截断，矢量高清输出。
  - **HTML (带完整样式)...**：将当前排版主题（纯白/深色/原木）、高亮 CSS、三线表及 MathJax 脚本深度内联打包，输出自包含独立单文件，任何电脑浏览器双击离线即看。
  - **HTML (without styles)...**：导出干净无修饰的纯 HTML 内容片段，便于分发到 CMS 博客后台、公众号或知乎专栏。
  - **Word (.docx)...**：利用标准 MSO-XML 原生协议打包，生成的 Word 文档可直接在 Microsoft Word 中双击打开，完整继承三线表、排版标题与段落样式。
  - **LaTeX (.tex)...**：自动解析 Markdown 章节结构、粗体、代码与行间公式，生成包含标准导言区（`amsmath`、`amssymb`、`booktabs`）的标准学术手稿工程。

---

### [v1.2.0] - 2026-09-26

#### 界面视觉风格与学术排版重大升级
- **三大沉浸式主题系统 (Theme & Dark Mode)**：
  - **☀️ 经典纯白学术 (Light)**：标准学术期刊与毕业论文印刷白纸风格，对比清晰严谨。
  - **🌙 夜间极客深色 (Dark)**：深石墨曜石背景（`#0f172a`），MathJax 数学公式自动反色高亮为冷白（`#f8fafc`），代码与编辑器全黑曜抗眩光，专为深夜公式推导与算法编程优化。
  - **📜 羊皮纸复古原木 (Sepia)**：温润典雅的暖米黄图书质感底色（`#fbf6ec`），文字呈深棕色，长时间审阅长篇推导不刺眼、更护眼。
  - **便捷切换与记忆**：支持通过顶部 `视图(V) ➔ 主题风格` 菜单或右上角 `☀️/🌙/📜` 按钮一秒循环切换，本地自动持久化保存。
- **学术出版标准“三线表” (Booktabs)**：
  - 全面摒弃传统粗网格，采用顶级科技期刊（ASME、Elsevier、Springer）规范的三线表布局（顶底 2.2px 加粗实线、表头下方细横线、无内部垂直竖线），数据行交替微底色，导出 PDF 呈现原汁原味的学术专著质感。
- **科研定理与学术提示卡片块 (Callouts / Admonitions)**：
  - 支持类似 GitHub / Obsidian 的规范语法：
    - `> [!THEOREM]` 定理卡片（紫罗兰高亮）
    - `> [!DEFINITION]` 定义卡片（青蓝高亮）
    - `> [!ASSUMPTION]` 力学假定卡片（靛蓝高亮）
    - `> [!NOTE]` 注解卡片（天蓝高亮）
    - `> [!TIP]` 技巧提示（翠绿高亮）
    - `> [!WARNING]` 警告/注意事项（琥珀金高亮）
- **代码块语言胶囊标签与一键复制代码**：
  - 代码块右上角新增语言胶囊徽标（如 `FORTRAN`、`C++`、`PYTHON`）。
  - 鼠标悬浮时右上角呈现平滑微动效的 **“复制 (Copy)”** 按钮，点击一键复制纯代码并显示“已复制 ✓”。

---

### [v1.1.0] - 2026-09-26

#### 全新功能升级
- **导出出版级 PDF 文档 (Export to PDF)**：
  - 在 `文件(F)` 菜单中新增 **“导出为 PDF...”** 功能，并支持标准快捷键 **`Ctrl + P`**。
  - 深度设计专属的 `@media print` 打印与矢量导出规则：
    - 自动隐藏软件导航栏、菜单项、状态栏与悬浮窗，纯净保留正文出版内容；
    - 设定标准 A4 页面排版（20mm 顶底边距，15mm 左右页边距）；
    - 为所有行间公式块、代码块、数据表格及图片容器配置 `page-break-inside: avoid`，**彻底杜绝数学公式或代码被分页生硬撕裂截断**；
    - 为各级标题注入 `page-break-after: avoid`，防止出现标题落于页尾的孤行孤段现象；
    - 保持公式编号与矢量超链接完好，输出矢量级高清印刷 PDF。
- **支持外部文件直接拖拽导入打开 (Drag & Drop)**：
  - 接入 Tauri v2 原生窗口级拖拽事件 `onDragDropEvent` 与前端 HTML5 拖拽双轨监听系统。
  - 支持直接将 Windows 资源管理器或桌面的 `.md`、`.markdown`、`.txt` 文件**拖入软件窗口任意区域释放**，即刻加载并列入文档管理列表。
  - 拖拽悬停时自动展现毛玻璃视觉反馈覆盖层（`Drag & Drop Overlay`），操作直观流畅。

---

### [v1.0.3] - 2026-09-26

#### 启动体验与纯净度优化
- **启动即纯白空白文档**：完全移除了原用于排错测试的硬编码本构模型示例文档。软件启动默认打开干净的 `未命名文档.md`，提供纯正的 Typora 沉浸式写作环境。
- **清除原生气泡遮挡**：移除了正文容器上的原生 `title` 气泡属性，杜绝鼠标在文章与公式区域滑过时弹出“双击或按 Ctrl+/ 即可进入源码编辑”遮挡视线的悬浮黑框。
- **新增空白文档快速指引**：在空白文档时提供轻量温和的点击与快捷键指引，点击即可直接无缝切入书写。

---

### [v1.0.2] - 2026-09-26

#### 生产环境 (Build Release) 关键修复
- **修复 Release 构建后本机图片无法渲染问题**：
  - 在 `src-tauri/Cargo.toml` 中显式启用 `tauri = { version = "2", features = ["protocol-asset"] }` 特性。Tauri 默认在 release 编译时未开启资产协议特性，导致 `convertFileSrc` 生成的协议路由未在 WebView 注册。
  - 在 `src-tauri/tauri.conf.json` 中配置 `app.security.assetProtocol` 作用域为 `["**"]`，并在 CSP `img-src` 中加入 `http://asset.localhost` 与 `asset:`，确保 Windows 与 Linux 生产包中的本地图片资源正常加载。
  - 增强相对路径图片规范化（自动处理 `./`、盘符与分隔符）。
- **修复生产包初次启动时公式显示错误问题**：
  - 解决生产环境下本地界面瞬间挂载与远程 MathJax 异步加载的时钟时序竞争（Race Condition）。在开发模式下由于 Vite 启动耗时掩盖了此问题，而在生产包中页面 5ms 极速就绪时 MathJax 仍在网络请求中，导致首屏排版跳过。
  - 在 `index.html` 中引入 `MathJax.startup.ready` 钩子并在就绪时广播 `mathjax-ready` 规范事件；在 `markdownRenderer.ts` 中加入异步轮询等待，确保生产环境启动时公式 100% 自动就绪并排版。

---

### [v1.0.1] - 2026-09-26

#### 修复与稳定性增强
- **修复公式定界符丢失故障**：彻底修复 JavaScript `String.prototype.replace` 底层将 `$$` 误当成转义符吞噬为单个 `$` 的隐蔽缺陷，改用函数回调注入，确保构建发布后行间公式与行内公式定界符完整保留，MathJax 100% 正常唤醒。
- **清除控制字符转义干扰**：在示例文档声明中全面改用 `String.raw` 原生模板，并在渲染管道入口加入 ASCII 不可见控制字符安全清洗过滤器，根除 `Math input error` 与 `	ag` 残留乱码。
- **消除 TypeScript 生产打包类型拦截**：修复 `markdownRenderer.ts` 中 `labelId` 的严格空值检查警告（TS2345），确保 `pnpm tauri build` 时 `tsc` 类型检查一键通过。
- **预置 pnpm 编译构建白名单**：在 `package.json` 中预置 `onlyBuiltDependencies: ["esbuild"]`，解决 pnpm v10+ 的构建脚本安全拦截问题。

#### 功能与排版优化
- **段落末行大间隙彻底优化**：在 CSS 中引入 `text-align-last: left` 及 `word-break: break-word`，杜绝两端对齐排版时段落末行文字被异常横向拉伸的尴尬大间距。
- **新增细粒度排版参数配置面板**：推出全新的“🎨 排版设置”浮层，支持西文字体、中文字体、字号、行距、段间距、首行缩进、对齐方式与版心宽度的独立单独配置。
- **移除分屏视图**：全面转型为纯正的 Typora 沉浸式单栏阅读/排版交互。
- **版本号与品牌规范同步**：全工程配置文件统一升级至 `v1.0.1`。

---

### [v1.0.0] - 2026-09-26

#### 初始发布
- 确立 **MarkdownX** 品牌名与大 M 艺术体（Artistic M）视觉设计体系。
- 完成基于 Tauri v2 + React 18 + MathJax v3 + marked.js 的轻量跨平台桌面应用架构设计。
- 初步实现公式交叉引用、代码语法高亮与本地文件 I/O。

---

## 软件发布与编译构建指南

### 1. Windows 环境编译（输出独立 `.exe` 及安装包）
在 **Windows PowerShell** 中运行：
```powershell
cd MarkdownX
pnpm install
pnpm tauri build
```
产物位置：
- 安装包：`src-tauri/target/release/bundle/nsis/MarkdownX_1.8.1_x64-setup.exe`
- 绿色独立版：`src-tauri/target/release/MarkdownX.exe`

### 2. Linux / Ubuntu 环境编译（输出 `.deb` 与 `.AppImage`）
在 **Ubuntu 终端** 中运行：
```bash
cd MarkdownX
pnpm install
pnpm tauri build
```
产物位置：
- `src-tauri/target/release/bundle/deb/markdown-x_1.8.1_amd64.deb`
- `src-tauri/target/release/bundle/appimage/MarkdownX_1.8.1_amd64.AppImage`

### 3. macOS 环境编译（输出 `.dmg`）
在 **macOS 终端** 中运行：
```bash
cd MarkdownX
pnpm install
pnpm tauri build
```
产物位置：
- `src-tauri/target/release/bundle/dmg/MarkdownX_1.8.1_universal.dmg`

---

## 许可证
MIT License
