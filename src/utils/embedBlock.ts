/**
 * `![[note#^blockid]]` / `![[note#标题]]` 的片段提取。
 *
 * 本模块是纯函数：不读文件、不碰 DOM，宿主把「已加载的整篇正文」交进来，这里切出要嵌入
 * 的那一段。这样主线程和渲染 Worker 两条渲染路径拿到的是同一个字符串，输出逐字节一致
 * （tools/render-equivalence-gate 依赖这条性质）。
 *
 * 取不到就返回 null —— 由调用方渲染「未找到」壳。**绝不**退化成整篇：把整篇烘进当前文档
 * 正是本次要修的 bug，静默降级会让人以为锚点生效了。
 *
 * 与 `workspaceIndex.scanBlockIds` 口径一致：围栏代码（以及行内代码）里的 `^id` 是示例文本，
 * 不是锚点。掩码复用 wikiLink.maskFencedCode，掩码只把字节换成等长空格，因此掩码行与原文行
 * 的下标一一对齐，可以「用掩码行判定、用原文行取内容」。
 */

import { maskFencedCode } from './wikiLink';

/** 块 id 的合法字符集，与 parseWikiLink 接受的范围保持一致。 */
const BLOCK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 行尾块标记：`^id`，允许前置空白（含行首独占一整行）、允许尾随水平空白。 */
const BLOCK_MARKER_RE = /(?:^|[ \t])\^([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*$/;

/** ATX 标题：最多 3 个前导空格 + 1~6 个 `#` + 至少一个空白分隔 + 文字。 */
const HEADING_RE = /^( {0,3})(#{1,6})([ \t]+)(.*)$/;

/** 一行「空行」的判定：只有空白（含行尾 \r）就当作分隔。 */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * 把正文切成「原文行 + 掩码行」两套等长数组。
 *
 * maskFencedCode 只按 `\n` 切分，所以 CRLF 文档的掩码结果里每行尾部会留一个 `\r`；这里再按
 * `/\r?\n/` 切一次把它去掉。掩码不改变换行符，两次切分的行数必然相同。
 */
function lineViews(content: string): { source: string[]; masked: string[] } {
  const text = typeof content === 'string' ? content : '';
  return {
    source: text.split(/\r?\n/),
    masked: maskFencedCode(text).split(/\r?\n/)
  };
}

/** 去掉首尾的空行（不碰中间的空行，段落间距属于正文）。 */
function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start])) start++;
  while (end > start && isBlank(lines[end - 1])) end--;
  return lines.slice(start, end);
}

/** 比对用的标题归一化：忽略首尾空白、大小写不敏感（`#` 的数量不参与比对）。 */
function normalizeHeading(text: string): string {
  return String(text ?? '').trim().toLowerCase();
}

/**
 * 抽出 `^id` 所在的块。
 *
 * 块 = 连续非空行，因此段落、列表项（含续行）、引用块、表格、包裹围栏代码的整段、标题行
 * 都天然落在同一个块里；空行是唯一的分隔符。
 *
 * @returns 去掉标记、去掉首尾空行的原文（换行统一成 `\n`）；id 非法或找不到时返回 null。
 *          块存在但去掉标记后没有内容时返回 ''（是「找到但是空的」，不是「找不到」）。
 */
export function extractBlock(content: string, id: string): string | null {
  const wanted = String(id ?? '').trim();
  // id 非法就当找不到：调用方据此渲染「未找到区块」壳，而不是去猜一个相近的块。
  if (!BLOCK_ID_RE.test(wanted)) return null;

  const { source, masked } = lineViews(content);
  const needle = wanted.toLowerCase();

  let hit = -1;
  for (let i = 0; i < masked.length; i++) {
    const m = BLOCK_MARKER_RE.exec(masked[i]);
    if (!m) continue;
    // 块 id 按大小写不敏感比对，与 scanBlockIds 的去重口径一致。
    if (m[1].toLowerCase() === needle) {
      hit = i;
      break;
    }
  }
  if (hit === -1) return null;

  // 向两侧扩到空行为止：这是「块」的边界。
  let start = hit;
  while (start > 0 && !isBlank(source[start - 1])) start--;
  let end = hit;
  while (end + 1 < source.length && !isBlank(source[end + 1])) end++;

  const lines = source.slice(start, end + 1);
  // 只删命中行上的标记；块内其它行（例如代码示例里出现的 `^x`）原样保留。
  lines[hit - start] = lines[hit - start].replace(BLOCK_MARKER_RE, '');
  return trimBlankLines(lines).join('\n');
}

interface HeadingLine {
  /** 行下标（0 基，与 sourceLines 对齐）。 */
  line: number;
  level: number;
  /** 归一化后的标题文字。 */
  text: string;
}

/** 收集所有标题行；围栏代码里的 `#` 已被掩码成空格，因此不会误判。 */
function collectHeadings(source: string[], masked: string[]): HeadingLine[] {
  const out: HeadingLine[] = [];
  const total = Math.min(source.length, masked.length);
  for (let i = 0; i < total; i++) {
    const m = HEADING_RE.exec(masked[i]);
    if (!m) continue;
    // 掩码只把行内代码换成等长空格，所以 `#` 前缀长度在原文里同样成立；但标题文字必须取自
    // 原文——否则「标题里带行内代码」的章节永远匹配不上。
    const prefixLength = m[1].length + m[2].length + m[3].length;
    const text = normalizeHeading(source[i].slice(prefixLength));
    if (!text) continue;
    out.push({ line: i, level: m[2].length, text });
  }
  return out;
}

/**
 * 抽出 `#heading` 指向的章节。
 *
 * 章节 = 标题行之后、到下一个「同级或更高级」标题之前的所有行。**不含标题行本身**：嵌入
 * 侧的表头已经标明了来源，把标题再渲染一遍会出现双层标题。同名标题取第一个。
 *
 * 取舍：末尾空行按需求裁掉，开头紧随标题的那个空行也一并裁掉（章节正文从内容开始更自然，
 * 且渲染成 <div> 后首行空行没有任何语义）。
 *
 * @returns 章节正文（换行统一成 `\n`）；找不到或标题非法时返回 null。
 */
export function extractSection(content: string, headingText: string): string | null {
  const wanted = normalizeHeading(headingText);
  // 空标题没法定位（也没法给出有意义的文案），直接当找不到。
  if (!wanted) return null;

  const { source, masked } = lineViews(content);
  const headings = collectHeadings(source, masked);
  const hit = headings.find((heading) => heading.text === wanted);
  if (!hit) return null;

  // 同级或更高级的标题表示章节结束；更深的标题是本章节的子结构，要一起带上。
  let end = source.length;
  for (const heading of headings) {
    if (heading.line > hit.line && heading.level <= hit.level) {
      end = heading.line;
      break;
    }
  }
  return trimBlankLines(source.slice(hit.line + 1, end)).join('\n');
}
