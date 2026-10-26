// 预览渲染吞吐基准：node tools/local-check/bench-preview.mjs
// 测渲染器本身（marked + 我们的后处理），不含 MathJax 排版与 mermaid。
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./src/utils/markdownRenderer.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  outfile: 'C:/tmp/mdx-bench-renderer.mjs',
  plugins: [{
    name: 'stub-tauri',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'tauri-stub', namespace: 'bench-stub' }));
      b.onLoad({ filter: /.*/, namespace: 'bench-stub' }, () => ({
        contents: 'export function convertFileSrc(p){return p}\nexport const invoke = async () => null;',
        loader: 'js'
      }));
    }
  }]
});

const { renderMarkdownPayload } = await import('file:///C:/tmp/mdx-bench-renderer.mjs');
const para = '计算力学里的应力张量与应变张量通过本构关系联系。';
const bigProse = Array.from({ length: 900 }, (_, i) => para + '第 ' + i + ' 段，包含 **粗体** 与 `代码`。').join('\n\n');
const mathDoc = Array.from({ length: 120 }, (_, i) => [
  '## 小节 ' + i,
  '行内公式 $a_{' + i + '} + b_{' + i + '} = c_{' + i + '}$ 与另一个 $\sigma_{ij}$。',
  '$$\int_0^1 f_' + i + '(x)\,dx = \frac{1}{' + (i + 1) + '} \label{eq:' + i + '}$$',
  '引用见 \eqref{eq:' + i + '}，以及 [[笔记' + i + ']] 与 #标签' + (i % 5) + '。'
].join('\n\n')).join('\n\n');
const tableDoc = '| col | 值 |\n|---|---|\n' + Array.from({ length: 300 }, (_, i) => '| 行' + i + ' | ' + i + ' |').join('\n');

for (const [label, src] of [['纯文本 100 KB', bigProse], ['公式密集 120 行间+240 行内', mathDoc], ['表格 300 行', tableDoc]]) {
  const runs = [];
  let htmlLen = 0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const html = await renderMarkdownPayload(src);
    runs.push(performance.now() - t);
    htmlLen = html.length;
  }
  runs.sort((a, b) => a - b);
  console.log(label + '：输入 ' + Math.round(src.length / 1024) + ' KB → HTML ' + Math.round(htmlLen / 1024) + ' KB，耗时中位数 ' + Math.round(runs[1]) + ' ms（快 ' + Math.round(runs[0]) + ' / 慢 ' + Math.round(runs[2]) + '）');
}
