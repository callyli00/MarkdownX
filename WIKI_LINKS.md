# 知识链接层：`[[wikilink]]` / 嵌入 / 块引用 / `#标签` + 工作区索引

> 实现于 MarkDownX v2.6.1 之上的 A + B 两档能力。设计目标只有一个：
> **把 Obsidian 写的文档拿进 MarkDownX，链接不许静默变成普通文字**，同时不破坏
> "渲染器是纯函数、Worker 与主线程逐字节等价"这条既有硬约束。

---

## 1. 支持的语法

### 1.1 链接

| 写法 | 行为 |
|---|---|
| `[[笔记名]]` | 解析到工作区里的同名笔记，点击在应用内打开 |
| `[[笔记名\|显示文字]]` | 同上，显示别名 |
| `[[笔记名#标题]]` | 打开目标笔记并带 `#heading-<slug>` 锚点 |
| `[[笔记名#^块id]]` | 打开目标笔记并带 `#blk-<id>` 锚点 |
| `[[#本页标题]]` | 页内跳转（永远算"已解析"） |
| `[[目录/笔记名]]` | 按路径解析，优先于按名解析 |

**解析优先级**（与 Obsidian 一致，且在索引里一次算好）：
显式路径 → 同目录同名 → 全局唯一同名 → 多个同名时取路径最短者并标记歧义。

### 1.2 嵌入

| 写法 | 行为 |
|---|---|
| `![[图.png]]` / `![[图.png\|300]]` | 内联图片，`\|300` 是宽度（此前 MarkDownX 完全没有尺寸语法） |
| `![[图.png\|图注\|300]]` | 带 alt 的图片 |
| `![[某篇笔记]]` | 内联该笔记的渲染结果（**深度 1**，见 §4） |
| `![[某篇笔记#^块id]]` | 只内联那一个块（块 = 连续非空行；标记 `^块id` 不计入成品） |
| `![[某篇笔记#小节标题]]` | 只内联该章节：到下一个同级或更高级标题为止，不含标题行本身 |
| `![[说明.pdf]]` | 附件芯片，点击在应用内打开 |

### 1.3 块引用与标签

- 段落/标题/列表项末尾写 ` ^块id`（**前面必须有空格，以字母开头**），渲染成
  `id="blk-块id"`；`[[笔记#^块id]]` 即可跳到它。标记本身不会出现在成品里。
- 正文里 `#标签`、`#父/子` 渲染成标签芯片；`# 标题`、`https://x#frag`、`&#39;`、`\#转义`
  都不会被误判。标签同时进入索引，供"标签"面板聚合并跳转。

### 1.4 与既有语法的边界（由管线顺序保证，不靠手写守卫）

链接/标签/块 id 三趟 pass 都跑在**掩码之后**（代码围栏、行内代码、公式已被遮蔽），
所以 `[[x]]`、`#tag`、`^id` 写在代码块或公式里**永远不会**被改写。
`%%注释%%` 先被删除，注释里的链接也不进索引。

---

## 2. 渲染语义

| 状态 | 渲染成 | 为什么 |
|---|---|---|
| 已解析 | `<a class="wikilink" href="相对路径#锚点" data-wikilink="绝对路径">` | 导出的 HTML 不依赖本应用也能点；`data-wikilink` 让应用内点击直接用绝对路径，避免与索引结论不一致 |
| 未解析 | `<span class="wikilink wikilink-unresolved" title="未找到笔记：X">` | 断链必须**看得见**。静默降级成纯文本正是迁移里最容易丢信息的地方 |
| 嵌入的笔记 | `<div class="embedded-note">` + 已渲染正文 | 块级 HTML，必须在 marked 之后注入，不能当行内内容解析 |
| 未载入的嵌入 | `.embedded-note-missing` + 链接芯片 | 正文是异步读的，有上限；"未载入"是正常状态，不是错误 |

**打印**（`@media print`）：链接与标签的颜色、下划线、底色全部去掉，只留文字；
嵌入块保留左侧边线并 `break-inside: avoid`。理由同高亮：**链接的存在是内容，配色是装饰**。

**导出**：HTML 导出里 `href` 是相对路径，直接可点；Word/LaTeX 两条正则链路不处理链接
（现状即如此，见 `Obsidian-vs-MarkDownX-Markdown功能对比.md` §5）。

---

## 3. 工作区索引（B 档）

### 3.1 什么时候建

- 打开文件夹（`workspaceDir` 变化）→ 全量扫描。
- 保存文档（`Ctrl+S` / 另存为）→ 只重扫这一个文件，再 `buildIndex` 合并（O(文档+链接)）。
- 侧栏"↻ 重建索引"按钮 → 手动全量。

### 3.2 怎么建

```
Rust: scan_workspace_files(root)       递归列出笔记 + 附件（跳 .git/.obsidian/node_modules/dist/target…）
Rust: read_text_files(paths)           批量读文本，单文件失败只影响自己
TS:   scanDocument(path, content)      每篇抽出 links / tags / headings
TS:   buildIndex(docs)                 一遍建表：反链、标签计数、未解析清单、解析表
```

- **容量阀**：最多 20000 个文件、深度 32；单文件 4 MiB（超出记 error，不截断）。
- **附件按空文档入索引**：否则每个 `![[pic.png]]` 都会被记成"未解析"——解析表是从
  `docs` 建的，`docs` 里没有的路径和"文件不存在"在数据上无法区分。
- **索引不参与渲染**：渲染器只拿到一张 `{byName, byPath}` 解析表 + 已读好的嵌入正文
  （`WikiContext`）。索引缺失/过期 → 链接全部显示为未解析，但**不会**让渲染阻塞或抛错。

### 3.3 面板

侧栏第二个入口（书图标 → 反链 / 标签 / 未解析）：

- **反链**：谁链接到当前文档，带行号与原文片段，点击打开来源。
- **标签**：全工作区标签按文档数排序，点文档芯片直接打开。
- **提及**：正文里写了本篇名字、却没加 `[[ ]]` 的地方（带行号与片段），点击打开来源。
  围栏/行内代码与已有的 `[[链接]]` 都不计入——已链接的属于反链，不重复算。
- **未解析**：当前文档里断掉的链接（含缺失附件），迁移前用它做一次体检。

---

## 4. 已知限制（有意为之，写清楚而不是藏着）

1. **嵌入深度 = 1**。A 嵌 B、B 又嵌 A 时，第二层降级为芯片——否则递归不终止（已有测试）。
2. **嵌入正文上限**：单篇 8 个、每个 256 KB，超出部分截断并标注。
3. **`![[笔记#标题]]` 嵌入整篇**，不裁剪指定章节（跳转锚点正确，正文仍是全文）。
4. **跨文件锚点**：`[[笔记#标题]]` 会打开目标文件，但**不会**在打开后自动滚到该标题
   （当前点击链路只携带路径）。
5. **标签不写回属性**：`#tag` 只是正文标记 + 索引维度，没有 Obsidian 的标签面板重命名/合并。
6. **没有反向的"重命名自动改链"**：需要索引 + 跨文件批量写入，属下一档。
7. **解析表随每次渲染结构化克隆**：千篇级工作区约几十 KB，可接受；万篇级应改为按需切片。

---

## 5. 双平台注意事项

| 关注点 | Windows 桌面 | Android |
|---|---|---|
| 路径分隔符 | 生成 `..\b.md` 形式的相对链接（保持文档自身风格） | `/sdcard/...` 保持 `/` |
| 大小写 | 文件系统不敏感，索引仍按 `wikiKey` **统一小写**比较，避免 `[[Notes]]` 找不到 `notes.md` | 同理（ext4 敏感，若不折叠就会和 Windows 行为不一致） |
| 网络盘 / UNC | `scan_workspace_files` 逐目录容错，单个目录读失败只丢该子树；20k 文件上限防止共享盘把扫描拖死 | 不适用 |
| 目录权限 | 无 | SAF 路径可能只有部分可读；读不到的目录被跳过，索引降级为部分 |
| 文件监听 | 已有 `start_watching_file` | **无**（Android 侧是空实现），所以 Android 上索引靠"打开文件夹 / 保存 / 手动重建"更新 |
| 索引线程 | Rust 侧 `async` 命令，不占渲染 Worker | 同左；扫描走独立 IPC 批次，不阻塞输入 |
| 打印 | `@media print` 规则同时作用于桌面与 Android 的打印管线（Android 走 `PrintManager`，同一份 CSS） | 同左 |

> 判定"移动端"继续用 `src/platform/host.ts` 的 `isMobilePlatform()`，本次改动没有新增平台分支。

---

## 6. 开发与验证（本仓库在 UNC 路径上的特殊处境）

| 命令 | 作用 | 备注 |
|---|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | 类型检查 | 可直接跑 |
| `node tools/local-check/run.mjs --all` | 跑全部单测 | **vitest 在 UNC 根目录下起不来**（Vite 把 `\\host\share` 当 POSIX 路径），这个运行器用 esbuild 打包 + 一个 vitest 兼容 shim 跑同一批测试文件 |
| `node tools/render-equivalence-gate/gate.cjs` | 渲染护栏 | 7 份语料：Worker≡sync、LF≡CRLF |
| `cargo check --offline`（`src-tauri/`） | Rust 检查 | 需本地 registry 缓存 |

新增语料 `tools/render-equivalence-gate/corpus/corpus_wiki_links.md`（无 golden，只做等价断言）。

---

## 7. 文件清单

| 文件 | 作用 |
|---|---|
| `src/utils/wikiLink.ts` | 解析/解析表/相对路径/扫描（纯函数，零 I/O） |
| `src/utils/workspaceIndex.ts` | 每篇扫描结果 → 反链/标签/未解析/解析表 |
| `src/utils/markdownRenderer.ts` | 三趟新 pass + `WikiContext` + 嵌入注入 |
| `src/utils/renderClient.ts`、`renderWorker.ts` | 把 `WikiContext` 送进 Worker（保持两路等价） |
| `src/platform/workspaceScan.ts` | 两个 Rust 命令的 TS 封装（失败 fail-closed） |
| `src-tauri/src/lib.rs` | `scan_workspace_files`、`read_text_files` |
| `src/App.tsx` | 索引生命周期、嵌入正文预读、点击分发、面板 |
| `src/App.css` | 链接/标签/嵌入/面板样式 + 打印规则 + 窄屏规则 |
| `src/utils/__tests__/wikiLink.test.ts` | 25 项 |
| `src/utils/__tests__/wikiRender.test.ts` | 19 项 |
| `src/utils/__tests__/workspaceIndex.test.ts` | 36 项 |
| `src/utils/linkSuggest.ts`、`__tests__/linkSuggest.test.ts` | `[[` 补全与别名归一（纯函数） |
| `src/utils/renameLinks.ts`、`__tests__/renameLinks.test.ts` | 重命名改链计划（纯函数） |
| `src/utils/embedBlock.ts`、`__tests__/embedBlock.test.ts` | 区块/章节片段提取（纯函数，23 项） |
| `src/utils/mentions.ts`、`__tests__/mentions.test.ts` | 未链接提及扫描（纯函数，19 项） |
| `src-tauri/src/lib.rs`（`rename_path`） | 改名 + 拒绝覆盖 |

## 别名（aliases）

frontmatter 里的 `aliases` / `alias` 参与链接解析，`[[阿尔法]]` 能找到 `alpha.md`：

```
---
aliases: [阿尔法, alpha]      # 行内列表
# 或
aliases:
  - 阿尔法
  - alpha
---
```

- 只读第一个 `---` 到下一个 `---`（或 `...`）之间的块：正文里出现 `aliases:` 不会凭空造出别名。
- 与笔记同名的别名会被忽略（否则同一个键下多出一个指向同一文件的候选）。
- 两个笔记共用一个别名时按普通重名处理：`byName` 里两个候选，解析时同目录优先，面板显示"打开哪一个"。

## `[[` 补全

源码模式（Ctrl+/）里输入 `[[` 即弹出候选，数据来自工作区索引（纯函数在 `src/utils/linkSuggest.ts`）：

| 输入 | 候选 |
|---|---|
| `[[alp` | 笔记名 / 别名前缀匹配，精确名优先 |
| `[[alpha#` | alpha.md 的标题（按标题文字过滤） |
| `[[alpha#^` | alpha.md 的块 id（`^id`，行尾写成 `文字 ^id`） |
| `[[#引言` | **当前笔记**的标题 |

- 键位：↑/↓ 选择，Enter/Tab 接受，Esc 关闭。接受后把 `[[已输入` 替换成 `[[目标]]`（纯字符串切片，没有 execCommand）。
- 同名笔记（`a/note.md` 与 `b/note.md`）不插入裸名，而是插入**仓库相对路径**（`a/note`）——否则"接受建议"就等于"链到别的文件"。
- 弹窗贴在编辑区左下角而不是光标旁：textarea 拿不到光标矩形，用镜像元素测量会漂移，稳定的一角比抖动的位置更好用。
- 插入文本里的路径统一用 `/`（这是文档内容，不是文件系统路径），Windows 写的仓在安卓上也读得对。

## 未解析链接 → 一键建笔记

预览里点 `.wikilink-unresolved`（带"未找到笔记"提示的那段）直接创建该笔记：

- 位置：**当前文档所在目录**（若它在工作区内），否则工作区根目录。
- 文件名经 `sanitizeNoteName` 清洗（Windows 的 `\/:*?"<>|` 换成 `-`，合并连字符，去掉首尾点和空格，全空则 `未命名`）。
- 内容写入 `# 标题` 作为种子，然后立刻打开并重建索引。
- 目标文件已存在时只打开、不覆盖——索引可能是旧的，磁盘上的文件优先。

## 重命名笔记 → 自动改链

侧栏文件树上右键 →「重命名…」：改文件名，并把整个工作区里指向它的 `[[链接]]` 一次性改成新名字。

- 纯函数在 `src/utils/renameLinks.ts`：`planRenameReferences(index, from, to, readDoc)` 返回 `[{ docPath, content, changes }]`，`rewriteWikiLinks` 只碰链接那一小段（`[[old]]`、`[[old|别名]]`、`[[old#标题]]`、`![[old]]` 保留嵌入标记与前缀/锚点），围栏代码与行内代码里的内容不动。
- **先算改链，再移动文件**：索引里还有旧路径时才能判断"哪些引用是断的、哪些是写给旧名的"。顺序反了，`[[alpha]]` 会被当成"指向不存在"而跳过。
- 已打开的标签只改内存里的缓冲区并标记为未保存（不替你保存）；没打开的笔记直接写盘。
- 重命名后：索引重建、文件树重读、**文件监听重挂到新路径**（否则改名后的文件改动不再触发"磁盘已变化"）、被改名文档自己的标签页同步换路径（否则下一次 Ctrl+S 会把旧路径写回来，留下两份笔记）。
- 撞名不覆盖：目标已存在时只报错并保持对话框打开，磁盘上的文件优先。

## 真机冒烟

```bash
node tools/local-check/smoke-p1.mjs   # 检索/替换/复选框写回（12 项）
node tools/local-check/smoke-p2.mjs   # 补全/标题补全/建笔记（18 项）
node tools/local-check/smoke-p3.mjs   # 重命名 + 改链 + 撞名拒绝（17 项）
node tools/local-check/smoke-p4.mjs   # 未链接提及面板（10 项）
node tools/local-check/smoke-p5.mjs   # 区块级 / 章节级嵌入（10 项）
```

两者共用 `tools/local-check/cdp-harness.mjs`（受信任输入：`Input.dispatchMouseEvent` / `Input.insertText`；`el.click()` 在 React 18 委托下不会触发 onClick）。运行前把 `tools/local-check/fixtures/vault` 复制成 `C:/tmp/vault2`，并以 `markdown-x.exe "C:/tmp/vault2"` 启动。
