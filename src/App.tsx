import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readTextFile, writeTextFile, writeFile } from '@tauri-apps/plugin-fs';
import { triggerMathJax, renderMermaidDiagrams } from './utils/markdownRenderer';
import { renderDocument } from './utils/renderClient';
import { checkForUpdate, installUpdate, type UpdateCheckResult, type UpdateProgress } from './utils/updater';
import { AppIcon, type IconName } from './AppIcon';
import { isPdfPath, loadPdfBytes } from './pdf/openPdf';
// pdf-lib-backed modules are imported DYNAMICALLY at each call site (they are all
// async) so ~300 kB of pdf-lib never lands in the startup bundle.
import { fetchNoteFontBytes } from './pdf/cjkFont';
import { buildMenu, clampMenuPosition, type ContextTarget, type MenuItem } from './ui/contextMenuModel';
import { createAnnot, type AnnotKind, type PdfAnnot, type NormRect, type ViewerTool } from './pdf/annotations';
// Lazy: pdf.js + pdf-lib are ~1 MB of the bundle and are only needed once a PDF
// tab is opened, so they must not delay first paint of a Markdown session.
const PdfViewer = React.lazy(() =>
  import('./pdf/PdfViewer').then((m) => ({ default: m.PdfViewer }))
);
import './App.css';

type TabKind = 'markdown' | 'pdf';

interface FileTab {
  id: string;
  name: string;
  path: string | null;
  content: string;
  isModified: boolean;
  /** Discriminator. Absent means a Markdown tab (back-compat). */
  kind?: TabKind;
  /** PDF source bytes (kind === 'pdf' only). */
  pdfBytes?: Uint8Array;
  /** Annotations in normalized page space (kind === 'pdf' only). */
  pdfAnnots?: PdfAnnot[];
}

interface FileConflict {
  tabId: string;
  fileName: string;
  filePath: string;
  diskContent: string;
}

interface OutlineItem {
  level: number;
  title: string;
  line: number;
  slug: string;
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}


type AppTheme = 'light' | 'dark' | 'sepia';
// 'auto' tracks the OS light/dark setting live (sepia never auto-selects:
// a paper tone is a deliberate taste, not a system signal).
type ThemePreference = 'auto' | AppTheme;

/**
 * PDF annotation tools shown as icon buttons in the app top bar, right after the
 * print/export button. They exist ONLY while a PDF tab is active — Markdown never
 * shows them.
 */
const PDF_TOOL_ICONS: { id: ViewerTool | null; icon: IconName; title: string }[] = [
  { id: null, icon: 'cursor-text', title: '选择：选中文本或图片（不创建、不删除标注）' },
  { id: 'highlight', icon: 'marker', title: '高亮：先选中文字，再单击页面即可应用' },
  { id: 'underline', icon: 'underline-text', title: '下划线：先选中文字，再单击页面即可应用' },
  { id: 'strikeout', icon: 'strike-text', title: '删除线：先选中文字，再单击页面即可应用' },
  { id: 'note', icon: 'sticky-note', title: '便签：在页面上拖动框选位置' },
  { id: 'ink', icon: 'pencil', title: '墨迹：在页面上按住鼠标手绘' },
  { id: 'delete', icon: 'eraser', title: '橡皮：在页面上拖出一个框，删除框内所有标注' },
];

const THEME_OPTIONS: { id: ThemePreference; name: string; icon: string }[] = [
  { id: 'auto', name: '跟随系统 (Auto)', icon: '🖥️' },
  { id: 'light', name: '经典纯白学术 (Light)', icon: '☀️' },
  { id: 'dark', name: '夜间极客深色 (Dark)', icon: '🌙' },
  { id: 'sepia', name: '羊皮纸复古原木 (Sepia)', icon: '📜' }
];


/** Shown in the About dialog (version, build date, licence, recent notes). */
const APP_VERSION = 'v2.4.2';
const APP_BUILD_DATE = '2026-10-04';
const APP_LICENSE = 'Apache-2.0';
const APP_TECH = 'Tauri v2 + Rust · React 18 + TypeScript · MathJax · Mermaid · highlight.js';

/**
 * File name only, from a full path or a bare name.
 *
 * Deliberately regex-free: `split('\\')` / `split('/')` on literal separators cannot be
 * affected by escaping differences between source, bundler and runtime, which is what
 * made `path.split(/[\\/]/)` return the whole path in the shipped build. The hover
 * title keeps the full path; only the visible label is shortened.
 */
function fileBaseName(pathOrName: string | null | undefined): string {
  const raw = String(pathOrName || '');
  if (!raw) return '';
  const normalized = raw.split('\\').join('/');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  return parts.length ? parts[parts.length - 1] : raw;
}

/** One row of the model-driven context menu. */
const ContextMenuItem: React.FC<{
  item: MenuItem;
  ctx: ContextTarget;
  onRun: (id: string, ctx: ContextTarget) => void;
}> = ({ item, ctx, onRun }) => (
  <div
    className={`dropdown-item ${item.disabled ? 'disabled' : ''}`}
    onClick={() => { if (!item.disabled) onRun(item.id, ctx); }}
    role="menuitem"
  >
    <span>{item.icon ? `${item.icon}  ` : ''}{item.label}</span>
    {item.shortcut ? <span className="shortcut">{item.shortcut}</span> : null}
  </div>
);

/** Sidebar width: dragged range, and the width used on a fresh profile. */
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 520;
const SIDEBAR_DEFAULT_W = 260;
const RELEASE_NOTES: { version: string; date: string; items: string[] }[] = [
  {
    version: 'v2.4.2',
    date: '2026-10-07',
    items: [
      '修复：公式含 < 号（如 \\sum_{l<m}）时整篇渲染错乱 —— 裸 < 被 HTML 解析器当作标签，公式被截断、$$ 失去闭合，MathJax 便把后续正文（常含 # 标题）当成数学，报 "macro parameter character # in math mode"',
      '修法：公式正文按文本节点转义 < 为 &lt;（浏览器解码后仍是 <，LaTeX 语义不变）',
      '已复现并验证：修复前 DOM 出现伪造元素、公式截断；修复后公式完整、无 MathJax 报错'
    ]
  },
  {
    version: 'v2.4.1',
    date: '2026-10-07',
    items: [
      'PDF 右键菜单新增标注功能：高亮 / 下划线 / 删除线 / 便签 / 墨迹 / 橡皮',
      '先选中文字再右键：直接对选中文字应用高亮、下划线或删除线（一步到位）',
      '未选中文字时：菜单项改为“启用该标注工具”，菜单只武装、不会误关工具',
      '移除 PDF 视图里选择工具/文字后的指导性提示条（banner），界面更干净'
    ]
  },
  {
    version: 'v2.4.0',
    date: '2026-10-07',
    items: [
      '全新右键菜单（模型驱动，随右键目标变化）：Markdown 预览支持复制选中文字 / 复制此块 Markdown / 复制 LaTeX 源码 / 复制代码 / 在源码处打开 / 打开链接·复制链接 / 图片复制路径·在文件夹中显示',
      'PDF 页面右键：复制选中文字 / 旋转·插页·提取·删除此页 / 打印 / 缩放；标注右键：删除此标注·复制便签文字',
      '侧栏文件树、已打开文档、最近文件右键：打开 / 复制完整路径 / 在文件夹中显示',
      '菜单项按目标智能启用/禁用（如单页 PDF 不可删页、网络图片不可在文件夹显示），并做视口边界钳制不出屏'
    ]
  },
  {
    version: 'v2.3.7',
    date: '2026-10-07',
    items: [
      '性能：修复打开大 PDF 时内存暴涨 —— 页面改为虚拟化渲染，只栅格化视口附近的页，滚出视口即释放位图',
      '实测 120 页 PDF：GPU 进程内存 1046MB → 98MB，canvas 位图 1433MB → 24MB（与页数无关，恒定）',
      '打印改为逐页临时渲染（约 144dpi），不再依赖屏幕上已渲染的页，且峰值内存降到单页'
    ]
  },
  {
    version: 'v2.3.6',
    date: '2026-10-07',
    items: [
      '修复：打印 PDF 出现「一页正常、一页空白」—— 图像纵横比哪怕比页面高一丝，每张图都会溢出并多出一个近乎空白的 sheet',
      '修法：每页图像改用严格小于页面的盒子 + object-fit: contain，任何纵横比都不可能溢出',
      '该缺陷已在真实打印管线中离线复现（3 页内容打出 6 页）并验证修复后才应用'
    ]
  },
  {
    version: 'v2.3.5',
    date: '2026-10-07',
    items: [
      '修复：打印 PDF 出现空白页（首张空白）—— 改为在隔离的 iframe 文档中打印，彻底避开应用自身的打印样式表',
      '打印内容只含 PDF 页面本身：按 PDF 真实纸张尺寸、一页一版、无界面元素',
      '打印前等待页面图像解码完成，杜绝“图还没画好就打印”导致的空白'
    ]
  },
  {
    version: 'v2.3.4',
    date: '2026-10-07',
    items: [
      '修复：打印 PDF 时带上工具条、且被按 A4 重新分页 —— 现在按 PDF 自己的纸张尺寸逐页打印（一页一版，不再重排）',
      'PDF 工具条重构：删除页等“编辑类”按钮移入右侧「编辑器」面板（原排版检查器改名，PDF 时显示 PDF 操作）',
      '批注工具改为图标按钮，放在打印/导出按钮之后：选择、高亮、下划线、删除线、便签、墨迹、橡皮',
      '缩放比例移到状态栏（支持 Ctrl + 滚轮缩放）',
      '以上 PDF 相关按钮只在浏览 PDF 时出现，Markdown 界面不受影响'
    ]
  },
  {
    version: 'v2.3.3',
    date: '2026-10-06',
    items: [
      '修复：工作区（侧栏文件树）不显示 PDF 文件 —— 文件列表的扩展名白名单里缺少 pdf',
      '文件类型关联：安装包现在注册独立的「PDF Document」类型，MarkdownX 会出现在 .pdf 的「打开方式」中',
      '若 .pdf 已被 Edge / Acrobat 占用（存在 UserChoice），安装不会抢占默认，只把 MarkdownX 加为可选项'
    ]
  },
  {
    version: 'v2.3.2',
    date: '2026-10-06',
    items: [
      '修复：低缩放下「选中区域」与高亮/下划线错位 —— 文本层缺少 --scale-factor，导致 pdf.js 的 span 定位失效',
      '「选择」不再兼作删除：选择就是选中文本/图片，不创建也不删除任何标注',
      '新增「框选删除」工具：拖出一个方框，框内所有标注一并删除',
      '高亮 / 下划线 / 删除线 改为两步操作：先选中文字，再单击一次应用（选错了还能改）'
    ]
  },
  {
    version: 'v2.3.1',
    date: '2026-10-06',
    items: [
      '修复：PDF 页面文字无法选中 —— 新增 PDF.js 文本层，现在可正常选中与复制文字',
      '修复：高亮 / 下划线 / 删除线 改为「选中文字即标注」（原先要求拖框，且会与文字选择冲突）',
      '「选择」模式下点击已有标注可删除；缩放后标注仍精确对齐'
    ]
  },
  {
    version: 'v2.3.0',
    date: '2026-10-06',
    items: [
      'PDF 预览：以独立标签页打开 PDF，多页渲染、缩放、翻页；中文 PDF 正常显示（内嵌 cMaps）',
      'PDF 标注：高亮 / 下划线 / 删除线 / 便签 / 墨迹；保存后标注嵌入 PDF，可再次编辑',
      'PDF 结构编辑：旋转、删除页、插入空白页、提取单页、合并多个 PDF、编辑文档元数据',
      '导出压平副本：标注烧进页面，任何阅读器可见；中文便签用 Noto Sans SC 子集嵌入',
      'pdf.js / pdf-lib 按需懒加载 —— Markdown 的启动速度不受影响'
    ]
  },
  {
    version: 'v2.2.4',
    date: '2026-10-06',
    items: [
      '字体设置整合进排版检查器：字体族现在读取系统真实安装字体（Latin + CJK 两组下拉），不再使用硬编码列表',
      '设置弹窗去掉重复的“自定义排版与字体”标签，回归纯偏好设置（程序启动默认行为）'
    ]
  },
  {
    version: 'v2.2.3',
    date: '2026-10-06',
    items: [
      '自动升级端点多路兜底：raw 优先（不依赖 github.com），GitHub Release 作为后备',
      '发布流程同时更新 raw 与 Release，并自动实测两条链路的可达性',
      '这是第一次由应用自身完成的升级 —— 若你看到这条说明，说明自动升级已跑通 🎉'
    ]
  },
  {
    version: 'v2.2.2',
    date: '2026-10-06',
    items: [
      '更新源改为 raw.githubusercontent.com 分发（实测 0.1s 可达；github.com 在本网络常超时）',
      '发布流程经 GitHub API 完成，绕开不稳定的 github.com；发布后脚本自动实测两个 raw 地址',
      '许可证统一为 Apache-2.0（与仓库 LICENSE 一致）',
      '本版为“引导版”：需手动安装一次；此后版本可在应用内检查并一键升级'
    ]
  },
  {
    version: 'v2.2.1',
    date: '2026-10-06',
    items: [
      '更新源指向真实仓库（https://github.com/callyli00/MarkdownX）—— 本版是“引导版”',
      '引导含义：这一版需要手动安装一次；从它开始，后续版本可在应用内检查并一键升级',
      '界面无功能改动'
    ]
  },
  {
    version: 'v2.2.0',
    date: '2026-10-04',
    items: [
      '自动升级（GitHub/HTTPS + 官方 updater 插件）：启动后静默检查，发现新版本只在帮助图标上点一个小圆点',
      '更新由用户决定：帮助菜单「检查更新…」查看版本与说明，点「下载并安装」才下载、校验签名、静默安装并重启',
      '更新包经 minisign 签名校验；私钥保存在仓库之外，配置里只有公钥',
      '任何检查/下载失败都静默跳过、只记日志，绝不阻塞启动或打断编辑'
    ]
  },
  {
    version: 'v2.1.1',
    date: '2026-10-04',
    items: [
      '菜单摆放重构（D 方案）：取消“全能菜单”，改按性质分布到图标与右键菜单',
      '顶栏：保存（左键保存/右键另存为）、打印导出（左键直接打印/右键选格式）、视图、主题（左键循环/右键选择）、偏好设置、帮助',
      '文件操作回归侧栏；文档操作进入标签右键菜单；正文右键提供打印/导出与视图切换',
      '侧栏收起时，格栅上除“显示侧栏”箭头外新增“打开文件”入口，文件操作始终一键可达'
    ]
  },
  {
    version: 'v2.0.0',
    date: '2026-10-04',
    items: [
      '工作台布局重构：侧边栏改为上下贯通（顶到底），顶栏右缩至内容区，仅覆盖内容一侧',
      '侧边栏宽度可拖动格栅调节（180–520px，实时生效并记忆）；折叠改为格栅上的箭头按钮',
      '中间改为文档标签（tab）模式：标签显示文件名，鼠标悬停显示完整路径，可切换与关闭',
      '同步隐藏打印输出中的新外壳（标签条、格栅）；侧栏与最近文件的可见标签改为文件名，悬停仍为完整路径'
    ]
  },
  {
    version: 'v1.9.17',
    date: '2026-10-04',
    items: [
      '界面清理：移除三处影响观感的路径/窗口命令（顶栏的应用图标与文档完整路径、菜单底部的窗口控制项、侧边栏底部的路径行）',
      '相应删除已无引用的样式规则；全窗口不再出现任何文件绝对路径',
      '正文渲染与打印行为不受影响'
    ]
  },
  {
    version: 'v1.9.16',
    date: '2026-10-04',
    items: [
      '修复打印/导出 PDF 把界面一起打出来：顶栏、侧边栏、排版检查器、状态栏、窗口控件不再进入打印',
      '根因：打印样式表隐藏的仍是 v1.9.0 改版前的旧类名（.typora-menubar），改版后的 .wb-topbar / .typora-sidebar / .typo-inspector 不在隐藏列表里',
      '打印改为等 React 提交"菜单已关闭"状态后再触发（用定时器而非 requestAnimationFrame，窗口最小化时也不会静默失效）'
    ]
  },
  {
    version: 'v1.9.15',
    date: '2026-10-04',
    items: [
      '修复"双击打开第二个 Markdown 后窗口卡住、能滚动但点不动"：不再把程序自身路径当文档打开',
      '根因：单实例回调转发的命令行参数包含 argv[0]（可执行文件路径），旧代码把它当文件读取——13MB 的 exe 被当成文本载入，界面随即卡死',
      'Rust 侧剔除 argv[0] 与开关参数；前端再加一道防线（拒绝 exe/dll/msi 等可执行文件后缀）；CLI 参数只处理一次'
    ]
  },
  {
    version: 'v1.9.14',
    date: '2026-10-04',
    items: [
      '修复 CRLF（Windows）文档中"第一个代码块之后公式全部不渲染"（需代码围栏 + 其后有公式，实测影响面较窄）',
      '解析搬入 Web Worker：大文档解析不再占用主线程，窗口全程可响应；Worker 不可用时自动回退同步解析，只慢不错',
      '新增渲染等价护栏 tools/render-equivalence-gate：证明 Worker 路径与同步路径逐字节一致，且 LF/CRLF 渲染结果一致'
    ]
  },
  {
    version: 'v1.9.13',
    date: '2026-10-04',
    items: [
      '回退到 v1.9.6 的渲染与排版行为（撤销 v1.9.7–v1.9.12 的分片渲染与按需排版）',
      '原因：分片渲染/按需排版整改多轮后，出现“公式不自动渲染”的致命退化；先恢复可靠行为'
    ]
  },
  {
    version: 'v1.9.6',
    date: '2026-10-04',
    items: [
      '源码模式点击大纲：光标落在标题行首（可直接编辑 ## 前缀），且不选中任何内容'
    ]
  },
  {
    version: 'v1.9.5',
    date: '2026-10-04',
    items: [
      '顶栏 “?” 改为「关于」：展示版本号、本次更新、许可证与构建时间',
      '快捷键速查表统一收纳进 ⋯ 菜单 → 帮助',
      '源码模式点击大纲不再全选标题：仅定位光标并高亮该行'
    ]
  },
  {
    version: 'v1.9.4',
    date: '2026-10-04',
    items: [
      '修复最近文件子菜单的长路径溢出面板（改为省略号裁切）',
      '修复源码模式点击大纲不跳转（改用真实 caret 几何定位）'
    ]
  },
  {
    version: 'v1.9.3',
    date: '2026-10-04',
    items: ['修复二级菜单不向右弹出、菜单底部出现水平滚动条']
  },
  {
    version: 'v1.9.2',
    date: '2026-10-04',
    items: ['修复窗口三键失效（补齐 Tauri v2 窗口命令能力白名单）']
  }
];
const THEME_CYCLE: ThemePreference[] = ['auto', 'light', 'dark', 'sepia'];

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function resolveTheme(pref: ThemePreference): AppTheme {
  if (pref !== 'auto') return pref;
  return systemPrefersDark() ? 'dark' : 'light';
}

interface TypographyConfig {
  latinFont: string;
  cjkFont: string;
  fontSize: number;
  lineHeight: number;
  paragraphMargin: number;
  textAlign: 'justify' | 'left';
  firstLineIndent: boolean;
  maxWidth: string;
}


const DEFAULT_TYPOGRAPHY: TypographyConfig = {
  latinFont: 'Times New Roman',
  cjkFont: '宋体',
  fontSize: 16,
  lineHeight: 1.85,
  paragraphMargin: 1.25,
  textAlign: 'justify',
  firstLineIndent: false,
  maxWidth: '860px'
};

interface AppPreferences {
  defaultTheme: ThemePreference;
  defaultViewMode: 'typora' | 'source';
  defaultMathEngine?: 'svg' | 'chtml';
  autoWatchExternalChanges?: boolean;
  defaultTypography: TypographyConfig;
}

const FACTORY_PREFERENCES: AppPreferences = {
  defaultTheme: 'auto',
  defaultViewMode: 'typora',
  defaultMathEngine: 'svg',
  autoWatchExternalChanges: true,
  defaultTypography: DEFAULT_TYPOGRAPHY
};

function loadStoredPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem('markdownx_app_preferences_v140');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...FACTORY_PREFERENCES,
        ...parsed,
        defaultTypography: { ...FACTORY_PREFERENCES.defaultTypography, ...(parsed.defaultTypography || {}) }
      };
    }
    // Backward compatibility with previous versions
    const oldTheme = localStorage.getItem('preferred_app_theme') as AppTheme;
    const oldTypo = localStorage.getItem('preferred_typography_v3');
    if (oldTheme || oldTypo) {
      return {
        ...FACTORY_PREFERENCES,
        defaultTheme: (oldTheme === 'light' || oldTheme === 'dark' || oldTheme === 'sepia') ? oldTheme : 'auto',
        defaultTypography: oldTypo ? { ...DEFAULT_TYPOGRAPHY, ...JSON.parse(oldTypo) } : DEFAULT_TYPOGRAPHY
      };
    }
  } catch (err) {
    console.error('Failed to load stored preferences:', err);
  }
  return FACTORY_PREFERENCES;
}

// A font is bucketed as CJK when its family name contains a CJK character
// (宋体, 微软雅黑, 楷体 ...). Pure-ASCII names are Latin.
const CJK_FAMILY = /[\u4e00-\u9fff]/;
const isCJKFamily = (name: string) => CJK_FAMILY.test(name);

// Fallback font buckets, used only when `list_system_fonts` can't run. They
// also guarantee the dropdowns are never empty. Values are single family
// names so they match exactly what gets applied as `font-family`.
const FALLBACK_LATIN_FAMILIES = [
  'Times New Roman', 'Cambria', 'Georgia', 'Garamond', 'Segoe UI', 'Arial', 'Consolas'
];
const FALLBACK_CJK_FAMILIES = [
  '宋体', '微软雅黑', '楷体', '仿宋', '幼圆', 'Noto Serif SC', 'Noto Sans SC'
];

// Reduce a stored font-family value (which may be a stack like "Georgia, 'Times
// New Roman'") to a single family that exists in `options`, so the <select>
// always renders a valid current selection instead of a blank value.
function matchFamilyValue(raw: string, options: { value: string }[]): string {
  if (!raw) return options[0]?.value ?? '';
  const first = raw.split(',')[0].trim().replace(/^['"]+|['"]+$/g, '').toLowerCase();
  const exact = options.find((o) => o.value.toLowerCase() === first);
  if (exact) return exact.value;
  const sub = options.find((o) => {
    const v = o.value.toLowerCase();
    return v.includes(first) || first.includes(v);
  });
  if (sub) return sub.value;
  return options[0]?.value ?? '';
}

const MAX_WIDTH_OPTIONS = [
  { name: '窄版 (760px) - 专注单篇阅读', value: '760px' },
  { name: '标准版 (860px) - Typora 黄金阅读比例', value: '860px' },
  { name: '宽版 (1020px) - 适合大图与宽幅公式', value: '1020px' },
  { name: '超宽版 (1280px)', value: '1280px' },
  { name: '自适应全屏 (100%)', value: '100%' }
];



const MarkdownXLogo: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
  >
    <defs>
      <linearGradient id="mxGradLeft" x1="0%" y1="100%" x2="0%" y2="0%">
        <stop offset="0%" stopColor="#0284c7" />
        <stop offset="100%" stopColor="#38bdf8" />
      </linearGradient>
      <linearGradient id="mxGradRight" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#c084fc" />
        <stop offset="100%" stopColor="#7c3aed" />
      </linearGradient>
      <linearGradient id="mxGradCenter" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#38bdf8" />
        <stop offset="50%" stopColor="#6366f1" />
        <stop offset="100%" stopColor="#c084fc" />
      </linearGradient>
    </defs>
    {/* Dark rounded squircle background */}
    <rect x="4" y="4" width="92" height="92" rx="22" fill="#0f172a" stroke="#334155" strokeWidth="3" />
    {/* Artistic stylized M ribbon strokes */}
    {/* Left pillar */}
    <path d="M22 75 L22 34 L33 26 L33 75 Z" fill="url(#mxGradLeft)" />
    {/* Right pillar */}
    <path d="M67 75 L67 26 L78 34 L78 75 Z" fill="url(#mxGradRight)" />
    {/* Dynamic V arms */}
    <path d="M28 32 L50 62 L42 66 L22 38 Z" fill="#2563eb" />
    <path d="M72 32 L50 62 L58 66 L78 38 Z" fill="#9333ea" />
    {/* Center apex gemstone / X cross */}
    <polygon points="50,46 59,57 50,68 41,57" fill="#f43f5e" />
  </svg>
);

interface FileTreeNodeProps {
  item: FileEntry;
  level: number;
  activePath: string | null;
  expandedDirs: Record<string, boolean>;
  dirChildrenCache: Record<string, FileEntry[]>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onFileContextMenu: (x: number, y: number, path: string) => void;
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  item,
  level,
  activePath,
  expandedDirs,
  dirChildrenCache,
  onToggleDir,
  onOpenFile,
  onFileContextMenu,
}) => {
  const isExpanded = !!expandedDirs[item.path];
  const children = dirChildrenCache[item.path];

  if (item.is_dir) {
    return (
      <div className="file-tree-node-group">
        <div
          className={`file-tree-item is-dir level-${level}`}
          style={{ paddingLeft: `${level * 12 + 6}px` }}
          onClick={() => onToggleDir(item.path)}
          title={item.path}
        >
          <span className="tree-arrow">{isExpanded ? '▼' : '▶'}</span>
          <span className="file-icon">{isExpanded ? '📂' : '📁'}</span>
          <span className="file-title">{item.name}</span>
        </div>
        {isExpanded && (
          <div className="file-tree-children">
            {children === undefined ? (
              <div className="file-tree-loading" style={{ paddingLeft: `${(level + 1) * 12 + 16}px` }}>
                加载中...
              </div>
            ) : children.length === 0 ? (
              <div className="file-tree-empty-dir" style={{ paddingLeft: `${(level + 1) * 12 + 16}px` }}>
                (空文件夹)
              </div>
            ) : (
              children.map((child) => (
                <FileTreeNode
                  key={child.path}
                  item={child}
                  level={level + 1}
                  activePath={activePath}
                  expandedDirs={expandedDirs}
                  dirChildrenCache={dirChildrenCache}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  onFileContextMenu={onFileContextMenu}
                />
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`file-tree-item is-file level-${level} ${item.path === activePath ? 'active' : ''}`}
      style={{ paddingLeft: `${level * 12 + 20}px` }}
      onClick={() => onOpenFile(item.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onFileContextMenu(e.clientX, e.clientY, item.path);
      }}
      title={item.path}
    >
      <span className="file-icon">{/\.pdf$/i.test(item.name) ? '📕' : '📝'}</span>
      <span className="file-title">{item.name}</span>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Preview <-> source position mapping
 *
 * The preview is produced by marked, so a rendered node carries no link back
 * to the Markdown it came from. Both directions of the Typora-style mode
 * switch therefore work by folding the two representations down to a form that
 * can be compared - whitespace and Markdown syntax removed - and searching for
 * one inside the other.
 * ------------------------------------------------------------------ */

/** Characters that mark up the source but never survive into rendered text. */
const MATCH_NOISE = /[#*_`>|[\]()!~\\=+\-$]/;

/** One folded character, or '' when the character never survives into text. */
function foldChar(ch: string): string {
  if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\u00A0') return '';
  if (MATCH_NOISE.test(ch)) return '';
  return ch.toLowerCase();
}

/** Fold a string for comparison: drop whitespace and Markdown syntax, lower-case. */
export function foldForMatch(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += foldChar(text[i]);
  return out;
}

interface SourceIndex {
  /** Source with whitespace and Markdown syntax removed, lower-cased. */
  folded: string;
  /** Original character offset of each character in `folded`. */
  offsets: number[];
}

export function buildSourceIndex(content: string): SourceIndex {
  const chars: string[] = [];
  const offsets: number[] = [];

  // HTML tags are markup, never visible text - and an attribute often repeats
  // text that also renders (an img alt restates the caption below it), which
  // used to capture lookups meant for the visible copy. Fold the document line
  // by line, skipping tag interiors; fenced code is exempt because there a
  // literal '<div>' IS content.
  const lines = content.split('\n');
  let base = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) inFence = !inFence;
    let i = 0;
    while (i < line.length) {
      if (!inFence && line[i] === '<') {
        const tag = /^<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\/?>/.exec(line.slice(i));
        if (tag) {
          i += tag[0].length;
          continue;
        }
      }
      const folded = foldForMatch(line[i]);
      if (folded) {
        chars.push(folded);
        offsets.push(base + i);
      }
      i++;
    }
    base += line.length + 1;
  }
  return { folded: chars.join(''), offsets };
}

// The index is rebuilt on every lookup, so cache it against the current text.
let cachedIndex: { key: string; value: SourceIndex } | null = null;

function getSourceIndex(content: string): SourceIndex {
  if (cachedIndex && cachedIndex.key === content) return cachedIndex.value;
  const value = buildSourceIndex(content);
  cachedIndex = { key: content, value };
  return value;
}

/**
 * Character offset in the source where the given rendered text begins, or null
 * when it cannot be located. Progressively shorter prefixes are tried so that a
 * block whose tail renders differently still resolves.
 */
export function locateRenderedText(index: SourceIndex, text: string, hint = 0): number | null {
  const needle = foldForMatch(text);
  if (needle.length < 4) return null;
  const from = Math.max(0, Math.min(hint, index.folded.length));

  // Try the full prefix first, then progressively shorter ones. The coarse
  // decrement keeps long blocks cheap, but it must always end with the short
  // prefixes too: a table or callout renders its inline math and its caption in
  // a different shape than the source, so only a short leading fragment (e.g.
  // the visible cell text) will match - a step that jumps from 10 straight past
  // 4 would skip exactly those.
  const lengths: number[] = [];
  const step = Math.max(1, Math.floor(needle.length / 8));
  for (let len = needle.length; len >= 24; len -= step) lengths.push(len);
  for (const len of [24, 16, 12, 8, 6, 4]) {
    if (len < needle.length && !lengths.includes(len)) lengths.push(len);
  }
  if (!lengths.includes(needle.length)) lengths.unshift(needle.length);

  for (const len of lengths) {
    const probe = needle.slice(0, len);
    // Prefer a hit at/after the hint: an identical sentence earlier in the
    // document must not capture a click that happened further down.
    const near = index.folded.indexOf(probe, from);
    if (near !== -1) return index.offsets[near];
    const anywhere = index.folded.indexOf(probe);
    if (anywhere !== -1) return index.offsets[anywhere];
  }
  return null;
}

/**
 * The text a rendered block should be matched against. Decorative chrome that
 * has no counterpart in the source is dropped, and blocks whose visible form is
 * generated (typeset math, rendered diagrams) contribute their original source.
 */
/**
 * Resolve an element inside the rendered preview to a character offset in the
 * Markdown source. Walks outward from the clicked node so that a click on an
 * inline <code>/<strong>/<svg> resolves through its enclosing block; the
 * outermost block that still matches wins.
 */
export function sourceOffsetForElement(
  start: HTMLElement,
  source: string,
  root: HTMLElement | null,
  point?: { x: number; y: number }
): number | null {
  // 1) Deterministic anchors (v1.8.5): the block's TRUE source span is stamped
  //    on the element. Read it, then refine to the clicked character inside
  //    that block's own slice - a bounded alignment, not a document search.
  const anchor = anchorRangeOf(start, root);
  if (anchor) {
    // A click on the artwork itself lands on the <img> tag, not the caption.
    const img = start.closest('img');
    if (img && anchor.el.contains(img)) {
      const imgAt = source.indexOf('<img', anchor.start);
      if (imgAt !== -1 && (anchor.end <= anchor.start || imgAt < anchor.end)) return imgAt;
    }
    const refined = refineWithinAnchor(anchor.el, source, anchor.start, anchor.end, point);
    return refined ?? anchor.start;
  }

  // 2) Legacy fallback for renders without anchors (older HTML, exotic blocks):
  //    fold-and-search, innermost block first.
  const index = getSourceIndex(source);
  let node: HTMLElement | null = start;

  // Walk outward and take the FIRST block that resolves: the innermost match is
  // the most faithful answer to "where did I click". A click on a table cell
  // therefore lands on that row rather than on the table header, while a click
  // on a cell whose rendered text cannot be found (typeset math, chromeless
  // chrome) still falls through to the enclosing row, list or paragraph.
  while (node && node !== root) {
    // TABLE and the list wrappers matter: clicking a table's own padding (or a
    // <ul> gutter) must still resolve, not fall through to the article. FIGURE
    // and FIGCAPTION matter for the same reason: a book page is mostly figures,
    // and a caption click used to walk past both and resolve to nothing.
    if (/^(P|H1|H2|H3|H4|H5|H6|LI|TD|TH|TR|TABLE|THEAD|TBODY|TFOOT|CAPTION|PRE|BLOCKQUOTE|UL|OL|DL|DT|DD|DIV|SECTION|ARTICLE|FIGURE|FIGCAPTION|ASIDE|HEADER|FOOTER|MAIN|NAV|DETAILS|SUMMARY|ADDRESS|HGROUP)$/.test(node.tagName)) {
      const probe = probeTextOf(node);
      if (probe.trim()) {
        const found = locateRenderedText(index, probe, 0);
        if (found !== null) {
          // The artwork itself: land on the <img> tag, not on the caption below.
          // Only a raw-HTML figure is written literally in the source; a
          // Markdown image has none, so restricting the search to figures
          // keeps a stray '<img' elsewhere from capturing the click.
          const img = start.closest('img');
          if (img && img.closest('figure') && node.contains(img)) {
            const tagAt = source.lastIndexOf('<img', found);
            if (tagAt !== -1 && found - tagAt < 4000) return tagAt;
          }
          // Otherwise narrow the block down to the text actually double-clicked.
          const refined = point ? refineOffsetAtPoint(index, found, point.x, point.y) : null;
          return refined ?? found;
        }
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Deterministic click-to-source resolution (v1.8.5). The renderer stamps every
 * top-level block - and every generated formula or diagram - with the TRUE
 * source span it was built from (data-src-start / data-src-end). A click reads
 * the anchor of its innermost enclosing block and, within that block, aligns
 * the clicked character against the block's own source slice. No global text
 * search is involved, so repeated paragraphs and duplicate captions cannot
 * deflect the answer.
 */
function anchorRangeOf(el: HTMLElement, root: HTMLElement | null): { el: HTMLElement; start: number; end: number } | null {
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    const attr = node.getAttribute('data-src-start');
    if (attr !== null) {
      const start = Number(attr);
      const endAttr = Number(node.getAttribute('data-src-end'));
      if (Number.isFinite(start) && start >= 0) {
        return { el: node, start, end: Number.isFinite(endAttr) && endAttr >= start ? endAttr : start };
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Measure where the caret at `pos` actually sits inside a textarea, in CONTENT
 * coordinates (padding included, scroll excluded). A mirror div replicating the
 * textarea's box carries the text up to `pos` plus a zero-width marker, so the
 * answer is correct even when long paragraphs wrap - logical-line arithmetic
 * silently drifts the moment one line folds onto two.
 */
export function measureTextareaCaret(
  ta: HTMLTextAreaElement,
  pos: number
): { top: number; caretLeft: number; height: number } {
  const cs = window.getComputedStyle(ta);
  const mirror = document.createElement('div');
  const copied = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'textTransform', 'wordSpacing', 'textIndent', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'
  ];
  for (const prop of copied) {
    (mirror.style as unknown as Record<string, string>)[prop] = cs.getPropertyValue(
      prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
    );
  }
  mirror.style.position = 'absolute';
  mirror.style.left = '-10000px';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.boxSizing = cs.boxSizing || 'border-box';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.wordBreak = cs.wordBreak || 'break-word';
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.textContent = ta.value.slice(0, Math.max(0, Math.min(pos, ta.value.length)));
  const marker = document.createElement('span');
  marker.textContent = '\u200B';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const fallbackLineHeight = parseFloat(cs.lineHeight);
  const height = Number.isFinite(fallbackLineHeight) && fallbackLineHeight > 0
    ? fallbackLineHeight
    : marker.offsetHeight || 24;
  // The inline marker reports its own glyph box, not the full line box; lift
  // the result by the half-leading so the band covers the visual line exactly.
  const halfLeading = Math.max(0, (height - (marker.offsetHeight || height)) / 2);
  const result = { top: marker.offsetTop - halfLeading, caretLeft: marker.offsetLeft, height };
  document.body.removeChild(mirror);
  return result;
}

/** The first anchor inside `el` (used for the reverse direction). */
function firstAnchorIn(el: HTMLElement): { start: number; end: number } | null {
  const holder = el.matches('[data-src-start]') ? el : (el.querySelector('[data-src-start]') as HTMLElement | null);
  if (!holder) return null;
  const start = Number(holder.getAttribute('data-src-start'));
  if (!Number.isFinite(start) || start < 0) return null;
  const endAttr = Number(holder.getAttribute('data-src-end'));
  return { start, end: Number.isFinite(endAttr) && endAttr >= start ? endAttr : start };
}

/** Fold a source slice, skipping HTML tag interiors (never visible text). */
function foldSourceRange(source: string, start: number, end: number, skipTags: boolean): { folded: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  const stop = Math.min(source.length, Math.max(start, end));
  let i = Math.max(0, start);
  while (i < stop) {
    const ch = source[i];
    if (skipTags && ch === '<' && /[A-Za-z/!?]/.test(source[i + 1] || '')) {
      const close = source.indexOf('>', i);
      if (close !== -1 && close - i < 4000) {
        i = close + 1;
        continue;
      }
    }
    const f = foldChar(ch);
    if (f) {
      chars.push(f);
      map.push(i);
    }
    i++;
  }
  return { folded: chars.join(''), map };
}

function foldWithMap(text: string): { folded: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldChar(text[i]);
    if (f) {
      chars.push(f);
      map.push(i);
    }
  }
  return { folded: chars.join(''), map };
}

/** Count of folded characters at raw positions strictly before `limit`. */
function foldCountBefore(map: number[], limit: number): number {
  let lo = 0;
  let hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Rendered text of a block with generated chrome removed and every typeset
 * formula replaced by the TeX it was built from, plus the position of the
 * clicked character inside that text.
 */
function buildBlockText(block: HTMLElement, click: { node: Node; offset: number } | null): { text: string; clickAt: number } {
  let out = '';
  let clickAt = -1;
  const checkClick = (node: Node, extra: number) => {
    if (click && (click.node === node || (node.nodeType === Node.ELEMENT_NODE && node.contains(click.node)))) {
      clickAt = out.length + extra;
    }
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      checkClick(node, Math.min(Math.max(click ? click.offset : 0, 0), text.length));
      out += text;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE') return;
    if (el.classList.contains('code-block-header') || el.classList.contains('math-equation-tag')) return;
    if (el.classList.contains('mermaid-unclosed-hint') || el.classList.contains('mermaid-error-note')) return;
    if (el.style && el.style.display === 'none') return;
    const tex = el.getAttribute('data-tex-source');
    if (tex !== null && (el.classList.contains('math-inline') || el.classList.contains('math-equation-row'))) {
      checkClick(el, 1);
      out += tex;
      return;
    }
    const diagramSource = el.getAttribute('data-mermaid-source');
    if (diagramSource !== null) {
      checkClick(el, 0);
      out += diagramSource;
      return;
    }
    for (const child of Array.from(el.childNodes)) visit(child);
  };
  for (const child of Array.from(block.childNodes)) visit(child);
  return { text: out, clickAt };
}

/**
 * Greedy fold-space alignment: walk both folded strings; on a mismatch skip
 * whichever side's next occurrence of the other's character lies nearer. The
 * source side carries markup the rendered side never shows, and the rendered
 * side carries generated chrome, so both skip directions are needed. Returns
 * the source fold index for each processed rendered fold index (-1 = unmapped).
 */
function alignFolded(foldedRendered: string, foldedSource: string): Int32Array {
  const map = new Int32Array(foldedRendered.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < foldedRendered.length && j < foldedSource.length) {
    if (foldedRendered[i] === foldedSource[j]) {
      map[i] = j;
      i++;
      j++;
      continue;
    }
    const nextInSource = foldedSource.indexOf(foldedRendered[i], j);
    const nextInRendered = foldedRendered.indexOf(foldedSource[j], i);
    if (nextInSource === -1 && nextInRendered === -1) break;
    if (nextInRendered === -1 || (nextInSource !== -1 && nextInSource - j <= nextInRendered - i)) {
      j = nextInSource;
    } else {
      i = nextInRendered;
    }
  }
  return map;
}

/** The click position (text node + offset) inside `block`, if determinable. */
function locateClickIn(block: HTMLElement, point: { x: number; y: number } | undefined): { node: Node; offset: number } | null {
  try {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (block.contains(range.startContainer) && range.startContainer.nodeType === Node.TEXT_NODE) {
        return { node: range.startContainer, offset: range.startOffset };
      }
    }
  } catch {
    /* fall through to the point */
  }
  if (!point) return null;
  const caretFromPoint = (document as Document & {
    caretRangeFromPoint?: (cx: number, cy: number) => Range | null;
  }).caretRangeFromPoint;
  if (!caretFromPoint) return null;
  try {
    const range = caretFromPoint.call(document, point.x, point.y);
    if (range && block.contains(range.startContainer)) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Map the clicked character inside an anchored block to its exact source
 * offset, aligning folded rendered text against the block's own source slice.
 * Returns null when no reliable alignment exists; the caller then falls back
 * to the block start, which is still exact at block granularity.
 */
function refineWithinAnchor(
  block: HTMLElement,
  source: string,
  start: number,
  end: number,
  point?: { x: number; y: number }
): number | null {
  const click = locateClickIn(block, point);
  if (!click) return null;
  const built = buildBlockText(block, click);
  if (built.clickAt < 0) return null;
  const skipTags = !block.classList.contains('code-block-container');
  const sourceFold = foldSourceRange(source, start, end, skipTags);
  if (!sourceFold.folded.length) return null;
  const renderedFold = foldWithMap(built.text);
  if (!renderedFold.folded.length) return null;
  const aligned = alignFolded(renderedFold.folded, sourceFold.folded);
  const clickFold = foldCountBefore(renderedFold.map, built.clickAt);
  // The caret sits before the character the user pointed at, so map THAT
  // character; walk back only when it has no aligned counterpart.
  for (let k = Math.min(clickFold, aligned.length - 1); k >= 0; k--) {
    const j = aligned[k];
    if (j >= 0 && j < sourceFold.map.length) return sourceFold.map[j];
  }
  return null;
}

/**
 * Narrow a resolved block down to the text at a double-click point. The block
 * start is a coarse answer for a long paragraph; when the browser can tell us
 * which character the click landed on, locate that neighbourhood instead. A
 * failed or ambiguous refinement falls back to the block offset.
 */
function refineOffsetAtPoint(index: SourceIndex, blockOffset: number, x: number, y: number): number | null {
  const caretFromPoint = (document as Document & {
    caretRangeFromPoint?: (cx: number, cy: number) => Range | null;
  }).caretRangeFromPoint;
  if (!caretFromPoint) return null;
  let range: Range | null = null;
  try {
    range = caretFromPoint.call(document, x, y);
  } catch {
    return null;
  }
  if (!range) return null;
  const node: Node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent || '';
  const at = Math.min(Math.max(range.startOffset, 0), text.length);
  const windowText = text.slice(Math.max(0, at - 40), Math.min(text.length, at + 20));
  const windowFold = foldForMatch(windowText);
  if (windowFold.length < 4) return null;
  const found = locateRenderedText(index, windowText, blockOffset);
  if (found === null) return null;
  // Accept the refinement only when the WHOLE window matched there; otherwise
  // locateRenderedText fell back to a short prefix and the answer is a guess.
  const foldedAt = index.offsets.indexOf(found);
  if (foldedAt === -1 || !index.folded.startsWith(windowFold, foldedAt)) return null;
  return found;
}

/** The first child element of `root` whose rendered content matches `offset` or earlier. */
export function blockForSourceOffset(root: HTMLElement, source: string, offset: number): HTMLElement | null {
  const index = getSourceIndex(source);
  let cursor = 0;
  let target: HTMLElement | null = null;
  for (const el of Array.from(root.children) as HTMLElement[]) {
    const anchor = firstAnchorIn(el);
    let at: number | null = anchor ? anchor.start : null;
    if (at === null) {
      const probe = probeTextOf(el);
      if (!probe.trim()) continue;
      at = locateRenderedText(index, probe, cursor);
      if (at === null) continue;
    }
    cursor = Math.max(cursor, at);
    if (at <= offset) target = el;
    else break; // children are in document order
  }
  return target;
}

export function probeTextOf(el: HTMLElement): string {
  const mathRow = el.closest('.math-equation-row');
  if (mathRow) return mathRow.getAttribute('data-tex-source') || '';
  // The unclosed-fence notice is generated UI with no source counterpart.
  // Resolve it to the fence it annotates, so clicking it opens that code.
  const hint = el.closest('.mermaid-unclosed-hint');
  if (hint) {
    const prev = hint.previousElementSibling as HTMLElement | null;
    if (prev) return probeTextOf(prev);
  }
  const diagram = el.closest('.mermaid-diagram');
  if (diagram) {
    const src = diagram.querySelector('.mermaid-render-target')?.getAttribute('data-mermaid-source');
    if (src) return src;
  }
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.code-block-header, .math-equation-tag, .equation-ref-missing').forEach((n) => n.remove());
  // MathJax replaces a formula's TeX with rendered glyphs, which no longer
  // match the source; swap each formula back for the TeX it was built from so
  // probes keep lining up with the Markdown.
  clone.querySelectorAll('.math-inline[data-tex-source]').forEach((n) => {
    n.textContent = n.getAttribute('data-tex-source') || '';
  });
  return clone.textContent || '';
}

export const App: React.FC = () => {
  // Initial user preferences & defaults (initialized first before states depending on it)
  const initialPrefs = useRef<AppPreferences>(loadStoredPreferences());

  // Manage multiple open files in dropdown list - Pure Blank Document on Startup
  const [openFiles, setOpenFiles] = useState<FileTab[]>([
    {
      id: 'default-tab',
      name: '未命名文档.md',
      path: null,
      content: '', // 启动默认纯白空白文档
      isModified: false
    }
  ]);
  const [activeFileId, setActiveFileId] = useState<string>('default-tab');
  
  // Recent files history
  const [recentFiles, setRecentFiles] = useState<{ name: string; path: string }[]>([]);

  // Mode: false for Typora WYSIWYG/Preview mode (default), true for Source mode
  const [isSourceMode, setIsSourceMode] = useState<boolean>(() => initialPrefs.current.defaultViewMode === 'source');

  // Where the source caret just landed, painted as a short-lived highlight so
  // the writer can actually see the jump target instead of hunting for it.
  const [caretFlash, setCaretFlash] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    tickLeft: number;
  } | null>(null);
  // The line's position in CONTENT coordinates, so the highlight can stay glued
  // to it if the writer scrolls while it is still fading.
  const flashAnchorRef = useRef<{ paneTop: number; contentTop: number } | null>(null);

  // Caret offset to apply when the source view opens, and the position to
  // reveal again when the preview comes back (Typora-style continuity). The
  // restore also records the tab and the exact Markdown it was measured
  // against, so it can never scroll a differently-rendered document.
  const pendingSourceCaretRef = useRef<number | null>(null);
  const pendingPreviewScrollRef = useRef<{ tabId: string; content: string; offset: number } | null>(null);
  
  // Active dropdown menu: null | 'file' | 'edit' | 'format' | 'view' | 'fileList'
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  // Theme state: light | dark | sepia (initialized from user default)
  const [themePref, setThemePref] = useState<ThemePreference>(() => initialPrefs.current.defaultTheme);
  // The resolved theme (what the CSS and exporters actually see).
  const [appTheme, setAppTheme] = useState<AppTheme>(() => resolveTheme(initialPrefs.current.defaultTheme));
  const [defaultThemeSetting, setDefaultThemeSetting] = useState<ThemePreference>(() => initialPrefs.current.defaultTheme);
  const [defaultModeSetting, setDefaultModeSetting] = useState<'typora' | 'source'>(() => initialPrefs.current.defaultViewMode);
  const [defaultMathEngineSetting, setDefaultMathEngineSetting] = useState<'svg' | 'chtml'>(() => initialPrefs.current.defaultMathEngine || 'svg');
  const [autoWatchSetting, setAutoWatchSetting] = useState<boolean>(() => initialPrefs.current.autoWatchExternalChanges !== false);
  const [externalReloadNotice, setExternalReloadNotice] = useState<string | null>(null);
  const [pdfOpenError, setPdfOpenError] = useState<string | null>(null);
  // PDF viewing state lives here (not inside PdfViewer) because the controls are
  // spread across the app chrome: tool icons in the top bar, zoom in the status bar.
  const [pdfTool, setPdfTool] = useState<ViewerTool | null>(null);
  const [pdfScale, setPdfScale] = useState<number>(1.25);
  const [pdfPrintToken, setPdfPrintToken] = useState<number>(0);
  /** Text selected in the viewer, waiting for a toolbar mark button to be pressed. */
  const [pdfPendingSel, setPdfPendingSel] = useState<{ pageIndex: number; rects: NormRect[] } | null>(null);
  const [pdfPageInfo, setPdfPageInfo] = useState<{ page: number; total: number } | null>(null);
  const [pdfMetaOpen, setPdfMetaOpen] = useState<boolean>(false);
  const [pdfMetaDraft, setPdfMetaDraft] = useState<{ title: string; author: string; subject: string; keywords: string }>({
    title: '',
    author: '',
    subject: '',
    keywords: '',
  });
  // Workbench chrome: the right-hand typography inspector, the collapsed
  // outline groups, and which sidebar panel is shown.
  const [isInspectorOpen, setIsInspectorOpen] = useState<boolean>(false);
  // The OS title bar is disabled (decorations: false), so the caption buttons are
  // drawn in the top bar. The maximize / restore glyph has to follow the REAL
  // window state, which changes on resize, double-click and Aero Snap alike.
  const [isWindowMaximized, setIsWindowMaximized] = useState<boolean>(false);
  // Surfaced in the top bar if a window command is refused (e.g. a missing
  // capability) so a dead control is never silent again.
  const [windowCmdNotice, setWindowCmdNotice] = useState<string | null>(null);
  const [collapsedOutline, setCollapsedOutline] = useState<Set<number>>(new Set());
  // External-modification conflicts are tracked PER TAB so that background
  // documents keep their conflict state until the user resolves it explicitly.
  const [fileConflicts, setFileConflicts] = useState<Record<string, FileConflict>>({});

  const lastSelfSaveTimeRef = useRef<number>(0);
  const lastHandledTimeRef = useRef<number>(0);
  const activeFileIdRef = useRef<string>(activeFileId);
  // Always-fresh mirror of openFiles for async callbacks (React state updaters
  // must stay pure: StrictMode may invoke them twice and discard results).
  const openFilesRef = useRef<FileTab[]>(openFiles);
  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  const clearFileConflict = useCallback((tabId: string) => {
    setFileConflicts((prev) => {
      if (!prev[tabId]) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  // Status notice banner inside modal
  const [modalFeedback, setModalFeedback] = useState<string | null>(null);

  // --- View & Sidebar States (Typora Complete Spec) ---
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    // The sidebar is a first-class part of the layout now: open unless the user
    // collapsed it last time.
    try {
      const raw = localStorage.getItem('markdownx_sidebar_open');
      return raw === null ? true : raw === 'true';
    } catch {
      return true;
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem('markdownx_sidebar_width'));
      return Number.isFinite(raw) && raw >= SIDEBAR_MIN_W && raw <= SIDEBAR_MAX_W ? raw : SIDEBAR_DEFAULT_W;
    } catch {
      return SIDEBAR_DEFAULT_W;
    }
  });

  useEffect(() => {
    try { localStorage.setItem('markdownx_sidebar_open', String(isSidebarOpen)); } catch { /* private mode */ }
  }, [isSidebarOpen]);

  useEffect(() => {
    try { localStorage.setItem('markdownx_sidebar_width', String(Math.round(sidebarWidth))); } catch { /* private mode */ }
  }, [sidebarWidth]);

  /**
   * Drag the splitter to resize the sidebar. The width is clamped, applied live and
   * remembered; `sb-resizing` on <body> suppresses the width transition and text
   * selection for the duration of the drag (otherwise the panel lags the cursor and
   * the drag selects text instead).
   */
  const beginSidebarDrag = useCallback((e: React.MouseEvent) => {
    if (!isSidebarOpen) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startWidth + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('sb-resizing');
    };
    document.body.classList.add('sb-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [isSidebarOpen, sidebarWidth]);
  /** Auto-update: the app checks, the user decides. Nothing installs on its own. */
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult>({ status: 'idle' });
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateInstallError, setUpdateInstallError] = useState<string | null>(null);

  const runUpdateCheck = useCallback(async (showDialog: boolean) => {
    setUpdateInfo({ status: 'checking' });
    const result = await checkForUpdate();
    setUpdateInfo(result);
    if (showDialog) setShowUpdateModal(true);
    return result;
  }, []);

  // Silent check a little after startup: never a popup, never in the reader's way.
  useEffect(() => {
    const timer = window.setTimeout(() => { void runUpdateCheck(false); }, 20000);
    return () => window.clearTimeout(timer);
  }, [runUpdateCheck]);

  const startUpdateInstall = useCallback(async () => {
    if (updateInfo.status !== 'available' || !updateInfo.update) return;
    setUpdateInstallError(null);
    const result = await installUpdate(updateInfo.update, setUpdateProgress);
    if (!result.ok) setUpdateInstallError(result.error);
  }, [updateInfo]);

  /** Right-click menus are model-driven: classify target → buildMenu() → render → dispatch. */
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: ContextTarget } | null>(null);
  /** The exact element right-clicked, for "open in source" offset resolution. */
  const ctxAnchorElementRef = useRef<HTMLElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  /** Clipboard with a fallback: navigator.clipboard is unavailable in some webviews. */
  const copyTextToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through to the legacy path */
    }
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.warn('Copy failed:', err);
    }
    helper.remove();
  }, []);

  /** Open a URL in the system browser (never navigate the webview itself). */
  const openExternalUrl = useCallback(async (url: string) => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch (e) {
      console.error('openExternalUrl failed:', e);
      setModalFeedback(`无法打开链接：${String(e)}`);
      window.setTimeout(() => setModalFeedback(null), 2500);
    }
  }, []);

  /** Reveal a local file in Windows Explorer. */
  const revealInFolder = useCallback(async (path: string) => {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(path);
    } catch (e) {
      console.error('revealInFolder failed:', e);
      setModalFeedback(`无法打开文件夹：${String(e)}`);
      window.setTimeout(() => setModalFeedback(null), 2500);
    }
  }, []);

  /**
   * Classify a right-click inside the rendered paper into a ContextTarget:
   * selection first, then the specific element hit (link/image/code/formula),
   * using the deterministic data-src anchors for source slices.
   */
  const classifyPreviewTarget = (e: React.MouseEvent): ContextTarget => {
    const el = e.target as HTMLElement;
    ctxAnchorElementRef.current = el;
    const sel = window.getSelection();
    const selectedText = sel && !sel.isCollapsed ? sel.toString() : undefined;

    const a = el.closest('a') as HTMLAnchorElement | null;
    const img = el.closest('img') as HTMLImageElement | null;
    const pre = el.closest('pre');
    const code = pre?.querySelector('code');
    const math = el.closest('.math-equation-row, mjx-container');

    let codeText: string | undefined;
    let codeLang: string | undefined;
    if (code) {
      codeText = code.textContent || undefined;
      // The renderer stamps `class="hljs language-xxx"` on the <code>.
      codeLang = /language-(\w+)/.exec(code.className)?.[1] || undefined;
      if (codeLang === 'plaintext') codeLang = undefined;
    }

    let latexSource: string | undefined;
    let imagePath: string | undefined;
    // Read through the refs, not `activeFile`: this classifier is declared before
    // that binding, and the refs always hold the freshest tab list.
    const source = openFilesRef.current.find((x) => x.id === activeFileIdRef.current)?.content || '';
    if (math) {
      const holder = (math as HTMLElement).closest('[data-src-start]') as HTMLElement | null;
      if (holder) {
        const s = Number(holder.getAttribute('data-src-start'));
        const en = Number(holder.getAttribute('data-src-end'));
        if (Number.isFinite(s) && Number.isFinite(en) && en > s) latexSource = source.slice(s, en);
      }
    }
    if (img) {
      const holder = img.closest('[data-src-start]') as HTMLElement | null;
      if (holder) {
        const s = Number(holder.getAttribute('data-src-start'));
        const en = Number(holder.getAttribute('data-src-end'));
        if (Number.isFinite(s) && Number.isFinite(en) && en > s) {
          const m = /!?\[[^\]]*\]\(([^)\s]+)/.exec(source.slice(s, en));
          if (m) imagePath = m[1];
        }
      }
      if (!imagePath) imagePath = img.getAttribute('src') || undefined;
    }

    return { surface: 'preview', selectedText, linkHref: a?.getAttribute('href') || undefined, imagePath, codeText, codeLang, latexSource };
  };

  /** The markdown source slice of the block that was right-clicked. */
  const blockSourceSlice = (ctx: ContextTarget): string => {
    const el = ctxAnchorElementRef.current;
    const source = openFilesRef.current.find((x) => x.id === activeFileIdRef.current)?.content || '';
    if (el) {
      const holder = el.closest('[data-src-start]') as HTMLElement | null;
      if (holder) {
        const s = Number(holder.getAttribute('data-src-start'));
        const en = Number(holder.getAttribute('data-src-end'));
        if (Number.isFinite(s) && Number.isFinite(en) && en > s) return source.slice(s, en);
      }
      // No anchor: fall back to the rendered text of the enclosing block.
      const block = el.closest('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, table');
      if (block?.textContent?.trim()) return block.textContent.trim();
    }
    return ctx.selectedText || '';
  };

  /** Zoom the PDF so one page fills the viewport width. */
  const fitPdfWidth = () => {
    const el = document.querySelector('.pdf-scroll') as HTMLElement | null;
    const wrap = document.querySelector('.pdf-page-wrap') as HTMLElement | null;
    if (!el || !wrap) { setPdfScale(1); return; }
    const avail = el.clientWidth - 48; // scroll padding (20px each side) + slack
    const atCurrent = wrap.getBoundingClientRect().width;
    if (atCurrent <= 0) return;
    setPdfScale(Math.min(4, Math.max(0.25, +(pdfScale * (avail / atCurrent)).toFixed(2))));
  };

  /** Single dispatch point for every context-menu action id. */
  const runContextAction = (id: string, ctx: ContextTarget) => {
    setContextMenu(null);
    const activeId = ctx.fileId || activeFileIdRef.current;
    switch (id) {
      // ---- shared ----
      case 'copy-selection':
        void copyTextToClipboard(ctx.selectedText || '');
        return;
      // ---- tab ----
      case 'tab-close':
        handleCloseFile(activeId);
        return;
      case 'tab-close-others':
        openFilesRef.current.filter((x) => x.id !== activeId).forEach((x) => handleCloseFile(x.id));
        return;
      case 'tab-copy-path':
        void copyTextToClipboard(ctx.path || '');
        return;
      case 'tab-reveal':
        if (ctx.path) void revealInFolder(ctx.path);
        return;
      // ---- sidebar file/doc ----
      case 'file-open':
        if (ctx.path) void openFileByPath(ctx.path);
        return;
      case 'file-copy-path':
        void copyTextToClipboard(ctx.path || '');
        return;
      case 'file-reveal':
        if (ctx.path) void revealInFolder(ctx.path);
        return;
      // ---- preview ----
      case 'link-open':
        if (ctx.linkHref) void openExternalUrl(ctx.linkHref);
        return;
      case 'link-copy':
        void copyTextToClipboard(ctx.linkHref || '');
        return;
      case 'img-copy-path':
        void copyTextToClipboard(ctx.imagePath || '');
        return;
      case 'img-reveal':
        if (ctx.imagePath) void revealInFolder(ctx.imagePath);
        return;
      case 'code-copy':
        void copyTextToClipboard(ctx.codeText || '');
        return;
      case 'math-copy-latex':
        void copyTextToClipboard(ctx.latexSource || '');
        return;
      case 'copy-block-md':
        void copyTextToClipboard(blockSourceSlice(ctx));
        return;
      case 'open-in-source': {
        const el = ctxAnchorElementRef.current;
        const f = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
        const offset = el && f
          ? sourceOffsetForElement(el, f.content, previewRef.current)
          : null;
        enterSourceMode(offset);
        return;
      }
      case 'print':
        handlePrint();
        return;
      case 'export-html':
        void handleExportHtmlWithStyles();
        return;
      case 'toggle-view':
        toggleSourceMode();
        return;
      // ---- pdf ----
      case 'pdf-rotate':
        void applyPdfStructuralOp(async (b) => (await import('./pdf/structuralOps')).rotatePage(b, ctx.pageIndex ?? 0, 90));
        return;
      case 'pdf-insert-after':
        void applyPdfStructuralOp(async (b) => (await import('./pdf/structuralOps')).insertBlankPage(b, ctx.pageIndex ?? 0));
        return;
      case 'pdf-extract':
        void handleExtractPdfPage(ctx.pageIndex ?? 0);
        return;
      case 'pdf-delete-page':
        void applyPdfStructuralOp(async (b) => (await import('./pdf/structuralOps')).deletePages(b, [ctx.pageIndex ?? 0]));
        return;
      case 'pdf-mark-highlight':
        armOrApplyPdfTool('highlight');
        return;
      case 'pdf-mark-underline':
        armOrApplyPdfTool('underline');
        return;
      case 'pdf-mark-strikeout':
        armOrApplyPdfTool('strikeout');
        return;
      case 'pdf-tool-note':
        armOrApplyPdfTool('note');
        return;
      case 'pdf-tool-ink':
        armOrApplyPdfTool('ink');
        return;
      case 'pdf-tool-eraser':
        armOrApplyPdfTool('delete');
        return;
      case 'pdf-print':
        handlePrint();
        return;
      case 'pdf-zoom-fit':
        fitPdfWidth();
        return;
      case 'pdf-zoom-actual':
        setPdfScale(1);
        return;
      case 'annot-delete': {
        const target = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
        if (ctx.annotId && target) {
          updateActivePdfAnnots((target.pdfAnnots ?? []).filter((a) => a.id !== ctx.annotId));
        }
        return;
      }
      case 'annot-copy-text':
        void copyTextToClipboard(ctx.annotText || '');
        return;
      default:
        console.warn('unhandled context action:', id);
    }
  };

  /** Open the model-driven menu for a classified target at (x, y). */
  const openContextMenu = (x: number, y: number, target: ContextTarget) => {
    const pos = clampMenuPosition(x, y, 230, 300, window.innerWidth, window.innerHeight);
    setContextMenu({ ...pos, target });
  };

  /**
   * The model-driven menu's real height depends on how many items it got, so the
   * first clamp (based on an estimate) can still leave it hanging off-screen. After
   * it is laid out, measure it and pull it back inside the viewport. Converges: once
   * the position fits, the condition is false and no further state write happens.
   */
  useLayoutEffect(() => {
    const el = ctxMenuRef.current;
    if (!el || !contextMenu) return;
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    if (contextMenu.x > maxX || contextMenu.y > maxY) {
      setContextMenu((c) =>
        c ? { ...c, x: Math.max(8, Math.min(c.x, maxX)), y: Math.max(8, Math.min(c.y, maxY)) } : c
      );
    }
  }, [contextMenu]);

  /** Right-click on a not-yet-open file (workspace tree / recent list). */
  const openSidebarFileMenu = (x: number, y: number, path: string) => {
    ctxAnchorElementRef.current = null;
    openContextMenu(x, y, { surface: 'sidebar-file', path });
  };

  const [sidebarPanel, setSidebarPanel] = useState<'workspace' | 'search'>('workspace');
  const [outlineRegionOpen, setOutlineRegionOpen] = useState<boolean>(true);
  const [isFocusMode, setIsFocusMode] = useState<boolean>(false);
  const [isTypewriterMode, setIsTypewriterMode] = useState<boolean>(false);
  const [showStatusBar, setShowStatusBar] = useState<boolean>(true);
  const [showWordCountModal, setShowWordCountModal] = useState<boolean>(false);
  const [showHelpModal, setShowHelpModal] = useState<boolean>(false);
  const [showMathHelpModal, setShowMathHelpModal] = useState<boolean>(false);
  const [showAboutModal, setShowAboutModal] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState<boolean>(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);

  // File tree / workspace directory
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [dirChildrenCache, setDirChildrenCache] = useState<Record<string, FileEntry[]>>({});
  const dirChildrenCacheRef = useRef<Record<string, FileEntry[]>>({});

  // Toggle directory expansion and asynchronously load n-level subdirectories
  const handleToggleDirectory = useCallback(async (dirPath: string) => {
    setExpandedDirs((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }));

    // I/O stays OUTSIDE the state updater: read the cache through its ref mirror
    if (dirChildrenCacheRef.current[dirPath]) return;
    try {
      const children = await invoke<FileEntry[]>('read_dir_files', { dirPath });
      dirChildrenCacheRef.current = { ...dirChildrenCacheRef.current, [dirPath]: children };
      setDirChildrenCache((c) => ({ ...c, [dirPath]: children }));
    } catch (err) {
      console.error('Failed to read subdirectory:', dirPath, err);
    }
  }, []);

  // Search & Replace state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [replaceQuery, setReplaceQuery] = useState<string>('');
  const [searchMatchesCount, setSearchMatchesCount] = useState<number>(0);
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The resolved theme drives the body class (all body.theme-* rules hang off it).
  useEffect(() => {
    document.body.className = `theme-${appTheme}`;
  }, [appTheme]);

  useEffect(() => {
    if (!windowCmdNotice) return;
    const t = window.setTimeout(() => setWindowCmdNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [windowCmdNotice]);

  // Preference -> resolved theme. Under 'auto' this follows the OS now and keeps
  // following it while the app is open (media-query listener).
  useEffect(() => {
    const apply = () => setAppTheme(resolveTheme(themePref));
    apply();
    // 'auto' must react while the app is open, not only at start-up.
    let mq: MediaQueryList | null = null;
    const onChange = () => apply();
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else mq.addListener(onChange);
    } catch {}
    return () => {
      try {
        if (mq) {
          if (mq.removeEventListener) mq.removeEventListener('change', onChange);
          else mq.removeListener(onChange);
        }
      } catch {}
    };
  }, [themePref]);

  // Global code block copy callback
  useEffect(() => {
    (window as any).__copyCodeBlock = (btn: HTMLButtonElement) => {
      const text = decodeURIComponent(btn.getAttribute('data-code') || '');
      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.innerText;
        btn.innerText = '已复制 ✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerText = originalText;
          btn.classList.remove('copied');
        }, 1800);
      });
    };
  }, []);

  // Detailed Typography Configuration
  const [typography, setTypography] = useState<TypographyConfig>(() => {
    return initialPrefs.current.defaultTypography || DEFAULT_TYPOGRAPHY;
  });

  // Font families installed on this machine. Loaded once from the OS registry
  // (Rust `list_system_fonts`). Empty until resolved, so the module-scope
  // fallback lists keep the font dropdowns populated meanwhile.
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>('list_system_fonts')
      .then((fonts) => {
        if (!cancelled && Array.isArray(fonts) && fonts.length) setSystemFonts(fonts);
      })
      .catch(() => {
        if (!cancelled) setSystemFonts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Split the loaded families into Latin and CJK buckets, falling back to the
  // curated lists when `list_system_fonts` couldn't run.
  const latinFamilies = useMemo(
    () => (systemFonts.length ? systemFonts.filter((f) => !isCJKFamily(f)) : FALLBACK_LATIN_FAMILIES),
    [systemFonts]
  );
  const cjkFamilies = useMemo(
    () => (systemFonts.length ? systemFonts.filter(isCJKFamily) : FALLBACK_CJK_FAMILIES),
    [systemFonts]
  );
  const latinOptions = useMemo(
    () => latinFamilies.map((f) => ({ value: f, label: f })),
    [latinFamilies]
  );
  const cjkOptions = useMemo(
    () => cjkFamilies.map((f) => ({ value: f, label: f })),
    [cjkFamilies]
  );

  const [showTypographyModal, setShowTypographyModal] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Apply typography variables to document root
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--font-serif-active', `${typography.latinFont}, ${typography.cjkFont}, serif`);
    root.style.setProperty('--doc-font-size', `${typography.fontSize}px`);
    root.style.setProperty('--doc-line-height', String(typography.lineHeight));
    root.style.setProperty('--doc-p-margin', `${typography.paragraphMargin}em`);
    root.style.setProperty('--doc-text-align', typography.textAlign);
    root.style.setProperty('--doc-text-indent', typography.firstLineIndent ? '2em' : '0');
    root.style.setProperty('--doc-max-width', typography.maxWidth);

    localStorage.setItem('preferred_typography_v3', JSON.stringify(typography));
  }, [typography]);

  const [renderedHtml, setRenderedHtml] = useState<string>('');
  const previewRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  // The Markdown that `renderedHtml` was produced from. Rendering is async, so
  // a position restore must wait until this matches the current document.
  const renderedForContentRef = useRef<string | null>(null);
  /** Content of the newest render request; guards against out-of-order completion. */
  const latestRenderRef = useRef<string | null>(null);

  const activeFile = openFiles.find((f) => f.id === activeFileId) || openFiles[0];

  // Banner for the active tab only: conflicts of background tabs stay stored
  // in fileConflicts and appear as soon as that tab becomes active again.
  const conflictBanner = fileConflicts[activeFileId] || null;

  const getBasePath = (fullPath: string | null): string => {
    if (!fullPath) return '';
    const index = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
    return index !== -1 ? fullPath.substring(0, index) : '';
  };

  const updatePreview = useCallback(async (content: string, currentPath: string | null) => {
    try {
      const basePath = getBasePath(currentPath);
      // Large documents are parsed in a Worker so the window stays responsive.
      // Anything the Worker cannot do (missing, failed to load, threw, timed out) is
      // handled inside renderDocument, which degrades to this very main-thread parse -
      // a document can therefore never fail to render because of the Worker.
      latestRenderRef.current = content;
      const { html } = await renderDocument(content, basePath);
      // Worker latency makes out-of-order completion possible: commit only the newest.
      if (latestRenderRef.current !== content) return;
      renderedForContentRef.current = content;
      setRenderedHtml(html);
    } catch (error) {
      console.error('Markdown rendering error:', error);
      setRenderedHtml(`<div style="color: #ef4444; padding: 20px;">Rendering Error: ${String(error)}</div>`);
    }
  }, []);

  // Update preview on tab change
  useEffect(() => {
    if (activeFile) {
      updatePreview(activeFile.content, activeFile.path);
    }
  }, [activeFile?.id, activeFile?.path, updatePreview]);

  // 300ms debounce when typing in source mode
  const handleContentChange = (newContent: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.id === activeFileId ? { ...f, content: newContent, isModified: true } : f))
    );

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      updatePreview(newContent, activeFile?.path || null);
    }, 300);
  };

  // Right-click policy. WebView2 (the Chromium engine under the app) shows its
  // own browser context menu - 返回/刷新/另存为/打印/检查 - on right-click
  // ANYWHERE by default. That menu is out of place in a desktop editor, and its
  // 刷新 entry would reload the whole app and risk unsaved edits, so it is
  // suppressed across the UI. The one exception is real editable fields, where
  // the native 剪切/复制/粘贴 (and spellcheck) menu is genuinely useful.
  // Also auto-cleans any corrupted MathJax menu state from earlier versions.
  useEffect(() => {
    try {
      localStorage.removeItem('mjx.menu');
      localStorage.removeItem('MathJax-Menu-Settings');
    } catch {}

    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const editable = target && target.closest('textarea, input, [contenteditable="true"]');
      if (editable) return; // real text fields keep the native 剪切/复制/粘贴 menu
      // Our own right-click surfaces (document tabs, the paper) render a custom menu.
      // They still need the native one suppressed, but the event must reach React, so
      // stopPropagation is skipped for them - otherwise the capture-phase handler here
      // swallows the event before any React onContextMenu can run.
      const customMenuSurface = target && target.closest('.doc-tab, .typora-paper-article, .pdf-page-wrap, .file-tree-item, .sidebar-doc-item, [data-ctx-menu]');
      e.preventDefault();
      if (!customMenuSurface) e.stopPropagation();
    };

    window.addEventListener('contextmenu', handleContextMenu, true);
    return () => window.removeEventListener('contextmenu', handleContextMenu, true);
  }, []);

  // Typeset MathJax whenever rendered HTML updates
  useEffect(() => {
    if (previewRef.current && !isSourceMode) {
      triggerMathJax(previewRef.current);
    }
  }, [renderedHtml, isSourceMode]);

  // Draw ```mermaid diagrams whenever the preview HTML is rebuilt.
  useEffect(() => {
    if (previewRef.current && !isSourceMode) {
      renderMermaidDiagrams(previewRef.current, appTheme);
    }
  }, [renderedHtml, isSourceMode, appTheme]);

  // Apply a position handed over from the preview (double-click, mode toggle).
  // The textarea already exists because the source view was just opened.
  useEffect(() => {
    if (!isSourceMode) return;
    const offset = pendingSourceCaretRef.current;
    if (offset === null) return;
    const ta = textareaRef.current;
    if (!ta) return;
    pendingSourceCaretRef.current = null;
    const pos = Math.max(0, Math.min(offset, ta.value.length));
    // Defer one frame so the textarea has been laid out and can scroll.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
      const style = window.getComputedStyle(ta);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      // Real measured caret geometry, so wrapped paragraphs cannot shift the
      // highlight onto a neighbouring line.
      const caret = measureTextareaCaret(ta, pos);
      // Place the target roughly one third down the viewport, independently of
      // any scroll offset the textarea already had.
      ta.scrollTop = Math.max(0, caret.top - ta.clientHeight / 3);

      // A caret alone is nearly invisible in a wall of text; flash the line it
      // landed on, plus a tick under the exact column.
      const pane = ta.parentElement;
      if (pane) {
        const paneTop = ta.offsetTop;
        flashAnchorRef.current = { paneTop, contentTop: caret.top };
        setCaretFlash({
          top: paneTop + caret.top - ta.scrollTop,
          left: ta.offsetLeft + paddingLeft,
          width: Math.max(0, ta.clientWidth - paddingLeft - paddingRight),
          height: caret.height,
          tickLeft: ta.offsetLeft + caret.caretLeft
        });
      }
    });
  }, [isSourceMode]);

  // The flash is transient: fade it out on its own, and clear it the moment the
  // writer interacts with the text, so it never lingers as visual noise.
  useEffect(() => {
    if (!caretFlash) return;
    const timer = window.setTimeout(() => setCaretFlash(null), 2500);
    return () => window.clearTimeout(timer);
  }, [caretFlash]);

  // While the landing highlight is alive it must stay glued to its line: track
  // the textarea's own scrolling and re-anchor.
  useEffect(() => {
    if (!caretFlash) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const sync = () => {
      const anchor = flashAnchorRef.current;
      if (!anchor) return;
      setCaretFlash((prev) => (prev ? { ...prev, top: anchor.paneTop + anchor.contentTop - ta.scrollTop } : prev));
    };
    ta.addEventListener('scroll', sync, { passive: true });
    return () => ta.removeEventListener('scroll', sync);
  }, [caretFlash]);

  // Returning from the source view: scroll the preview back to the block that
  // holds the caret, so editing never throws the reader to the top.
  useEffect(() => {
    if (isSourceMode) return;
    const pending = pendingPreviewScrollRef.current;
    if (!pending) return;
    // Hold the request until the preview shows this exact revision; otherwise
    // the measurement would run against stale HTML and land in the wrong place.
    if (renderedForContentRef.current !== pending.content) return;
    if (pending.tabId !== activeFileIdRef.current) return;
    pendingPreviewScrollRef.current = null;
    const offset = pending.offset;

    const article = previewRef.current;
    const scroller = article?.closest('.typora-document-scroll') as HTMLElement | null;
    const source = activeFile?.content || '';
    if (!article || !scroller || !source) return;

    const target = blockForSourceOffset(article, source, offset);
    if (!target) return;

    // Absolute geometry via rects: offsetTop is unreliable because neither
    // .typora-document-scroll nor .typora-paper-article is positioned.
    const reveal = () => {
      const delta = target!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 24);
    };
    requestAnimationFrame(reveal);
    // Re-apply once the async typesetters have reflowed the article.
    const settle = window.setTimeout(reveal, 350);
    // Mark the block the caret came back to, so the return landing is as
    // findable as the jump into the source view.
    target.classList.add('jump-target-flash');
    const clearFlash = window.setTimeout(() => target.classList.remove('jump-target-flash'), 2500);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(clearFlash);
      target.classList.remove('jump-target-flash');
    };
  }, [isSourceMode, renderedHtml]);

  // Production build fix: listen for mathjax-ready event when MathJax finishes async loading
  useEffect(() => {
    const handleMathJaxReady = () => {
      if (previewRef.current && !isSourceMode) {
        triggerMathJax(previewRef.current);
      }
    };
    window.addEventListener('mathjax-ready', handleMathJaxReady);
    if ((window as any).__MATHJAX_READY__) {
      handleMathJaxReady();
    }
    return () => window.removeEventListener('mathjax-ready', handleMathJaxReady);
  }, [isSourceMode]);

// --- Outline Extraction (TOC) ---
  const outlineList = useMemo<OutlineItem[]>(() => {
    if (!activeFile?.content) return [];
    const items: OutlineItem[] = [];
    const lines = activeFile.content.split('\n');
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        inCode = !inCode;
        continue;
      }
      if (inCode) continue;
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        const level = m[1].length;
        const title = m[2].trim().replace(/[*_`#]/g, '');
        const slug = encodeURIComponent(title.toLowerCase().replace(/\s+/g, '-'));
        items.push({ level, title, line: i, slug });
      }
    }
    return items;
  }, [activeFile?.content]);

  // Handle clicking outline item
  const handleOutlineClick = (item: OutlineItem) => {
    if (isSourceMode) {
      const ta = textareaRef.current;
      if (!ta) return;
      const lines = (activeFile?.content || '').split('\n');
      let charIndex = 0;
      for (let i = 0; i < item.line && i < lines.length; i++) {
        charIndex += lines[i].length + 1;
      }
      const pos = Math.max(0, Math.min(charIndex, ta.value.length));
      // Land the caret at the very START of the heading line and select nothing:
      // the jump must not paint the whole title as selected, and the author must
      // be able to edit the '#' prefix right away (so the marker is NOT skipped).
      const caretAt = pos;
      ta.focus();
      ta.setSelectionRange(caretAt, caretAt);
      // A fixed line height cannot address the target: wrapped lines make the
      // real pixel offset diverge from `line * lineHeight`. Measure the caret
      // geometry instead (same machinery as the preview double-click landing).
      requestAnimationFrame(() => {
        const caret = measureTextareaCaret(ta, caretAt);
        ta.scrollTop = Math.max(0, caret.top - ta.clientHeight / 3);
        const pane = ta.parentElement;
        if (pane) {
          const style = window.getComputedStyle(ta);
          const paddingLeft = parseFloat(style.paddingLeft) || 0;
          const paddingRight = parseFloat(style.paddingRight) || 0;
          const paneTop = ta.offsetTop;
          flashAnchorRef.current = { paneTop, contentTop: caret.top };
          setCaretFlash({
            top: paneTop + caret.top - ta.scrollTop,
            left: ta.offsetLeft + paddingLeft,
            width: Math.max(0, ta.clientWidth - paddingLeft - paddingRight),
            height: caret.height,
            tickLeft: ta.offsetLeft + caret.caretLeft
          });
        }
      });
    } else {
      const el = document.getElementById(`heading-${item.slug}`) ||
                 Array.from(document.querySelectorAll(`h${item.level}`)).find(h => (h.textContent || '').includes(item.title));
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  };

  // Load workspace files when activeFile changes or directory is selected
  const loadWorkspaceFiles = useCallback(async (dirPath: string) => {
    try {
      const entries = await invoke<FileEntry[]>('read_dir_files', { dirPath });
      setWorkspaceFiles(entries);
      setWorkspaceDir(dirPath);
      setExpandedDirs({ [dirPath]: true });
      dirChildrenCacheRef.current = { [dirPath]: entries };
      setDirChildrenCache({ [dirPath]: entries });
    } catch {
      setWorkspaceFiles([]);
    }
  }, []);

  const handleSelectWorkspace = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === 'string') {
        await loadWorkspaceFiles(selected);
        setIsSidebarOpen(true);
        setSidebarPanel('workspace');
      }
    } catch (e) {
      console.error('Select workspace error:', e);
    }
  };

  // Cycle open document tabs (Ctrl+Tab)
  const handleCycleTab = useCallback(() => {
    if (openFiles.length <= 1) return;
    const currentIndex = openFiles.findIndex((f) => f.id === activeFileId);
    const nextIndex = (currentIndex + 1) % openFiles.length;
    setActiveFileId(openFiles[nextIndex].id);
  }, [openFiles, activeFileId]);

  /**
   * Edit-menu commands. Clicking a dropdown item blurs the source textarea, so
   * the command must re-focus the editor first - otherwise undo/redo/copy/paste
   * act on a stale page selection (or on nothing) instead of the text being
   * edited. Falls back to the plain command in preview mode, where there is no
   * editable textarea.
   */
  const runEditorCommand = (command: 'undo' | 'redo' | 'copy' | 'paste' | 'cut') => {
    const ta = textareaRef.current;
    if (ta) ta.focus();
    try {
      document.execCommand(command);
    } catch {
      /* the webview may refuse paste without clipboard permission */
    }
    setActiveMenu(null);
  };

  /** One-tap search: open the sidebar and switch its tree region to search. */
  const openSearchPanel = () => {
    setIsSidebarOpen(true);
    setSidebarPanel('search');
    setActiveMenu(null);
  };

  /** Theme cycle: auto -> light -> dark -> sepia -> auto. */
  const cycleTheme = () =>
    setThemePref((t) => THEME_CYCLE[(THEME_CYCLE.indexOf(t) + 1) % THEME_CYCLE.length]);

  const themeIconName = (): 'monitor' | 'sun' | 'moon' | 'book' => {
    if (themePref === 'auto') return 'monitor';
    return appTheme === 'dark' ? 'moon' : (appTheme === 'sepia' ? 'book' : 'sun');
  };

  /** Outline items with the subtree of every collapsed heading filtered out. */
  // Outline rows: a node's caret must not depend on its own collapsed state, so
  // hasChild is computed from the FULL outline list. Descendants of a collapsed
  // node are skipped while walking the pre-order list.
  const outlineRows = useMemo(() => {
    const rows: (OutlineItem & { hasChild: boolean; collapsed: boolean })[] = [];
    let hideDeeperThan: number | null = null;
    for (let i = 0; i < outlineList.length; i++) {
      const it = outlineList[i];
      if (hideDeeperThan !== null && it.level > hideDeeperThan) continue;
      hideDeeperThan = null;
      const hasChild = i + 1 < outlineList.length && outlineList[i + 1].level > it.level;
      const collapsed = collapsedOutline.has(it.line);
      rows.push({ ...it, hasChild, collapsed });
      if (hasChild && collapsed) hideDeeperThan = it.level;
    }
    return rows;
  }, [outlineList, collapsedOutline]);

  const toggleOutlineNode = useCallback((line: number) => {
    setCollapsedOutline((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }, []); 
  // Window controls
  const handleToggleFullscreen = async () => {
    try {
      const nextState = await invoke<boolean>('toggle_fullscreen');
      setIsFullscreen(nextState);
    } catch {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
        setIsFullscreen(true);
      } else {
        document.exitFullscreen().catch(() => {});
        setIsFullscreen(false);
      }
    }
  };

  const handleToggleAlwaysOnTop = async () => {
    const next = !isAlwaysOnTop;
    try {
      await invoke('toggle_always_on_top', { enable: next });
      setIsAlwaysOnTop(next);
    } catch {
      setIsAlwaysOnTop(next);
    }
  };

  /** Enter the source view with the caret at the position double-clicked. */
  const handlePreviewDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const source = activeFile?.content || '';
    const target = event.target as HTMLElement;
    const offset = target
      ? sourceOffsetForElement(target, source, previewRef.current, { x: event.clientX, y: event.clientY })
      : null;
    pendingSourceCaretRef.current = offset;
    setIsSourceMode(true);
  };

  /**
   * Source offset of the first preview block at or below the fold, i.e. what
   * the reader is currently looking at. Used when the view is switched from the
   * keyboard or the menu, where there is no clicked element to resolve.
   */
  const previewTopSourceOffset = (): number | null => {
    const article = previewRef.current;
    const scroller = article?.closest('.typora-document-scroll') as HTMLElement | null;
    const source = activeFile?.content || '';
    if (!article || !scroller || !source.trim()) return null;

    const index = getSourceIndex(source);
    const foldTop = scroller.getBoundingClientRect().top + 8;
    let cursor = 0;
    for (const el of Array.from(article.children) as HTMLElement[]) {
      const anchor = firstAnchorIn(el);
      let at: number | null = anchor ? anchor.start : null;
      if (at === null) {
        const probe = probeTextOf(el);
        if (!probe.trim()) continue;
        at = locateRenderedText(index, probe, cursor);
        if (at === null) continue;
      }
      cursor = Math.max(cursor, at); // every located block advances the search
      if (el.getBoundingClientRect().bottom >= foldTop) return at;
    }
    return null;
  };

  /** Open the source view, landing at `offset` or wherever the reader is. */
  const enterSourceMode = (offset?: number | null) => {
    pendingSourceCaretRef.current = offset !== undefined ? offset : previewTopSourceOffset();
    setIsSourceMode(true);
  };

  /** Switch views, carrying the reading position across in either direction. */
  const toggleSourceMode = () => {
    if (isSourceMode) {
      const ta = textareaRef.current;
      pendingPreviewScrollRef.current = ta
        ? { tabId: activeFileId, content: activeFile?.content || '', offset: ta.selectionStart }
        : null;
      // Flush the pending debounce: the restore effect measures the preview
      // against activeFile.content, so the two must not be out of step.
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (activeFile) {
        updatePreview(activeFile.content, activeFile.path);
      }
      setIsSourceMode(false);
    } else {
      enterSourceMode();
    }
  };

  const handleOpenDevTools = async () => {
    try {
      await invoke('open_devtools');
    } catch {
      alert('已发送开发者工具唤起指令。');
    }
  };

  // Word count metrics computation
  const metrics = useMemo(() => {
    const content = activeFile?.content || '';
    const cjkMatches = content.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || [];
    const cjkCount = cjkMatches.length;
    const cleanForWords = content.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ');
    const wordMatches = cleanForWords.match(/\b[A-Za-z0-9_-]+\b/g) || [];
    const wordsCount = wordMatches.length;
    const charWithSpaces = content.length;
    const charNoSpaces = content.replace(/\s/g, '').length;
    const lines = content === '' ? 0 : content.split('\n').length;
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
    const readingMinutes = Math.max(1, Math.ceil((cjkCount / 350) + (wordsCount / 200)));
    return {
      cjkCount,
      wordsCount,
      charWithSpaces,
      charNoSpaces,
      lines,
      paragraphs,
      readingMinutes
    };
  }, [activeFile?.content]);

  // Search & Replace handlers
  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!query || !activeFile?.content) {
      setSearchMatchesCount(0);
      setCurrentMatchIndex(0);
      return;
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const matches = activeFile.content.match(regex);
    setSearchMatchesCount(matches ? matches.length : 0);
    setCurrentMatchIndex(0);
  };

  const handleNavigateMatch = (delta: number) => {
    if (searchMatchesCount <= 0) return;
    const nextIdx = (currentMatchIndex + delta + searchMatchesCount) % searchMatchesCount;
    setCurrentMatchIndex(nextIdx);
  };

  const handleReplaceOne = () => {
    if (!searchQuery || !activeFile?.content) return;
    const idx = activeFile.content.indexOf(searchQuery);
    if (idx !== -1) {
      const newContent = activeFile.content.substring(0, idx) + replaceQuery + activeFile.content.substring(idx + searchQuery.length);
      handleContentChange(newContent);
      handleSearch(searchQuery);
    }
  };

  const handleReplaceAll = () => {
    if (!searchQuery || !activeFile?.content) return;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const newContent = activeFile.content.replace(new RegExp(escaped, 'g'), replaceQuery);
    handleContentChange(newContent);
    handleSearch(searchQuery);
  };

    // Global click to close menus
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.menu-item-wrap') && !target.closest('.file-select-dropdown') && !target.closest('.wb-menu-host')) {
        setActiveMenu(null);
      }
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  // Keyboard shortcuts (Comprehensive Typora & MarkdownX Keybindings)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Markdown-only shortcuts must not fire while a PDF tab is active.
      const pdfTabActive =
        openFilesRef.current.find((f) => f.id === activeFileIdRef.current)?.kind === 'pdf';
      // Function keys
      if (e.key === 'F8') {
        e.preventDefault();
        setIsFocusMode((prev) => !prev);
        return;
      } else if (e.key === 'F9') {
        e.preventDefault();
        setIsTypewriterMode((prev) => !prev);
        return;
      } else if (e.key === 'F11') {
        e.preventDefault();
        handleToggleFullscreen();
        return;
      } else if (e.shiftKey && e.key === 'F12') {
        e.preventDefault();
        handleOpenDevTools();
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'Tab') {
          e.preventDefault();
          handleCycleTab();
          return;
        }

        // Shift combinations
        if (e.shiftKey) {
          if (e.key === 'L' || e.key === 'l') {
            e.preventDefault();
            setIsSidebarOpen((prev) => !prev);
            return;
          } else if (e.key === '1' || e.key === '!') {
            e.preventDefault();
            // outline lives inside the workspace panel
            setIsSidebarOpen(true);
            setSidebarPanel('workspace');
            setOutlineRegionOpen(true);
            return;
          } else if (e.key === '2' || e.key === '@') {
            e.preventDefault();
            // The panel now serves both: typography for Markdown, PDF ops for a PDF.
            setIsInspectorOpen((v) => !v);
            return;
          } else if (e.key === 'F' || e.key === 'f') {
            e.preventDefault();
            setIsSidebarOpen(true);
            setSidebarPanel('search');
            return;
          } else if (e.key === '9' || e.key === '(') {
            e.preventDefault();
            setZoomLevel(1.0);
            return;
          } else if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            setZoomLevel((z) => Math.min(2.0, Number((z + 0.1).toFixed(1))));
            return;
          } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            setZoomLevel((z) => Math.max(0.6, Number((z - 0.1).toFixed(1))));
            return;
          } else if (e.key === 's' || e.key === 'S') {
            e.preventDefault();
            handleSaveFileAs();
            return;
          }
        }

        // Standard Ctrl combinations
        if (e.key === '/') {
          e.preventDefault();
          if (!pdfTabActive) toggleSourceMode();
        } else if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          handleSaveFile();
        } else if (e.key === 'o' || e.key === 'O') {
          e.preventDefault();
          handleOpenFile();
        } else if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          handleNewFile();
        } else if (e.key === 'p' || e.key === 'P') {
          e.preventDefault();
          // handlePrint routes a PDF to its own true-page-size print path.
          handlePrint();
        } else if (e.key === ',' || e.key === '，') {
          e.preventDefault();
          setShowTypographyModal(true);
        } else if (e.key === 'w' || e.key === 'W') {
          e.preventDefault();
          handleCloseFile(activeFileId);
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          if (!pdfTabActive) setTypography((t) => ({ ...t, fontSize: Math.min(t.fontSize + 1, 26) }));
        } else if (e.key === '-') {
          e.preventDefault();
          if (!pdfTabActive) setTypography((t) => ({ ...t, fontSize: Math.max(t.fontSize - 1, 12) }));
        } else if (e.key === '0') {
          e.preventDefault();
          if (!pdfTabActive) setTypography((t) => ({ ...t, fontSize: 16 }));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const handleNewFile = () => {
    setActiveMenu(null);
    const newId = `file-${Date.now()}`;
    const newTab: FileTab = {
      id: newId,
      name: `未命名文档-${openFiles.length + 1}.md`,
      path: null,
      content: '# 新建文档\n\n在此开始输入内容...',
      isModified: false
    };
    setOpenFiles((prev) => [...prev, newTab]);
    setActiveFileId(newId);
  };

  // Helper to open a file by path (supports CLI launch, file association double-click, and dialog)
  const openFileByPath = useCallback(async (targetPath: string) => {
    try {
      // Read through the ref mirror instead of mutating state inside an updater
      const existing = openFilesRef.current.find((f) => f.path === targetPath);
      if (existing) {
        setActiveFileId(existing.id);
        return;
      }

      // --- PDF branch: bytes go through plugin-fs, never the text command ---
      if (isPdfPath(targetPath)) {
        try {
          const bytes = await loadPdfBytes(targetPath);
          const { readAnnotsFromPdf } = await import('./pdf/annotStore');
          const savedAnnots = await readAnnotsFromPdf(bytes);
          const pdfName = targetPath.split(/[\\/]/).pop() || 'document.pdf';
          const pdfId = `pdf-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
          const pdfTab: FileTab = {
            id: pdfId,
            name: pdfName,
            path: targetPath,
            content: '',
            isModified: false,
            kind: 'pdf',
            pdfBytes: bytes,
            pdfAnnots: savedAnnots,
          };
          const tabsBefore = openFilesRef.current;
          const pdfNext =
            tabsBefore.length === 1 && tabsBefore[0].id === 'default-tab' && !tabsBefore[0].path && tabsBefore[0].content === ''
              ? [pdfTab]
              : [...tabsBefore, pdfTab];
          openFilesRef.current = pdfNext;
          setOpenFiles(pdfNext);
          setActiveFileId(pdfId);
          setRecentFiles((prev) => [
            { name: pdfName, path: targetPath },
            ...prev.filter((item) => item.path !== targetPath),
          ].slice(0, 10));
        } catch (pdfErr) {
          console.error('PDF open error:', pdfErr);
          setPdfOpenError(`无法打开 PDF「${targetPath.split(/[\\/]/).pop() || targetPath}」：${String((pdfErr as Error)?.message || pdfErr)}`);
        }
        return;
      }
      // --- end PDF branch ---

      let fileContent = '';
      try {
        fileContent = await invoke<string>('read_file_from_path', { path: targetPath });
      } catch {
        fileContent = await readTextFile(targetPath);
      }

      const fileName = targetPath.split(/[\/]/).pop() || 'document.md';
      const newId = `file-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const newTab: FileTab = {
        id: newId,
        name: fileName,
        path: targetPath,
        content: fileContent,
        isModified: false
      };

      // Compose the next tab list outside of any updater, then write state.
      const currentTabs = openFilesRef.current;
      const nextTabs =
        currentTabs.length === 1 && currentTabs[0].id === 'default-tab' && !currentTabs[0].path && currentTabs[0].content === ''
          ? [newTab]
          : [...currentTabs, newTab];
      openFilesRef.current = nextTabs; // keep the mirror fresh for sequential opens
      setOpenFiles(nextTabs);
      setActiveFileId(newTab.id);

      setRecentFiles((prev) => [
        { name: fileName, path: targetPath },
        ...prev.filter((item) => item.path !== targetPath)
      ].slice(0, 10));
    } catch (error) {
      console.error('File open error:', error);
    }
  }, []);

  /**
   * A CLI argument is only worth opening if it looks like a document path.
   * The single-instance plugin hands the caller's FULL command line to the Rust
   * side, argv[0] (the executable) included; forwarding that verbatim made the app
   * "open" its own binary as a ~13 MB document, which then froze the UI. The Rust
   * side now drops the program name too - this is the second line of defence, so a
   * future argument source cannot reintroduce it.
   */
  const isOpenableDocumentArg = (arg: string): boolean =>
    !!arg &&
    !arg.startsWith('-') &&
    !/\.(exe|dll|msi|sys|bat|cmd|com|scr|zip|7z|rar)$/i.test(arg);

  // Listen for CLI arguments on initial startup (double-clicking an associated .md file)
  useEffect(() => {
    let handled = false;
    const checkInitialCliArgs = async () => {
      if (handled) return;
      handled = true;
      try {
        const args = await invoke<string[]>('get_cli_args');
        if (args && args.length > 0) {
          for (const arg of args) {
            if (isOpenableDocumentArg(arg)) {
              await openFileByPath(arg);
              break;
            }
          }
        }
      } catch (err) {
        console.warn('Could not read CLI args:', err);
      }
    };

    checkInitialCliArgs();
  }, [openFileByPath]);

  // Listen for file open requests forwarded from subsequent instances (single-instance plugin)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setupListener = async () => {
      try {
        unlisten = await listen<string[]>('open-file-from-cli', async (event) => {
          const args = event.payload;
          if (args && args.length > 0) {
            for (const arg of args) {
              if (isOpenableDocumentArg(arg)) {
                await openFileByPath(arg);
                break;
              }
            }
          }
        });
      } catch (err) {
        console.warn('Could not setup single-instance listener:', err);
      }
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, [openFileByPath]);

  const handleOpenFile = async (specificPath?: string) => {
    setActiveMenu(null);
    try {
      let targetPath = specificPath;
      if (!targetPath) {
        const selected = await open({
          filters: [{ name: 'Documents', extensions: ['md', 'markdown', 'txt', 'pdf'] }],
          multiple: false
        });
        if (typeof selected === 'string') {
          targetPath = selected;
        }
      }

      if (targetPath) {
        await openFileByPath(targetPath);
      }
    } catch (error) {
      console.error('File open error:', error);
    }
  };

  const handleSaveFile = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    if (activeFile.kind === 'pdf') {
      await savePdfTab(false);
      return;
    }
    try {
      let targetPath = activeFile.path;
      if (!targetPath) {
        targetPath = await save({
          filters: [{ name: 'Markdown Documents', extensions: ['md'] }]
        });
      }

      if (targetPath) {
        lastSelfSaveTimeRef.current = Date.now();
        await writeTextFile(targetPath, activeFile.content);
        clearFileConflict(activeFileId);
        const fileName = targetPath.split(/[\/\\]/).pop() || 'document.md';
        setOpenFiles((prev) =>
          prev.map((f) => (f.id === activeFileId ? { ...f, path: targetPath, name: fileName, isModified: false } : f))
        );
      }
    } catch (error) {
      console.error('File save error:', error);
    }
  };

  const handleSaveFileAs = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    if (activeFile.kind === 'pdf') {
      await savePdfTab(true);
      return;
    }
    try {
      const targetPath = await save({
        filters: [{ name: 'Markdown Documents', extensions: ['md'] }]
      });

      if (targetPath) {
        lastSelfSaveTimeRef.current = Date.now();
        await writeTextFile(targetPath, activeFile.content);
        clearFileConflict(activeFileId);
        invoke('start_watching_file', { filePath: targetPath }).catch(() => {});
        const fileName = targetPath.split(/[\/\\]/).pop() || 'document.md';
        setOpenFiles((prev) =>
          prev.map((f) => (f.id === activeFileId ? { ...f, path: targetPath, name: fileName, isModified: false } : f))
        );
      }
    } catch (error) {
      console.error('File save-as error:', error);
    }
  };


  // ==========================================
  // PDF document actions (annotations, structural edits, save/export)
  // ==========================================

  /** Replace the active PDF tab's annotation list. */
  const updateActivePdfAnnots = useCallback((next: PdfAnnot[]) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.id === activeFileIdRef.current ? { ...f, pdfAnnots: next, isModified: true } : f))
    );
  }, []);

  /**
   * Save the active PDF tab. Annotations are EMBEDDED (still re-editable in
   * MarkdownX), never flattened — flattening is the explicit "导出压平" action.
   */
  const savePdfTab = async (forceDialog: boolean): Promise<void> => {
    const f = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
    if (!f?.pdfBytes) return;
    try {
      const { writeAnnotsIntoPdf } = await import('./pdf/annotStore');
      const bytes = await writeAnnotsIntoPdf(f.pdfBytes, f.pdfAnnots ?? []);
      let targetPath: string | null = forceDialog ? null : f.path;
      if (!targetPath) {
        targetPath = await save({ filters: [{ name: 'PDF Document', extensions: ['pdf'] }] });
      }
      if (!targetPath) return;
      lastSelfSaveTimeRef.current = Date.now();
      await writeFile(targetPath, bytes);
      const name = targetPath.split(/[\\/]/).pop() || f.name;
      setOpenFiles((prev) =>
        prev.map((x) => (x.id === f.id ? { ...x, path: targetPath, name, pdfBytes: bytes, isModified: false } : x))
      );
    } catch (e) {
      console.error('PDF save error:', e);
      setPdfOpenError(`保存失败：${String((e as Error)?.message || e)}`);
    }
  };

  /** Run a structural op on the active PDF tab's bytes. */
  const applyPdfStructuralOp = async (fn: (b: Uint8Array) => Promise<Uint8Array>): Promise<void> => {
    const f = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
    if (!f?.pdfBytes) return;
    try {
      const next = await fn(f.pdfBytes);
      setOpenFiles((prev) =>
        prev.map((x) => (x.id === f.id ? { ...x, pdfBytes: next, isModified: true } : x))
      );
    } catch (e) {
      setPdfOpenError(`操作失败：${String((e as Error)?.message || e)}`);
    }
  };

  /** 0-based index of the page currently most visible in the viewer. */
  const currentPdfPageIndex = (): number => (pdfPageInfo ? pdfPageInfo.page - 1 : 0);

  /** A pending selection belongs to one tab; drop it when the tab changes. */
  useEffect(() => {
    setPdfPendingSel(null);
  }, [activeFileId]);

  /**
   * Toolbar behaviour for the PDF mark buttons. Supports both mental models:
   *  1. select text first, then press the highlighter -> marks that selection;
   *  2. press the highlighter first, then select text -> PdfViewer marks on release.
   */
  /**
   * Mark the pending text selection with `kind`. Returns false when there is no
   * pending selection, so callers can fall back to just arming the tool.
   */
  const applyMarkToPendingSelection = (kind: AnnotKind): boolean => {
    if (!pdfPendingSel) return false;
    const f = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
    if (f) {
      updateActivePdfAnnots([
        ...(f.pdfAnnots ?? []),
        createAnnot({ page: pdfPendingSel.pageIndex, kind, rects: pdfPendingSel.rects }),
      ]);
    }
    setPdfPendingSel(null);
    window.getSelection()?.removeAllRanges();
    return true;
  };

  /** Toolbar icon semantics: apply to a pending selection, else toggle the tool. */
  const onPdfToolButton = (id: ViewerTool | null) => {
    const isMark = id === 'highlight' || id === 'underline' || id === 'strikeout';
    if (id && isMark && applyMarkToPendingSelection(id)) {
      setPdfTool(id); // stay armed so the next selection can be marked the same way
      return;
    }
    setPdfTool((cur) => (cur === id ? null : id));
  };

  /** Context-menu semantics: apply to a pending selection, else ARM (never toggle off). */
  const armOrApplyPdfTool = (id: ViewerTool) => {
    const isMark = id === 'highlight' || id === 'underline' || id === 'strikeout';
    if (isMark && applyMarkToPendingSelection(id)) {
      // ONE-SHOT from the menu: drop back to plain selection, otherwise the armed
      // tool would silently auto-mark every later text selection. The repeatable
      // "tool mode" is still available from the toolbar icon.
      setPdfTool(null);
      return;
    }
    setPdfTool(id);
  };

  const rotateCurrentPdfPage = async () => {
    const idx = currentPdfPageIndex();
    await applyPdfStructuralOp(async (b) => (await import('./pdf/structuralOps')).rotatePage(b, idx, 90));
  };

  const deleteCurrentPdfPage = async () => {
    const idx = currentPdfPageIndex();
    await applyPdfStructuralOp(async (b) => (await import('./pdf/structuralOps')).deletePages(b, [idx]));
  };

  const insertBlankAfterCurrent = async () => {
    const idx = currentPdfPageIndex();
    await applyPdfStructuralOp(async (b) => (await import('./pdf/structuralOps')).insertBlankPage(b, idx));
  };

  /** Save a single page as a new PDF (structure-edit level). */
  const handleExtractPdfPage = async (pageIndex: number): Promise<void> => {
    const f = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
    if (!f?.pdfBytes) return;
    try {
      const { extractPages } = await import('./pdf/structuralOps');
      const bytes = await extractPages(f.pdfBytes, [pageIndex]);
      const targetPath = await save({ filters: [{ name: 'PDF Document', extensions: ['pdf'] }] });
      if (!targetPath) return;
      await writeFile(targetPath, bytes);
    } catch (e) {
      setPdfOpenError(`提取页面失败：${String((e as Error)?.message || e)}`);
    }
  };

  /** Burn annotations into a shareable copy (CJK note text included). */
  const handleExportFlattenedPdf = async (): Promise<void> => {
    const f = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
    if (!f?.pdfBytes) return;
    try {
      const { flattenAnnotations } = await import('./pdf/flatten');
      const noteFontBytes = await fetchNoteFontBytes();
      const flattened = await flattenAnnotations(f.pdfBytes, f.pdfAnnots ?? [], { noteFontBytes });
      const targetPath = await save({ filters: [{ name: 'PDF Document', extensions: ['pdf'] }] });
      if (!targetPath) return;
      await writeFile(targetPath, flattened);
    } catch (e) {
      setPdfOpenError(`导出压平副本失败：${String((e as Error)?.message || e)}`);
    }
  };

  /** Merge several PDFs (picked from disk) into a new unsaved tab. */
  const handleMergePdfs = async (): Promise<void> => {
    try {
      const selected = await open({
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
        multiple: true,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length < 2) {
        setPdfOpenError('请至少选择两个 PDF 文件进行合并');
        return;
      }
      const { mergePdfs } = await import('./pdf/structuralOps');
      const docs: Uint8Array[] = [];
      for (const p of paths) docs.push(await loadPdfBytes(p));
      const merged = await mergePdfs(docs);
      const newId = `pdf-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const mergedTab: FileTab = {
        id: newId,
        name: `合并结果-${paths.length}份.pdf`,
        path: null,
        content: '',
        isModified: true,
        kind: 'pdf',
        pdfBytes: merged,
        pdfAnnots: [],
      };
      openFilesRef.current = [...openFilesRef.current, mergedTab];
      setOpenFiles((prev) => [...prev, mergedTab]);
      setActiveFileId(newId);
    } catch (e) {
      setPdfOpenError(`合并失败：${String((e as Error)?.message || e)}`);
    }
  };

  const openPdfMetadata = async (): Promise<void> => {
    const f = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
    if (!f?.pdfBytes) return;
    try {
      const { getMetadata } = await import('./pdf/structuralOps');
      const meta = await getMetadata(f.pdfBytes);
      setPdfMetaDraft(meta);
      setPdfMetaOpen(true);
    } catch (e) {
      setPdfOpenError(`读取元数据失败：${String((e as Error)?.message || e)}`);
    }
  };

  const savePdfMetadata = async (): Promise<void> => {
    const f = openFilesRef.current.find((x) => x.id === activeFileIdRef.current);
    if (!f?.pdfBytes) return;
    try {
      const { setMetadata } = await import('./pdf/structuralOps');
      const next = await setMetadata(f.pdfBytes, {
        title: pdfMetaDraft.title,
        author: pdfMetaDraft.author,
        subject: pdfMetaDraft.subject,
        keywords: pdfMetaDraft.keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setOpenFiles((prev) =>
        prev.map((x) => (x.id === activeFileIdRef.current ? { ...x, pdfBytes: next, isModified: true } : x))
      );
      setPdfMetaOpen(false);
    } catch (e) {
      setPdfOpenError(`写入元数据失败：${String((e as Error)?.message || e)}`);
    }
  };

  // ==========================================
  // Export Handlers (PDF, HTML, Word, LaTeX)
  // ==========================================


  // Save current settings as permanent program defaults
  const handleSaveAsProgramDefaults = () => {
    const newDefaults: AppPreferences = {
      defaultTheme: defaultThemeSetting,
      defaultViewMode: defaultModeSetting,
      defaultMathEngine: defaultMathEngineSetting,
      autoWatchExternalChanges: autoWatchSetting,
      defaultTypography: { ...typography }
    };
    try {
      localStorage.setItem('markdownx_app_preferences_v140', JSON.stringify(newDefaults));
      localStorage.setItem('markdownx_math_engine', defaultMathEngineSetting);
      setModalFeedback('✓ 已成功将当前设置保存为程序全局默认值！');
      setTimeout(() => setModalFeedback(null), 3000);
    } catch {
      setModalFeedback('保存默认值失败，请检查浏览器存储权限。');
    }
  };

  // Reset to factory defaults
  const handleResetFactoryDefaults = () => {
    try {
      localStorage.removeItem('markdownx_app_preferences_v140');
      localStorage.removeItem('markdownx_math_engine');
      setTypography(FACTORY_PREFERENCES.defaultTypography);
      setThemePref(FACTORY_PREFERENCES.defaultTheme);
      setDefaultThemeSetting(FACTORY_PREFERENCES.defaultTheme);
      setDefaultModeSetting(FACTORY_PREFERENCES.defaultViewMode);
      setDefaultMathEngineSetting(FACTORY_PREFERENCES.defaultMathEngine || 'svg');
      setAutoWatchSetting(true);
      setModalFeedback('✓ 已恢复程序出厂默认配置！');
      setTimeout(() => setModalFeedback(null), 3000);
    } catch {}
  };

  // 1. Independent Print handler (Ctrl + P) - Keeps system print dialog 100% active
  const handlePrint = () => {
    setActiveMenu(null);
    // A PDF must be printed at its OWN page size, one PDF page per sheet. Pouring the
    // live viewer through the A4 print stylesheet re-flows and re-paginates it, so the
    // PDF path renders each page to an image at true size instead (see PdfViewer).
    if (activeFile?.kind === 'pdf') {
      setPdfPrintToken((t) => t + 1);
      return;
    }
    // Print only after React has committed the menu-closed state and the browser has
    // laid it out: calling print() synchronously here snapped the print while an open
    // dropdown (the very menu the user clicked through) was still in the DOM, so the
    // exported PDF carried the menu with it.
    // A timer, not requestAnimationFrame: rAF does not fire while the window is not
    // rendering (minimised, hidden), which would silently swallow the print request.
    const printAfterFlush = () => {
      window.setTimeout(() => window.print(), 50);
    };
    if (isSourceMode) {
      // Route through toggleSourceMode so the reading position is carried back
      // into the preview instead of dumping the reader at the top.
      toggleSourceMode();
      setTimeout(printAfterFlush, 350);
    } else {
      printAfterFlush();
    }
  };

  // 2. Export HTML with embedded styles & MathJax
  const handleExportHtmlWithStyles = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const defaultName = (activeFile.name.replace(/\.[^/.]+$/, '') || 'document') + '.html';
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'HTML Document', extensions: ['html', 'htm'] }]
      });

      if (targetPath) {
        const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${activeFile.name.replace(/\.[^/.]+$/, '')}</title>
  <script>
    window.MathJax = {
      tex: {
        inlineMath: [['$', '$']],
        displayMath: [['$$', '$$']],
        processEscapes: true
      },
      svg: {
        fontCache: 'global'
      },
      options: {
        enableMenu: false,
        skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      }
    };
  </script>
  <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-svg.js"></script>
  <style>
    body {
      font-family: ${typography.latinFont}, ${typography.cjkFont}, serif;
      font-size: ${typography.fontSize}px;
      line-height: ${typography.lineHeight};
      color: ${appTheme === 'dark' ? '#f1f5f9' : (appTheme === 'sepia' ? '#3d352a' : '#1f2937')};
      background-color: ${appTheme === 'dark' ? '#0f172a' : (appTheme === 'sepia' ? '#fbf6ec' : '#ffffff')};
      margin: 0;
      padding: 48px 24px;
    }
    .markdownx-exported-doc {
      max-width: ${typography.maxWidth};
      margin: 0 auto;
    }
    p {
      margin-bottom: ${typography.paragraphMargin}em;
      text-align: ${typography.textAlign};
      text-align-last: left;
      text-indent: ${typography.firstLineIndent ? '2em' : '0'};
      word-break: break-word;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1.8em 0;
      border-top: 2.2px solid #1f2937;
      border-bottom: 2.2px solid #1f2937;
    }
    th {
      border-bottom: 1.2px solid #374151;
      padding: 10px 14px;
      text-align: left;
      background: #f8fafc;
    }
    td {
      border-bottom: 1px solid #e5e7eb;
      padding: 9px 14px;
      text-align: left;
    }
    .math-equation-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      margin: 1.5em 0;
    }
    .math-equation-content {
      flex: 1;
      text-align: center;
      overflow-x: auto;
    }
    mjx-container {
      color: ${appTheme === 'dark' ? '#f8fafc' : (appTheme === 'sepia' ? '#3d352a' : '#1f2937')} !important;
    }
    .math-equation-tag {
      font-size: 15px;
      color: ${appTheme === 'dark' ? '#94a3b8' : '#6b7280'};
      padding-left: 20px;
      flex-shrink: 0;
    }
    .equation-ref-link {
      color: #0969da;
      text-decoration: none;
      border-bottom: 1px dashed #0969da;
    }
    pre {
      background: #f6f8fa;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 14px 18px;
      overflow-x: auto;
    }
    .code-block-header {
      display: none;
    }
    .callout-card {
      margin: 1.5em 0;
      border-radius: 6px;
      border-left: 4px solid #0969da;
      background-color: rgba(9, 105, 218, 0.05);
      padding: 12px 18px;
    }
    .callout-header {
      font-weight: 600;
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  <div class="markdownx-exported-doc">
    ${renderedHtml}
  </div>
</body>
</html>`;
        await writeTextFile(targetPath, fullHtml);
      }
    } catch (err) {
      console.error('HTML export error:', err);
    }
  };

  // 3. Export plain HTML without styles
  const handleExportHtmlPlain = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const defaultName = (activeFile.name.replace(/\.[^/.]+$/, '') || 'document') + '_plain.html';
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'HTML Document', extensions: ['html', 'htm'] }]
      });

      if (targetPath) {
        const plainHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${activeFile.name.replace(/\.[^/.]+$/, '')}</title>
</head>
<body>
${renderedHtml}
</body>
</html>`;
        await writeTextFile(targetPath, plainHtml);
      }
    } catch (err) {
      console.error('Plain HTML export error:', err);
    }
  };

  // 4. Export LaTeX (.tex) manuscript
  const handleExportLatex = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const defaultName = (activeFile.name.replace(/\.[^/.]+$/, '') || 'document') + '.tex';
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'LaTeX Document', extensions: ['tex'] }]
      });

      if (targetPath) {
        let texBody = activeFile.content;
        texBody = texBody.replace(/^# (.+)$/gm, '\\section{$1}');
        texBody = texBody.replace(/^## (.+)$/gm, '\\subsection{$1}');
        texBody = texBody.replace(/^### (.+)$/gm, '\\subsubsection{$1}');
        texBody = texBody.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');
        texBody = texBody.replace(/\*(.+?)\*/g, '\\textit{$1}');
        texBody = texBody.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, '\\begin{verbatim}\n$1\\end{verbatim}');

        const texDoc = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage{geometry}
\\geometry{a4paper, margin=1in}

\\title{${activeFile.name.replace(/\.[^/.]+$/, '')}}
\\author{MarkdownX}
\\date{\\today}

\\begin{document}
\\maketitle

${texBody}

\\end{document}
`;
        await writeTextFile(targetPath, texDoc);
      }
    } catch (err) {
      console.error('LaTeX export error:', err);
    }
  };

  // 5. Export Word (.docx / .doc) with native MSO XML packaging
  const handleExportWord = async () => {
    setActiveMenu(null);
    if (!activeFile) return;
    try {
      const defaultName = (activeFile.name.replace(/\.[^/.]+$/, '') || 'document') + '.doc';
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'Word Document', extensions: ['doc', 'docx'] }]
      });

      if (targetPath) {
        const wordDocument = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
  <meta charset='utf-8'>
  <title>${activeFile.name.replace(/\.[^/.]+$/, '')}</title>
  <!--[if gte mso 9]>
  <xml>
    <w:WordDocument>
      <w:View>Print</w:View>
      <w:Zoom>100</w:Zoom>
      <w:DoNotOptimizeForBrowser/>
    </w:WordDocument>
  </xml>
  <![endif]-->
  <style>
    body {
      font-family: 'Times New Roman', SimSun, serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #000000;
    }
    h1 { font-size: 18pt; font-weight: bold; border-bottom: 1px solid #000; padding-bottom: 4pt; }
    h2 { font-size: 14pt; font-weight: bold; }
    h3 { font-size: 12pt; font-weight: bold; }
    p { margin-bottom: 8pt; text-align: justify; }
    table { border-collapse: collapse; width: 100%; margin: 12pt 0; border-top: 2pt solid #000; border-bottom: 2pt solid #000; }
    th { border-bottom: 1pt solid #000; padding: 6pt; font-weight: bold; text-align: left; }
    td { border-bottom: 0.5pt solid #ddd; padding: 5pt; text-align: left; }
    pre { background: #f4f4f4; border: 1px solid #ddd; padding: 8pt; font-family: Consolas, monospace; font-size: 9.5pt; }
  </style>
</head>
<body>
  <div>
    ${renderedHtml}
  </div>
</body>
</html>`;
        await writeTextFile(targetPath, wordDocument);
      }
    } catch (err) {
      console.error('Word export error:', err);
    }
  };


  const handleCloseFile = (idToClose: string) => {
    setActiveMenu(null);
    const tabToClose = openFiles.find((f) => f.id === idToClose);
    if (tabToClose?.path) {
      invoke('stop_watching_file', { filePath: tabToClose.path }).catch(() => {});
    }
    clearFileConflict(idToClose);
    if (openFiles.length <= 1) {
      setOpenFiles([{
        id: 'default-tab',
        name: '未命名文档.md',
        path: null,
        content: '',
        isModified: false
      }]);
      setActiveFileId('default-tab');
      return;
    }

    const remaining = openFiles.filter((f) => f.id !== idToClose);
    setOpenFiles(remaining);
    if (activeFileId === idToClose) {
      setActiveFileId(remaining[remaining.length - 1].id);
    }
  };


  // Tauri native drag-and-drop listener
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setupTauriDnD = async () => {
      try {
        const appWin = getCurrentWindow();
        unlisten = await appWin.onDragDropEvent((event) => {
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            setIsDragging(true);
          } else if (event.payload.type === 'drop') {
            setIsDragging(false);
            const droppedPaths = event.payload.paths;
            if (droppedPaths && droppedPaths.length > 0) {
              handleOpenFile(droppedPaths[0]);
            }
          } else if (event.payload.type === 'leave') {
            setIsDragging(false);
          }
        });
      } catch {
        // Safe fallback to HTML5 drag-and-drop
      }
    };

    setupTauriDnD();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Keep the maximize/restore glyph in step with the window, and expose the three
  // caption actions. Every call is guarded: outside Tauri (browser harness) the
  // window API is absent and the controls simply do nothing.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      const appWin = getCurrentWindow();
      const sync = () => {
        appWin.isMaximized()
          .then((maximized) => { if (!disposed) setIsWindowMaximized(!!maximized); })
          .catch(() => {});
      };
      sync();
      appWin.onResized(sync)
        .then((un) => { if (disposed) un(); else unlisten = un; })
        .catch(() => {});
    } catch {
      // No Tauri window (plain browser): leave the controls inert.
    }
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);

  // A rejected call here is almost always a missing capability (Tauri v2 gates
  // every window mutation behind an ACL entry), and swallowing it silently is
  // exactly how a dead button ships. Log it, and keep the UI alive.
  const runWindowCommand = (label: string, run: () => Promise<void>) => {
    const report = (err: unknown) => {
      console.warn(`[MarkdownX] window command "${label}" was refused:`, err);
      setWindowCmdNotice(`窗口命令「${label}」被拒绝：${String(err)}`);
    };
    try {
      run().catch(report);
    } catch (err) {
      report(err);
    }
  };
  const handleWindowMinimize = () => runWindowCommand('minimize', () => getCurrentWindow().minimize());
  const handleWindowToggleMaximize = () => runWindowCommand('toggle-maximize', () => getCurrentWindow().toggleMaximize());
  const handleWindowClose = () => runWindowCommand('close', () => getCurrentWindow().close());

  // Rust Native File Watcher (Notify Crate) integration
  useEffect(() => {
    if (!autoWatchSetting) return;

    // Start watching all open file paths with Rust backend
    openFiles.forEach((file) => {
      if (file.path) {
        invoke('start_watching_file', { filePath: file.path }).catch(() => {});
      }
    });
  }, [openFiles, autoWatchSetting]);

  useEffect(() => {
    if (!autoWatchSetting) return;

    let unlisten: (() => void) | undefined;
    const setupFileWatcherListener = async () => {
      try {
        unlisten = await listen<string>('file-modified-on-disk', async (event) => {
          const modifiedPath = event.payload;
          if (!modifiedPath) return;

          // 1. Guard against self-saves within 1.5s
          if (Date.now() - lastSelfSaveTimeRef.current < 1500) {
            return;
          }

          // 2. Debounce rapid OS writes within 400ms
          if (Date.now() - lastHandledTimeRef.current < 400) {
            return;
          }
          lastHandledTimeRef.current = Date.now();

          const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
          const targetNorm = norm(modifiedPath);

          const match = openFilesRef.current.find(
            (f) => f.path && (norm(f.path) === targetNorm || targetNorm.endsWith(norm(f.path)))
          );
          if (!match || !match.path) return;

          const targetId = match.id;
          const targetName = match.name;
          const targetPath = match.path;

          // 3. Disk read happens OUTSIDE any state updater (pure updaters only)
          let diskContent: string;
          try {
            diskContent = await readTextFile(targetPath);
          } catch (err) {
            console.warn('[FileWatcher] Read disk file error:', err);
            return;
          }

          // Re-read the freshest tab state after the async disk read
          const latest = openFilesRef.current.find((f) => f.id === targetId);
          if (!latest || latest.path !== targetPath) return; // tab closed or re-pointed meanwhile
          if (diskContent === latest.content) return;

          if (!latest.isModified) {
            // Case 1: Unmodified in MarkdownX -> Silent Auto-reload
            setOpenFiles((current) =>
              current.map((t) =>
                t.id === targetId ? { ...t, content: diskContent, isModified: false } : t
              )
            );
            if (targetId === activeFileIdRef.current) {
              setExternalReloadNotice(`✓ 外部更新：已自动同步「${targetName}」最新内容`);
              setTimeout(() => setExternalReloadNotice(null), 3000);
            }
          } else {
            // Case 2: Modified locally -> persist the conflict for THIS tab
            // (background tabs are no longer silently dropped; disk content is cached)
            setFileConflicts((prev) => ({
              ...prev,
              [targetId]: { tabId: targetId, fileName: targetName, filePath: targetPath, diskContent }
            }));
            if (targetId !== activeFileIdRef.current) {
              setExternalReloadNotice(`⚠️ 「${targetName}」检测到外部修改冲突，切换到该文档即可处理`);
              setTimeout(() => setExternalReloadNotice(null), 4000);
            }
          }
        });
      } catch (err) {
        console.warn('[FileWatcher] Setup listener failed:', err);
      }
    };

    setupFileWatcherListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, [autoWatchSetting]);

  // HTML5 Drag and Drop handlers
  const handleHtml5DragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleHtml5DragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleHtml5Drop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const filePath = (file as any).path;
      if (filePath) {
        handleOpenFile(filePath);
      } else {
        const text = await file.text();
        const newId = `file-${Date.now()}`;
        const newTab: FileTab = {
          id: newId,
          name: file.name,
          path: null,
          content: text,
          isModified: false
        };
        setOpenFiles((prev) => [...prev, newTab]);
        setActiveFileId(newId);
      }
    }
  };


  return (
    <div className="typora-shell" onDragOver={handleHtml5DragOver} onDragLeave={handleHtml5DragLeave} onDrop={handleHtml5Drop}>
      {/* Workbench row: the sidebar spans the full height, the top bar starts to its right */}
      <div className="app-row">
          {/* Collapsible Sidebar */}
          {isSidebarOpen && (
            <aside className="typora-sidebar" style={{ width: sidebarWidth }}>
              <div className="sb-brand">
                <MarkdownXLogo size={22} />
                <span className="sb-brand-name">MarkdownX</span>
                <span className="sb-badge" title={`版本 ${APP_VERSION} · 构建于 ${APP_BUILD_DATE}`}>{APP_VERSION}</span>
              </div>

              <button className="sb-newdoc" onClick={handleNewFile}>
                <AppIcon name="plus-circle" size={15} />
                <span>新建文档</span>
              </button>

              <div className="sb-searchbar" onClick={openSearchPanel}>
                <AppIcon name="search" size={14} />
                <span>{sidebarPanel === 'search' ? '文档查找与替换...' : '搜索 / 替换  (Ctrl+Shift+F)'}</span>
              </div>

              <div className="sb-scroll">
                {sidebarPanel === 'search' ? (
                  <div className="search-view">
                    <div className="sidebar-pane-title">文档全文查找与替换</div>
                    <div className="search-box">
                      <input
                        type="text"
                        className="search-input"
                        placeholder="查找内容..."
                        autoFocus
                        value={searchQuery}
                        onChange={(e) => handleSearch(e.target.value)}
                      />
                      <div className="search-nav-row">
                        <span className="search-count-label">
                          {searchMatchesCount > 0 ? `${currentMatchIndex + 1} / ${searchMatchesCount} 处匹配` : (searchQuery ? '无匹配项' : '输入关键词')}
                        </span>
                        <div className="search-nav-btns">
                          <button className="search-nav-btn" onClick={() => handleNavigateMatch(-1)} title="上一个匹配">▲</button>
                          <button className="search-nav-btn" onClick={() => handleNavigateMatch(1)} title="下一个匹配">▼</button>
                        </div>
                      </div>
                    </div>

                    <div className="replace-box">
                      <input
                        type="text"
                        className="replace-input"
                        placeholder="替换为..."
                        value={replaceQuery}
                        onChange={(e) => setReplaceQuery(e.target.value)}
                      />
                      <div className="replace-btns">
                        <button className="replace-action-btn" onClick={handleReplaceOne}>替换当前</button>
                        <button className="replace-action-btn" onClick={handleReplaceAll}>全部替换</button>
                      </div>
                    </div>

                    <button className="sb-back-link" onClick={() => setSidebarPanel('workspace')}>
                      ← 返回工作区
                    </button>
                  </div>
                ) : (
                  <>
                    {/* 大纲（树状，可逐节点折叠） */}
                    <div className="sb-region">
                      <div
                        className="sb-region-head"
                        onClick={() => setOutlineRegionOpen((v) => !v)}
                        title="点击折叠 / 展开此区域"
                      >
                        <span className={`sb-region-arrow ${outlineRegionOpen ? 'open' : ''}`}>▸</span>
                        <span className="sb-region-title">大纲 · OUTLINE</span>
                      </div>
                      {outlineRegionOpen && (
                        <div className="sb-region-body">
                          {outlineList.length === 0 ? (
                            <div className="sidebar-empty-hint">当前文档暂无标题</div>
                          ) : (
                            outlineRows.map((item, idx) => (
                              <div
                                key={`${item.line}-${idx}`}
                                className={`outline-item level-${item.level}${item.hasChild && item.collapsed ? ' has-collapsed' : ''}`}
                                style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                                title={`跳转到: ${item.title}`}
                              >
                                {item.hasChild ? (
                                  <span
                                    className="outline-caret"
                                    onClick={(e) => { e.stopPropagation(); toggleOutlineNode(item.line); }}
                                    title={item.collapsed ? '展开子标题' : '折叠子标题'}
                                  >
                                    {item.collapsed ? '▸' : '▾'}
                                  </span>
                                ) : (
                                  <span className="outline-caret-sp" />
                                )}
                                <span
                                  className="outline-title"
                                  onClick={() => handleOutlineClick(item)}
                                >
                                  {item.title}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    {/* 已打开文档 */}
                    <div className="sb-region">
                      <div className="sb-region-head static">
                        <span className="sb-region-title">已打开 · DOCUMENTS ({openFiles.length})</span>
                      </div>
                      <div className="sb-region-body">
                        {openFiles.map((file) => (
                          <div
                            key={file.id}
                            className={`sidebar-doc-item ${file.id === activeFileId ? 'active' : ''}`}
                            onClick={() => setActiveFileId(file.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              ctxAnchorElementRef.current = null;
                              openContextMenu(e.clientX, e.clientY, {
                                surface: 'tab',
                                fileId: file.id,
                                path: file.path || undefined,
                              });
                            }}
                            title={file.path || '未保存于磁盘'}
                          >
                            <AppIcon name="file-text" size={14} className="doc-icon-2" />
                            <span className="doc-name">{fileBaseName(file.path) || file.name}{fileConflicts[file.id] ? ' ⚠️' : ''}</span>
                            {file.isModified && <span className="doc-modified-dot" title="未保存更改">•</span>}
                            <button
                              className="doc-close-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCloseFile(file.id);
                              }}
                              title="关闭文档"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 工作区文件树 */}
                    <div className="sb-region">
                      <div className="sb-region-head static">
                        <span className="sb-region-title">工作区 · WORKSPACE</span>
                        <button className="sb-mini-btn" onClick={handleSelectWorkspace} title="打开本地文件夹作为工作区">
                          <AppIcon name="folder-open" size={13} />
                        </button>
                      </div>
                      <div className="sb-region-body">
                        {workspaceFiles.length === 0 ? (
                          <div className="sidebar-empty-hint">
                            {workspaceDir ? '该文件夹内暂无 Markdown 文件' : '点击上方图标选择本地文件夹'}
                          </div>
                        ) : (
                          <>
                            <div className="sb-ws-root" title={workspaceDir || ''}>
                              {workspaceDir ? workspaceDir.split(/[\\/]/).pop() : ''}
                            </div>
                            {workspaceFiles.map((item) => (
                              <FileTreeNode
                                key={item.path}
                                item={item}
                                level={0}
                                activePath={activeFile?.path || null}
                                expandedDirs={expandedDirs}
                                dirChildrenCache={dirChildrenCache}
                                onToggleDir={handleToggleDirectory}
                                onOpenFile={openFileByPath}
                                onFileContextMenu={openSidebarFileMenu}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    </div>

                    {/* 最近文件 */}
                    {recentFiles.length > 0 && (
                      <div className="sb-region">
                        <div className="sb-region-head static">
                          <span className="sb-region-title">最近 · RECENT</span>
                        </div>
                        <div className="sb-region-body">
                          {recentFiles.slice(0, 6).map((rf, idx) => (
                            <div
                              key={idx}
                              className="sidebar-doc-item"
                              onClick={() => handleOpenFile(rf.path)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                openSidebarFileMenu(e.clientX, e.clientY, rf.path);
                              }}
                              title={rf.path}
                            >
                              <AppIcon name="file-text" size={14} className="doc-icon-2" />
                              <span className="doc-name">{rf.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </aside>
          )}

        {/* Sidebar splitter: drag to resize, click the arrow to collapse / expand */}
        <div
          className={`sb-splitter ${isSidebarOpen ? '' : 'collapsed'}`}
          onMouseDown={beginSidebarDrag}
          title={isSidebarOpen ? '拖动调整侧边栏宽度' : '拖动或点击展开侧边栏'}
        >
          <button
            className="sb-splitter-arrow"
            onClick={() => setIsSidebarOpen((prev) => !prev)}
            title={isSidebarOpen ? '隐藏侧边栏 (Ctrl+Shift+L)' : '显示侧边栏 (Ctrl+Shift+L)'}
          >
            <AppIcon name={isSidebarOpen ? 'sidebar-left' : 'sidebar-right'} size={13} />
          </button>
          {!isSidebarOpen && (
            <button
              className="sb-splitter-open"
              onClick={() => handleOpenFile()}
              title="打开文件 (Ctrl+O)"
            >
              <AppIcon name="folder" size={12} />
            </button>
          )}
        </div>

        <div className="app-col">
            {/* 1. Workbench top bar: identity + document, view tabs, edit cluster, menus */}
            <header className="wb-topbar" data-tauri-drag-region>
        <div className="wb-tb-left" data-tauri-drag-region>
          {windowCmdNotice && (
            <span className="wb-cmd-notice" title={windowCmdNotice}>
              {windowCmdNotice}
            </span>
          )}
          {/* Document actions: save (left) / save-as (right), then print-export */}
          <button
            className="wb-icon-btn"
            onClick={handleSaveFile}
            onContextMenu={(e) => { e.preventDefault(); handleSaveFileAs(); }}
            title="保存 (Ctrl+S)｜右键：另存为"
          >
            <AppIcon name="save" size={16} />
          </button>
          <div className="wb-menu-host">
            <button
              className={`wb-icon-btn ${activeMenu === 'export' ? 'active' : ''}`}
              data-ctx-menu="export"
              onClick={handlePrint}
              onContextMenu={(e) => { e.preventDefault(); setActiveMenu(activeMenu === 'export' ? null : 'export'); }}
              title="打印 / 导出（左键直接打印 PDF，右键选择格式）"
            >
              <AppIcon name="print" size={16} />
            </button>
            {activeMenu === 'export' && (
              <div className="typora-dropdown-menu wb-dropdown">
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); handlePrint(); }}>
                  <span>PDF / 打印...</span><span className="shortcut">Ctrl+P</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); handleExportHtmlWithStyles(); }}>
                  <span>HTML (带完整样式)...</span>
                </div>
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); handleExportHtmlPlain(); }}>
                  <span>HTML (纯净片段)...</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); handleExportWord(); }}>
                  <span>Word (.docx)...</span>
                </div>
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); handleExportLatex(); }}>
                  <span>LaTeX (.tex)...</span>
                </div>
              </div>
            )}
          </div>

          {/* PDF annotation tools: icon buttons placed AFTER print/export, and only
              rendered while a PDF tab is active (Markdown never shows them). */}
          {activeFile?.kind === 'pdf' && (
            <div className="pdf-tool-icons">
              {PDF_TOOL_ICONS.map((t) => (
                <button
                  key={String(t.id)}
                  className={`wb-icon-btn ${pdfTool === t.id ? 'active' : ''}`}
                  title={t.title}
                  onClick={() => onPdfToolButton(t.id)}
                >
                  <AppIcon name={t.icon} size={16} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="wb-tb-center" data-tauri-drag-region>
          <div className="wb-view-tabs">
            <button className={`wb-view-tab ${!isSourceMode ? 'active' : ''}`} onClick={() => { if (isSourceMode) toggleSourceMode(); }} title="沉浸排版视图 (Ctrl+/)">
              排版
            </button>
            <button className={`wb-view-tab ${isSourceMode ? 'active' : ''}`} onClick={() => { if (!isSourceMode) toggleSourceMode(); }} title="源码模式 (Ctrl+/)">
              源码
            </button>
          </div>
        </div>

        <div className="wb-tb-right">
          {/* View options: everything that used to hide at the bottom of the big menu */}
          <div className="wb-menu-host">
            <button
              className={`wb-icon-btn ${activeMenu === 'view' ? 'active' : ''}`}
              data-optional="true"
              data-ctx-menu="view"
              onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === 'view' ? null : 'view'); }}
              title="视图选项（状态栏 / 打字机 / 置顶 / 缩放 / 全屏 / 开发者工具）"
            >
              <AppIcon name="monitor" size={15} />
            </button>
            {activeMenu === 'view' && (
              <div className="typora-dropdown-menu wb-dropdown right">
                <div className="dropdown-item" onClick={() => { setShowStatusBar((v) => !v); setActiveMenu(null); }}>
                  <span>{showStatusBar ? '✓ 显示状态栏' : '显示状态栏'}</span>
                </div>
                <div className="dropdown-item" onClick={() => { setIsTypewriterMode((v) => !v); setActiveMenu(null); }}>
                  <span>{isTypewriterMode ? '✓ 打字机模式' : '打字机模式'}</span><span className="shortcut">F9</span>
                </div>
                <div className="dropdown-item" onClick={() => { handleToggleAlwaysOnTop(); setActiveMenu(null); }}>
                  <span>{isAlwaysOnTop ? '✓ 窗口置顶' : '窗口置顶'}</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => { setZoomLevel((z) => Math.min(2.0, Number((z + 0.1).toFixed(1)))); setActiveMenu(null); }}>
                  <span>放大界面</span><span className="shortcut">Ctrl+Shift+=</span>
                </div>
                <div className="dropdown-item" onClick={() => { setZoomLevel((z) => Math.max(0.6, Number((z - 0.1).toFixed(1)))); setActiveMenu(null); }}>
                  <span>缩小界面</span><span className="shortcut">Ctrl+Shift+-</span>
                </div>
                <div className="dropdown-item" onClick={() => { setZoomLevel(1.0); setActiveMenu(null); }}>
                  <span>实际大小 {Math.round(zoomLevel * 100)}%</span><span className="shortcut">Ctrl+Shift+9</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => { handleToggleFullscreen(); setActiveMenu(null); }}>
                  <span>{isFullscreen ? '退出全屏' : '进入全屏'}</span><span className="shortcut">F11</span>
                </div>
                <div className="dropdown-item" onClick={() => { handleOpenDevTools(); setActiveMenu(null); }}>
                  <span>开发者工具</span><span className="shortcut">Shift+F12</span>
                </div>
              </div>
            )}
          </div>
          <span className="wb-cluster-sep" />
          {/* Edit cluster - kept visible by user decision, as icon buttons */}
          <div className="wb-edit-cluster">
            <button className="wb-icon-btn" onClick={() => runEditorCommand('undo')} title="撤销 (Ctrl+Z)"><AppIcon name="undo" size={15} /></button>
            <button className="wb-icon-btn" onClick={() => runEditorCommand('redo')} title="重做 (Ctrl+Y)"><AppIcon name="redo" size={15} /></button>
            <span className="wb-cluster-sep" />
            <button className="wb-icon-btn" onClick={() => runEditorCommand('cut')} title="剪切 (Ctrl+X)"><AppIcon name="scissors" size={15} /></button>
            <button className="wb-icon-btn" onClick={() => runEditorCommand('copy')} title="复制 (Ctrl+C)"><AppIcon name="copy" size={15} /></button>
            <button className="wb-icon-btn" onClick={() => runEditorCommand('paste')} title="粘贴 (Ctrl+V)"><AppIcon name="clipboard" size={15} /></button>
          </div>
          <span className="wb-cluster-sep" />
          <button
            className={`wb-icon-btn ${isFocusMode ? 'active' : ''}`}
            onClick={() => setIsFocusMode((v) => !v)}
            data-optional="true"
            title={`专注模式 (F8)`}
          >
            <AppIcon name="target" size={15} />
          </button>
          <button
            className={`wb-icon-btn ${isInspectorOpen ? 'active' : ''}`}
            onClick={() => setIsInspectorOpen((v) => !v)}
            data-optional="true"
            title="排版检查器 (Ctrl+Shift+2)"
          >
            <AppIcon name="type" size={15} />
          </button>
          <div className="wb-menu-host">
            <button
              className="wb-icon-btn"
              data-optional="true"
              data-ctx-menu="theme"
              onClick={cycleTheme}
              onContextMenu={(e) => { e.preventDefault(); setActiveMenu(activeMenu === 'theme' ? null : 'theme'); }}
              title={`主题：${themePref === 'auto' ? '跟随系统' : appTheme}（左键循环，右键选择）`}
            >
              <AppIcon name={themeIconName()} size={15} />
            </button>
            {activeMenu === 'theme' && (
              <div className="typora-dropdown-menu wb-dropdown right">
                {THEME_OPTIONS.map((thm) => (
                  <div key={thm.id} className="dropdown-item" onClick={() => { setThemePref(thm.id); setActiveMenu(null); }}>
                    <span>{themePref === thm.id ? `✓ ${thm.icon} ${thm.name}` : `  ${thm.icon} ${thm.name}`}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Settings: the only home for 偏好设置 (Ctrl+,). */}
          <button
            className="wb-icon-btn"
            data-optional="true"
            onClick={() => { setShowTypographyModal(true); }}
            title="偏好设置 (Ctrl+,)"
          >
            <AppIcon name="settings" size={15} />
          </button>

          {/* Help: cheat sheet, LaTeX guide, about (version / release notes / licence). */}
          <div className="wb-menu-host">
            <button
              className={`wb-icon-btn ${activeMenu === 'help' ? 'active' : ''} ${updateInfo.status === 'available' ? 'has-update' : ''}`}
              data-optional="true"
              onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === 'help' ? null : 'help'); }}
              title="帮助：快捷键速查 / LaTeX 指南 / 关于"
            >
              <AppIcon name="help" size={15} />
            </button>
            {activeMenu === 'help' && (
              <div className="typora-dropdown-menu wb-dropdown right">
                <div className="dropdown-item" onClick={() => { setShowHelpModal(true); setActiveMenu(null); }}>
                  <span>快捷键速查表</span>
                </div>
                <div className="dropdown-item" onClick={() => { setShowMathHelpModal(true); setActiveMenu(null); }}>
                  <span>LaTeX 公式与排版指南</span>
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-item" onClick={() => { setActiveMenu(null); void runUpdateCheck(true); }}>
                  <span>
                    {updateInfo.status === 'available'
                      ? `检查更新（有新版本 ${updateInfo.version}）`
                      : updateInfo.status === 'checking' ? '正在检查更新…' : '检查更新…'}
                  </span>
                </div>
                <div className="dropdown-item" onClick={() => { setShowAboutModal(true); setActiveMenu(null); }}>
                  <span>关于 MarkdownX</span>
                </div>
              </div>
            )}
          </div>

          {/* Caption buttons: the window has no OS title bar, so these three live
              on the application's own top bar row. */}
          <div className="wb-win-controls">
            <button className="wb-win-btn" onClick={handleWindowMinimize} title="最小化" aria-label="最小化">
              <AppIcon name="win-min" size={14} strokeWidth={1.4} />
            </button>
            <button
              className="wb-win-btn"
              onClick={handleWindowToggleMaximize}
              title={isWindowMaximized ? '向下还原' : '最大化'}
              aria-label={isWindowMaximized ? '向下还原' : '最大化'}
            >
              <AppIcon name={isWindowMaximized ? 'win-restore' : 'win-max'} size={14} strokeWidth={1.4} />
            </button>
            <button className="wb-win-btn close" onClick={handleWindowClose} title="关闭" aria-label="关闭">
              <AppIcon name="close" size={14} strokeWidth={1.4} />
            </button>
          </div>
        </div>
      </header>

      {/* Document tabs: file name on the tab, full path on hover */}
      <div className="doc-tabs" role="tablist">
        {openFiles.map((f) => (
          <div
            key={f.id}
            role="tab"
            aria-selected={f.id === activeFileId}
            className={`doc-tab ${f.id === activeFileId ? 'active' : ''}`}
            title={f.path || f.name || '未保存'}
            onClick={() => setActiveFileId(f.id)}
            onContextMenu={(e) => {
              e.preventDefault(); e.stopPropagation();
              ctxAnchorElementRef.current = null;
              openContextMenu(e.clientX, e.clientY, { surface: 'tab', fileId: f.id, path: f.path || undefined });
            }}
          >
            {f.kind === 'pdf' ? <span className="doc-tab-badge" title="PDF 文档">PDF</span> : null}
            <span className="doc-tab-name">{fileBaseName(f.path) || f.name || '未保存'}</span>
            {f.isModified ? <span className="doc-tab-dot" title="未保存的修改">•</span> : null}
            {openFiles.length > 1 ? (
              <button
                className="doc-tab-close"
                title="关闭此文档"
                onClick={(e) => { e.stopPropagation(); handleCloseFile(f.id); }}
              >
                <AppIcon name="close" size={11} />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {/* External File Modification Conflict Alert Banner (per-tab; shown when that tab is active) */}
      {conflictBanner && (
        <div className="file-conflict-banner">
          <div className="conflict-banner-icon">⚠️</div>
          <div className="conflict-banner-msg">
            <strong>外部修改冲突</strong>：磁盘文件「<strong>{conflictBanner.fileName}</strong>」已被外部程序更新，但您在 MarkdownX 中有未保存的修改。
          </div>
          <div className="conflict-banner-actions">
            <button
              className="conflict-btn conflict-btn-reload"
              onClick={() => {
                setOpenFiles((prev) =>
                  prev.map((t) =>
                    t.id === conflictBanner.tabId
                      ? { ...t, content: conflictBanner.diskContent, isModified: false }
                      : t
                  )
                );
                clearFileConflict(conflictBanner.tabId);
                setExternalReloadNotice(`✓ 已成功载入「${conflictBanner.fileName}」磁盘最新版本`);
                setTimeout(() => setExternalReloadNotice(null), 3000);
              }}
              title="放弃当前编辑器中的本地修改，直接载入磁盘上的最新版本"
            >
              🔄 载入磁盘最新版
            </button>
            <button
              className="conflict-btn conflict-btn-overwrite"
              onClick={() => {
                handleSaveFile();
                clearFileConflict(conflictBanner.tabId);
              }}
              title="以当前编辑器中的内容强行覆盖保存到磁盘"
            >
              💾 覆盖为当前版本
            </button>
            <button
              className="conflict-btn conflict-btn-dismiss"
              onClick={() => clearFileConflict(conflictBanner.tabId)}
              title="保留当前编辑，暂不处理"
            >
              ✕ 忽略
            </button>
          </div>
        </div>
      )}

      {/* Toast Notice for Silent External Reload */}
      {externalReloadNotice && (
        <div className="external-reload-toast">
          {externalReloadNotice}
        </div>
      )}

      {/* PDF open failure notice (bad file, encrypted, unreadable ...) */}
      {pdfOpenError && (
        <div className="external-reload-toast" onClick={() => setPdfOpenError(null)} title="点击关闭" style={{ cursor: 'pointer' }}>
          ⚠️ {pdfOpenError}
        </div>
      )}

      {/* PDF metadata editor */}
      {pdfMetaOpen && (
        <div className="typo-modal-overlay" onClick={() => setPdfMetaOpen(false)}>
          <div className="typo-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>📄 PDF 文档元数据</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setPdfMetaOpen(false)}>
                ×
              </button>
            </div>
            <div className="typo-modal-body">
              <div className="pdf-meta-form">
                <label>
                  标题 (Title)
                  <input
                    value={pdfMetaDraft.title}
                    onChange={(e) => setPdfMetaDraft((d) => ({ ...d, title: e.target.value }))}
                  />
                </label>
                <label>
                  作者 (Author)
                  <input
                    value={pdfMetaDraft.author}
                    onChange={(e) => setPdfMetaDraft((d) => ({ ...d, author: e.target.value }))}
                  />
                </label>
                <label>
                  主题 (Subject)
                  <input
                    value={pdfMetaDraft.subject}
                    onChange={(e) => setPdfMetaDraft((d) => ({ ...d, subject: e.target.value }))}
                  />
                </label>
                <label>
                  关键词 (Keywords，逗号分隔)
                  <input
                    value={pdfMetaDraft.keywords}
                    onChange={(e) => setPdfMetaDraft((d) => ({ ...d, keywords: e.target.value }))}
                  />
                </label>
              </div>
            </div>
            <div className="typo-modal-footer">
              <button className="typora-btn" onClick={() => setPdfMetaOpen(false)}>
                取消
              </button>
              <button className="typora-btn" onClick={() => void savePdfMetadata()}>
                保存元数据
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Main Workspace & Collapsible Sidebar Container */}
      <div className="typora-main-layout">
        {isInspectorOpen && activeFile?.kind === 'pdf' ? (
          <aside className="typo-inspector">
            <div className="insp-head">
              <span className="insp-title">编辑器</span>
              <button className="sb-mini-btn" onClick={() => setIsInspectorOpen(false)} title="关闭">
                <AppIcon name="close" size={13} />
              </button>
            </div>
            <div className="insp-body">
              <div className="insp-group">
                <div className="insp-label">
                  页面操作 <span className="insp-val">第 {pdfPageInfo?.page ?? 1} / {pdfPageInfo?.total ?? '?'} 页</span>
                </div>
                <div className="insp-btn-grid">
                  <button className="insp-op-btn" title="把当前页旋转 90°" onClick={() => void rotateCurrentPdfPage()}>
                    <AppIcon name="rotate-cw" size={15} /><span>旋转</span>
                  </button>
                  <button className="insp-op-btn" title="删除当前页" onClick={() => void deleteCurrentPdfPage()}>
                    <AppIcon name="trash" size={15} /><span>删页</span>
                  </button>
                  <button className="insp-op-btn" title="在当前页后插入空白页" onClick={() => void insertBlankAfterCurrent()}>
                    <AppIcon name="page-plus" size={15} /><span>插页</span>
                  </button>
                  <button className="insp-op-btn" title="把当前页另存为新的 PDF" onClick={() => void handleExtractPdfPage(currentPdfPageIndex())}>
                    <AppIcon name="page-extract" size={15} /><span>提取页</span>
                  </button>
                </div>
              </div>

              <div className="insp-group">
                <div className="insp-label">文档</div>
                <div className="insp-btn-grid">
                  <button className="insp-op-btn" title="编辑 PDF 元数据" onClick={() => void openPdfMetadata()}>
                    <AppIcon name="info" size={15} /><span>元数据</span>
                  </button>
                  <button className="insp-op-btn" title="导出压平副本：标注烧进页面，任何阅读器可见" onClick={() => void handleExportFlattenedPdf()}>
                    <AppIcon name="flatten" size={15} /><span>导出压平</span>
                  </button>
                  <button className="insp-op-btn" title="选择多个 PDF 合并为一个新文档" onClick={() => void handleMergePdfs()}>
                    <AppIcon name="merge-pdf" size={15} /><span>合并 PDF</span>
                  </button>
                </div>
              </div>

              <div className="insp-group">
                <div className="insp-label">标注说明</div>
                <div className="insp-help">
                  高亮 / 下划线 / 删除线：先选中文字，再单击页面。<br />
                  便签、墨迹：在页面上拖动。<br />
                  橡皮：拖出一个框，删除框内所有标注。
                </div>
                <button
                  className="typo-radio-btn insp-reset"
                  onClick={() => updateActivePdfAnnots([])}
                  title="删除当前 PDF 的全部标注"
                >
                  清空全部标注
                </button>
              </div>
            </div>
          </aside>
        ) : isInspectorOpen && !isSourceMode ? (
          <aside className="typo-inspector">
            <div className="insp-head">
              <span className="insp-title">编辑器</span>
              <button className="sb-mini-btn" onClick={() => setIsInspectorOpen(false)} title="关闭">
                <AppIcon name="close" size={13} />
              </button>
            </div>
            <div className="insp-body">
              <div className="insp-group">
                <div className="insp-label">对齐方式</div>
                <div className="typo-radio-toggle">
                  <button
                    className={`typo-radio-btn ${typography.textAlign === 'justify' ? 'active' : ''}`}
                    onClick={() => setTypography((t) => ({ ...t, textAlign: 'justify' }))}
                    title="两端对齐，末行靠左"
                  >
                    <AppIcon name="align-justify" size={14} />
                  </button>
                  <button
                    className={`typo-radio-btn ${typography.textAlign === 'left' ? 'active' : ''}`}
                    onClick={() => setTypography((t) => ({ ...t, textAlign: 'left' }))}
                    title="自然左对齐"
                  >
                    <AppIcon name="align-left" size={14} />
                  </button>
                </div>
              </div>

              <div className="insp-group">
                <div className="insp-label">首行缩进</div>
                <div className="typo-radio-toggle">
                  <button
                    className={`typo-radio-btn ${!typography.firstLineIndent ? 'active' : ''}`}
                    onClick={() => setTypography((t) => ({ ...t, firstLineIndent: false }))}
                  >
                    顶格
                  </button>
                  <button
                    className={`typo-radio-btn ${typography.firstLineIndent ? 'active' : ''}`}
                    onClick={() => setTypography((t) => ({ ...t, firstLineIndent: true }))}
                  >
                    2 字符
                  </button>
                </div>
              </div>

              <div className="insp-group">
                <div className="insp-label">正文字号 <span className="insp-val">{typography.fontSize}px</span></div>
                <input
                  type="range" min={12} max={26} step={1}
                  className="typo-slider"
                  value={typography.fontSize}
                  onChange={(e) => setTypography((t) => ({ ...t, fontSize: Number(e.target.value) }))}
                />
              </div>

              <div className="insp-group">
                <div className="insp-label">行高 <span className="insp-val">{typography.lineHeight}</span></div>
                <input
                  type="range" min={1.4} max={2.5} step={0.05}
                  className="typo-slider"
                  value={typography.lineHeight}
                  onChange={(e) => setTypography((t) => ({ ...t, lineHeight: Number(e.target.value) }))}
                />
              </div>

              <div className="insp-group">
                <div className="insp-label">段间距 <span className="insp-val">{typography.paragraphMargin}em</span></div>
                <input
                  type="range" min={0.5} max={2.5} step={0.1}
                  className="typo-slider"
                  value={typography.paragraphMargin}
                  onChange={(e) => setTypography((t) => ({ ...t, paragraphMargin: Number(e.target.value) }))}
                />
              </div>

              <div className="insp-group">
                <div className="insp-label">版心宽度</div>
                <select
                  className="typo-select"
                  value={typography.maxWidth}
                  onChange={(e) => setTypography((t) => ({ ...t, maxWidth: e.target.value }))}
                >
                  {MAX_WIDTH_OPTIONS.map((opt, i) => (
                    <option key={i} value={opt.value}>{opt.name}</option>
                  ))}
                </select>
              </div>

              <div className="insp-group">
                <div className="insp-label">字体族 (Font Family)</div>
                <select
                  className="typo-select"
                  value={matchFamilyValue(typography.latinFont, latinOptions)}
                  onChange={(e) => setTypography((t) => ({ ...t, latinFont: e.target.value }))}
                  title="西文正文字体（读取系统已安装字体）"
                >
                  {latinOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <select
                  className="typo-select"
                  value={matchFamilyValue(typography.cjkFont, cjkOptions)}
                  onChange={(e) => setTypography((t) => ({ ...t, cjkFont: e.target.value }))}
                  title="中文正文字体（读取系统已安装字体）"
                >
                  {cjkOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <button
                className="typo-radio-btn insp-reset"
                onClick={() => setTypography(DEFAULT_TYPOGRAPHY)}
                title="恢复默认排版参数"
              >
                恢复默认排版
              </button>
            </div>
          </aside>
        ) : null}

        {/* Main Workspace */}
        <main
          className={`typora-workspace ${isFocusMode ? 'focus-mode-active' : ''} ${isTypewriterMode ? 'typewriter-mode-active' : ''}`}
          style={{ zoom: zoomLevel }}
        >
          {activeFile?.kind === 'pdf' && activeFile.pdfBytes ? (
            <React.Suspense fallback={<div className="pdf-loading">正在加载 PDF 引擎…</div>}>
              <PdfViewer
                key={activeFile.id}
                bytes={activeFile.pdfBytes}
                annots={activeFile.pdfAnnots ?? []}
                onAnnotsChange={updateActivePdfAnnots}
                onVisiblePageChange={(page, total) => setPdfPageInfo({ page, total })}
                onError={(msg) => console.error('PDF render error:', msg)}
                tool={pdfTool}
                scale={pdfScale}
                onScaleChange={setPdfScale}
                printToken={pdfPrintToken}
                onSelectionChange={setPdfPendingSel}
                onSurfaceContextMenu={({ clientX, clientY, pageIndex, annotId, annotText, selectedText }) => {
                  ctxAnchorElementRef.current = null;
                  openContextMenu(clientX, clientY, {
                    surface: annotId ? 'pdf-annot' : 'pdf-page',
                    annotId,
                    annotText,
                    selectedText,
                    pageIndex,
                    pageCount: pdfPageInfo?.total ?? undefined,
                  });
                }}
              />
            </React.Suspense>
          ) : isSourceMode ? (
            /* Pure Source Code Editor */
            <div className="source-fullscreen-pane">
              {caretFlash && (
                <>
                  <div
                    className="source-caret-flash"
                    style={{ top: caretFlash.top, left: caretFlash.left, width: caretFlash.width, height: caretFlash.height }}
                  />
                  <div
                    className="source-caret-tick"
                    style={{ top: caretFlash.top, left: caretFlash.tickLeft, height: caretFlash.height }}
                  />
                </>
              )}
              <textarea
                ref={textareaRef}
                aria-label="Markdown Source Code"
                className="typora-fullscreen-textarea"
                value={activeFile?.content || ''}
                onChange={(e) => {
                  if (caretFlash) setCaretFlash(null);
                  handleContentChange(e.target.value);
                }}
                onKeyUp={() => {
                  if (isTypewriterMode && textareaRef.current) {
                    const ta = textareaRef.current;
                    const cursorIndex = ta.selectionStart;
                    const lines = ta.value.substring(0, cursorIndex).split('\n');
                    const lineIndex = lines.length - 1;
                    const lineHeight = 28;
                    const targetScroll = Math.max(0, lineIndex * lineHeight - ta.clientHeight / 2);
                    ta.scrollTop = targetScroll;
                  }
                }}
                placeholder="在此输入 Markdown 或 LaTeX 公式源码..."
                spellCheck={false}
                autoFocus
              />
            </div>
          ) : (
            /* Pure Typora Centered Article View */
            <div className="typora-document-scroll">
              <div
                className="typora-paper-article"
                onContextMenu={(e) => {
                  e.preventDefault();
                  openContextMenu(e.clientX, e.clientY, classifyPreviewTarget(e));
                }}
              >
                {activeFile?.content?.trim() ? (
                  <article
                    ref={previewRef}
                    className="academic-article"
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                    onDoubleClick={handlePreviewDoubleClick}
                  />
                ) : (
                  <div
                    className="typora-empty-guide"
                    onClick={() => enterSourceMode(null)}
                  >
                    <p className="empty-hint-main">点击此处或按 <kbd>Ctrl + /</kbd> 开始书写...</p>
                    <p className="empty-hint-sub">也可将 .md 文件拖入窗口，或用顶部 <strong>⋯ 菜单 ➔ 打开文件...</strong> 打开本地 Markdown 文档</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
      </div>
      </div>

      {/* 4. Typora Bottom Status Bar (Toggleable) */}
      {showStatusBar && (
        <footer className="typora-statusbar">
          <div className="status-left">
            {activeFile?.kind === 'pdf' && pdfPageInfo ? (
              <>
                <span className="status-badge" style={{ fontWeight: 500 }}>
                  第 {pdfPageInfo.page} / {pdfPageInfo.total} 页
                </span>
                <span className="sep">•</span>
                <span>{activeFile.pdfAnnots?.length ?? 0} 个标注</span>
                {activeFile.isModified && <><span className="sep">•</span><span className="status-pill-badge">未保存</span></>}
                <span className="sep">•</span>
                <span className="pdf-status-zoom" title="缩放（Ctrl + 滚轮也可缩放）">
                  <button className="pdf-zoom-btn" onClick={() => setPdfScale((s) => Math.max(0.25, +(s - 0.25).toFixed(2)))}>−</button>
                  <span className="pdf-zoom-val">{Math.round(pdfScale * 100)}%</span>
                  <button className="pdf-zoom-btn" onClick={() => setPdfScale((s) => Math.min(4, +(s + 0.25).toFixed(2)))}>＋</button>
                </span>
              </>
            ) : (
              <>
                <span
                  onClick={() => setShowWordCountModal(true)}
                  style={{ cursor: 'pointer', fontWeight: 500 }}
                  title="点击查看详细字数与排版统计"
                >
                  {metrics.cjkCount + metrics.wordsCount} 字 • {metrics.charWithSpaces} 字符 • {metrics.lines} 行
                </span>
                <span className="sep">•</span>
                <span>预估阅读 ~{metrics.readingMinutes} 分钟</span>
                <span className="sep">•</span>
                <span>{isSourceMode ? '源码模式' : '沉浸排版'}</span>
                {isFocusMode && <><span className="sep">•</span><span className="status-pill-badge">专注模式</span></>}
                {isTypewriterMode && <><span className="sep">•</span><span className="status-pill-badge">打字机模式</span></>}
                {zoomLevel !== 1 && <><span className="sep">•</span><span>缩放: {Math.round(zoomLevel * 100)}%</span></>}
              </>
            )}
          </div>
          <div className="status-right">
            {activeFile?.kind === 'pdf' ? (
              <>
                <span>PDF 文档</span>
                <span className="sep">•</span>
                <span className="status-badge">Ctrl + S 保存（标注可再编辑）</span>
              </>
            ) : (
              <>
                <span>对齐: {typography.textAlign === 'justify' ? '两端对齐' : '左对齐'}</span>
                <span className="sep">•</span>
                <span>UTF-8</span>
                <span className="sep">•</span>
                <span className="status-badge" onClick={toggleSourceMode} style={{ cursor: 'pointer' }}>
                  Ctrl + / 切换
                </span>
              </>
            )}
          </div>
        </footer>
      )}

      {/* Right-click menus: tabs = document actions, paper = output actions */}
      {contextMenu && (
        <>
          <div
            className="ctx-menu-backdrop"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div ref={ctxMenuRef} className="ctx-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu">
            {buildMenu(contextMenu.target).map((item) => (
              <React.Fragment key={item.id}>
                {item.dividerBefore && <div className="dropdown-divider" />}
                <ContextMenuItem item={item} ctx={contextMenu.target} onRun={runContextAction} />
              </React.Fragment>
            ))}
          </div>
        </>
      )}

      {/* Auto-update dialog: shown only when the user asks, or after a manual check */}
      {showUpdateModal && (
        <div className="typo-modal-overlay" onClick={() => { if (!updateProgress) setShowUpdateModal(false); }}>
          <div className="typo-modal-box update-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>软件更新</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => { if (!updateProgress) setShowUpdateModal(false); }}>×</button>
            </div>
            <div className="typo-modal-body update-body">
              {updateInfo.status === 'checking' && <p className="update-line">正在检查更新…</p>}

              {updateInfo.status === 'none' && (
                <p className="update-line">已是最新版本 ✓（当前 {APP_VERSION}）</p>
              )}

              {updateInfo.status === 'error' && (
                <>
                  <p className="update-line">检查更新失败 ✗</p>
                  <p className="update-detail">{updateInfo.error}</p>
                  <p className="update-hint">
                    请确认更新源已配置（<code>tauri.conf.json → plugins.updater.endpoints</code>）
                    且网络可达；未配置时不影响正常使用。
                  </p>
                </>
              )}

              {updateInfo.status === 'available' && (
                <>
                  <p className="update-line">
                    发现新版本 <strong>{updateInfo.version}</strong>
                    <span className="update-dim">（当前 {updateInfo.currentVersion || APP_VERSION}）</span>
                  </p>
                  {updateInfo.notes ? <pre className="update-notes">{updateInfo.notes}</pre> : null}
                  {updateProgress && (
                    <div className="update-progress">
                      <div className="update-progress-track">
                        <div
                          className="update-progress-bar"
                          style={{ width: `${Math.round((updateProgress.ratio ?? 0) * 100)}%` }}
                        />
                      </div>
                      <span className="update-progress-label">
                        {updateProgress.phase === 'downloading'
                          ? `下载中 ${Math.round((updateProgress.ratio ?? 0) * 100)}%`
                          : updateProgress.phase === 'installing'
                            ? '正在安装…'
                            : '安装完成，正在重启…'}
                      </span>
                    </div>
                  )}
                  {updateInstallError && <p className="update-error">安装失败：{updateInstallError}</p>}
                  <p className="update-hint">
                    更新包经过签名校验；安装程序会保持当前安装位置与文件关联。
                  </p>
                </>
              )}
            </div>
            {updateInfo.status === 'available' && (
              <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button className="typora-btn" onClick={() => setShowUpdateModal(false)} disabled={!!updateProgress}>
                  稍后
                </button>
                <button className="typora-btn typora-btn-primary" onClick={() => void startUpdateInstall()} disabled={!!updateProgress}>
                  {updateProgress ? '正在更新…' : '下载并安装'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

            {/* Drag & Drop Visual Feedback Overlay */}
      {isDragging && (
        <div className="drag-drop-overlay">
          <div className="drag-drop-badge">
            <MarkdownXLogo size={36} />
            <span>释放鼠标以打开此 Markdown 文档</span>
            <span className="drag-drop-subtext">支持 .md、.markdown、.txt 文件直接拖入</span>
          </div>
        </div>
      )}

      {/* Word Count Modal (字数统计详细窗口) */}
      {showWordCountModal && (
        <div className="typo-modal-overlay" onClick={() => setShowWordCountModal(false)}>
          <div className="typo-modal-box word-count-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>📊 文档统计与度量 (Word Count & Metrics)</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowWordCountModal(false)}>×</button>
            </div>
            <div className="typo-modal-body">
              <div className="metrics-grid">
                <div className="metric-card">
                  <div className="metric-val">{metrics.cjkCount + metrics.wordsCount}</div>
                  <div className="metric-label">总字数 (中文字 + 英文单词)</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">{metrics.charWithSpaces}</div>
                  <div className="metric-label">字符数 (计空格)</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">{metrics.charNoSpaces}</div>
                  <div className="metric-label">字符数 (不计空格)</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">{metrics.lines}</div>
                  <div className="metric-label">总物理行数</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">{metrics.paragraphs}</div>
                  <div className="metric-label">自然段落数</div>
                </div>
                <div className="metric-card">
                  <div className="metric-val">~{metrics.readingMinutes} 分钟</div>
                  <div className="metric-label">预估阅读时间</div>
                </div>
              </div>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="typora-btn typora-btn-primary" onClick={() => setShowWordCountModal(false)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Help Modal (快捷键速查手册) */}
      {showHelpModal && (
        <div className="typo-modal-overlay" onClick={() => setShowHelpModal(false)}>
          <div className="typo-modal-box help-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>⌨️ MarkdownX 快捷键速查手册</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowHelpModal(false)}>×</button>
            </div>
            <div className="typo-modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              <table className="shortcuts-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1.5px solid var(--border-strong)', textAlign: 'left' }}>
                    <th style={{ padding: '8px' }}>操作功能</th>
                    <th style={{ padding: '8px' }}>快捷键</th>
                    <th style={{ padding: '8px' }}>所属分类</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td style={{ padding: '6px 8px' }}>显示 / 隐藏侧边栏</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + L</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>大纲面板</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + 1</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>文档列表</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + 2</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>文件树</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + 3</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>全文搜索与替换</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + F</code></td><td>视图导航</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>源代码 / 排版模式切换</td><td style={{ padding: '6px 8px' }}><code>Ctrl + /</code></td><td>编辑模式</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>专注模式</td><td style={{ padding: '6px 8px' }}><code>F8</code></td><td>沉浸写作</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>打字机模式</td><td style={{ padding: '6px 8px' }}><code>F9</code></td><td>沉浸写作</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>切换全屏</td><td style={{ padding: '6px 8px' }}><code>F11</code></td><td>窗口控制</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>实际大小 (100%)</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + 9</code></td><td>视图缩放</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>放大 / 缩小视图</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + = / -</code></td><td>视图缩放</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>应用内标签页切换</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Tab</code></td><td>窗口控制</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>排版与偏好设置</td><td style={{ padding: '6px 8px' }}><code>Ctrl + ,</code></td><td>偏好设置</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>新建 / 打开 / 保存</td><td style={{ padding: '6px 8px' }}><code>Ctrl + N / O / S</code></td><td>文件操作</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>另存为</td><td style={{ padding: '6px 8px' }}><code>Ctrl + Shift + S</code></td><td>文件操作</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>打印 / 导出 PDF</td><td style={{ padding: '6px 8px' }}><code>Ctrl + P</code></td><td>文件导出</td></tr>
                  <tr><td style={{ padding: '6px 8px' }}>开发者工具</td><td style={{ padding: '6px 8px' }}><code>Shift + F12</code></td><td>系统调试</td></tr>
                </tbody>
              </table>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="typora-btn typora-btn-primary" onClick={() => setShowHelpModal(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LaTeX & Math Help Modal */}
      {showMathHelpModal && (
        <div className="typo-modal-overlay" onClick={() => setShowMathHelpModal(false)}>
          <div className="typo-modal-box help-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>📐 LaTeX 公式与学术排版规范</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowMathHelpModal(false)}>×</button>
            </div>
            <div className="typo-modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              <div style={{ lineHeight: 1.7, fontSize: '13.5px' }}>
                <h4 style={{ margin: '8px 0 4px', color: 'var(--color-primary)' }}>1. 行内数学公式</h4>
                <p>使用单美元符包裹：<code>{'$E = mc^2$'}</code> 或 <code>{'$\sigma_{ij} = C_{ijkl} \varepsilon_{kl}$'}</code></p>
                <h4 style={{ margin: '14px 0 4px', color: 'var(--color-primary)' }}>2. 独立块级公式</h4>
                <p>使用双美元符包裹，并可附加 <code>\tag&#123;1&#125;</code> 编号：</p>
                <pre style={{ background: 'var(--bg-code)', padding: '8px 12px', borderRadius: '4px' }}>
{`$$
\nabla \cdot \boldsymbol{\sigma} + \mathbf{b} = \rho \ddot{\mathbf{u}} \tag{1}
$$`}
                </pre>
                <h4 style={{ margin: '14px 0 4px', color: 'var(--color-primary)' }}>3. 学术三线表 (Booktabs)</h4>
                <p>标准 Markdown 表格会自动以出版级三线表规范呈现：顶底为 2.2px 加粗线，表头下方为 1.2px 细线。</p>
              </div>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="typora-btn typora-btn-primary" onClick={() => setShowMathHelpModal(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* About Modal — version, release notes, licence, build date, tech stack */}
      {showAboutModal && (
        <div className="typo-modal-overlay" onClick={() => setShowAboutModal(false)}>
          <div className="typo-modal-box about-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>关于 MarkdownX</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowAboutModal(false)}>×</button>
            </div>
            <div className="typo-modal-body about-body">
              <div className="about-head">
                <MarkdownXLogo size={52} />
                <h2 className="about-name">MarkdownX</h2>
                <p className="about-version">
                  <strong>{APP_VERSION}</strong>
                  <span className="about-dim"> · 构建于 {APP_BUILD_DATE}</span>
                </p>
                <p className="about-tagline">
                  专为计算力学与科研论文打造的轻量级 Markdown 写作软件。<br />
                  支持原生公式排版、三线表规范、多级大纲与科研级多格式导出。
                </p>
              </div>

              <div className="about-section-title">本次更新 · {RELEASE_NOTES[0].version}（{RELEASE_NOTES[0].date}）</div>
              <ul className="about-notes">
                {RELEASE_NOTES[0].items.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>

              <div className="about-section-title">近期版本</div>
              <div className="about-releases">
                {RELEASE_NOTES.slice(1).map((rel) => (
                  <div key={rel.version} className="about-release">
                    <div className="about-release-head">
                      <span className="about-release-ver">{rel.version}</span>
                      <span className="about-release-date">{rel.date}</span>
                    </div>
                    <ul className="about-notes">
                      {rel.items.map((it, i) => (
                        <li key={i}>{it}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="about-meta">
                <div className="about-meta-row">
                  <span className="about-meta-key">许可证</span>
                  <span className="about-meta-val">{APP_LICENSE}</span>
                </div>
                <div className="about-meta-row">
                  <span className="about-meta-key">更新时间</span>
                  <span className="about-meta-val">{APP_BUILD_DATE}</span>
                </div>
                <div className="about-meta-row">
                  <span className="about-meta-key">技术栈</span>
                  <span className="about-meta-val">{APP_TECH}</span>
                </div>
              </div>
            </div>
            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="typora-btn typora-btn-primary" onClick={() => setShowAboutModal(false)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Detailed Typography Configuration Modal */}
      {showTypographyModal && (
        <div className="typo-modal-overlay" onClick={() => setShowTypographyModal(false)}>
          <div className="typo-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="typo-modal-header">
              <div className="typo-modal-title">
                <span>⚙️ 程序设置 (Preferences)</span>
              </div>
              <button className="typo-modal-close-btn" onClick={() => setShowTypographyModal(false)}>
                ×
              </button>
            </div>

            <div className="typo-modal-body">
              {/* Group: 程序默认启动行为配置 */}
              <div className="typo-config-group">
                <div className="typo-group-title">程序默认启动设置 (Default Startup Settings)</div>
                
                <div className="typo-row">
                  <span className="typo-label">启动默认主题 (Default Theme):</span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'auto' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('auto'); setThemePref('auto'); }}
                      title="跟随操作系统：系统浅色→纯白，系统深色→极客深色"
                    >
                      🖥️ 跟随系统
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'light' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('light'); setThemePref('light'); }}
                    >
                      ☀️ 纯白
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'dark' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('dark'); setThemePref('dark'); }}
                    >
                      🌙 深色
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultThemeSetting === 'sepia' ? 'active' : ''}`}
                      onClick={() => { setDefaultThemeSetting('sepia'); setThemePref('sepia'); }}
                    >
                      📜 原木
                    </button>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">启动默认视图 (Default View):</span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${defaultModeSetting === 'typora' ? 'active' : ''}`}
                      onClick={() => setDefaultModeSetting('typora')}
                    >
                      沉浸排版模式
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultModeSetting === 'source' ? 'active' : ''}`}
                      onClick={() => setDefaultModeSetting('source')}
                    >
                      纯源码模式
                    </button>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">公式渲染引擎 (Math Engine): <span style={{ fontSize: "11px", color: "#10b981", fontWeight: 600 }}>[已支持离线打包]</span></span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${defaultMathEngineSetting === 'svg' ? 'active' : ''}`}
                      onClick={() => {
                        setDefaultMathEngineSetting('svg');
                        try {
                          localStorage.setItem('markdownx_math_engine', 'svg');
                          setModalFeedback('✓ 已设为【矢量 SVG 模式】（默认推荐：行内分式不重叠）。');
                        } catch {}
                      }}
                      title="推荐：高保真矢量渲染，行内高分式自然对齐，绝不与上下行文字重叠"
                    >
                      📐 矢量 SVG (默认推荐)
                    </button>
                    <button
                      className={`typo-radio-btn ${defaultMathEngineSetting === 'chtml' ? 'active' : ''}`}
                      onClick={() => {
                        setDefaultMathEngineSetting('chtml');
                        try {
                          localStorage.setItem('markdownx_math_engine', 'chtml');
                          setModalFeedback('✓ 已设为【高速 CHTML 模式】（体积仅 1MB，极速启动秒开）。');
                        } catch {}
                      }}
                      title="高速秒开：仅 1.1MB，加载极快，纯轻量级渲染"
                    >
                      ⚡ 高速 CHTML
                    </button>
                  </div>
                </div>

                <div className="typo-row">
                  <span className="typo-label">外部修改监控 (File Watcher): <span style={{ fontSize: "11px", color: "#10b981", fontWeight: 600 }}>[Rust 原生]</span></span>
                  <div className="typo-radio-toggle">
                    <button
                      className={`typo-radio-btn ${autoWatchSetting ? 'active' : ''}`}
                      onClick={() => {
                        setAutoWatchSetting(true);
                        setModalFeedback('✓ 已开启外部文件变更监控（实时感知外部修改与防冲突保护）。');
                      }}
                      title="实时监控已打开文件的磁盘变动，无修改时自动重载，有修改时弹出防冲突提示"
                    >
                      🟢 开启实时监控 (推荐)
                    </button>
                    <button
                      className={`typo-radio-btn ${!autoWatchSetting ? 'active' : ''}`}
                      onClick={() => {
                        setAutoWatchSetting(false);
                        setModalFeedback('✓ 已关闭外部文件变更监控。');
                      }}
                      title="关闭对外部磁盘文件变动的实时监听"
                    >
                      ⚪ 关闭监控
                    </button>
                  </div>
                </div>
              </div>

              {/* Feedback toast banner */}
              {modalFeedback && (
                <div style={{
                  padding: '8px 14px',
                  backgroundColor: '#ecfdf5',
                  color: '#065f46',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: 500,
                  border: '1px solid #a7f3d0',
                  textAlign: 'center'
                }}>
                  {modalFeedback}
                </div>
              )}
            </div>

            <div className="typo-modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                className="typora-btn"
                style={{ color: '#ef4444' }}
                onClick={handleResetFactoryDefaults}
                title="清除所有自定义偏好，重置为出厂设置"
              >
                🔄 恢复出厂设置
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="typora-btn"
                  onClick={handleSaveAsProgramDefaults}
                  title="将当前主题、视图、公式引擎等固化为软件启动时的全局默认配置"
                >
                  ⭐ 设为程序默认值
                </button>
                <button
                  className="typora-btn typora-btn-primary"
                  onClick={() => setShowTypographyModal(false)}
                >
                  完成
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
