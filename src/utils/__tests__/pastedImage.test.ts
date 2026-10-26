import { describe, expect, it } from 'vitest';
import { imageExtension, imageMarkdown, insertTextAtSelection, pastedImageFileName } from '../pastedImage';

const at = new Date(2026, 9, 26, 16, 50, 12); // 2026-10-26 16:50:12 本地时间

describe('imageExtension', () => {
  it('常见图片 MIME 映射到扩展名', () => {
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/webp')).toBe('webp');
    expect(imageExtension('image/svg+xml')).toBe('svg');
  });

  it('带参数与小写化', () => {
    expect(imageExtension('IMAGE/PNG; charset=binary')).toBe('png');
  });

  it('非图片返回 null', () => {
    expect(imageExtension('application/pdf')).toBeNull();
    expect(imageExtension('')).toBeNull();
  });
});

describe('pastedImageFileName', () => {
  it('时间戳 + 种子 + 扩展名', () => {
    expect(pastedImageFileName('image/png', at, 'a1b2c3')).toBe('pasted-20261026-165012-a1b2c3.png');
  });

  it('种子被清洗成小写字母数字', () => {
    expect(pastedImageFileName('image/jpeg', at, 'A-B_C/9')).toBe('pasted-20261026-165012-abc9.jpg');
  });

  it('没有种子也能给出合法名字', () => {
    expect(pastedImageFileName('image/png', at, '')).toBe('pasted-20261026-165012-0000.png');
  });

  it('名字里没有空格与冒号（Windows/安卓都能用）', () => {
    const name = pastedImageFileName('image/gif', at, 'zz');
    expect(name).toBe('pasted-20261026-165012-zz.gif');
    expect(/[ :\\/]/.test(String(name))).toBe(false);
  });

  it('非图片 MIME 返回 null（绝不猜扩展名）', () => {
    expect(pastedImageFileName('text/plain', at, 'x')).toBeNull();
  });
});

describe('imageMarkdown', () => {
  it('普通相对路径', () => {
    expect(imageMarkdown('assets/pasted-1.png')).toBe('![](assets/pasted-1.png)');
  });

  it('反斜杠换成斜杠（文档内容是 POSIX 风格）', () => {
    expect(imageMarkdown('assets\\pasted-1.png')).toBe('![](assets/pasted-1.png)');
  });

  it('含空格的路径用尖括号包住', () => {
    expect(imageMarkdown('my assets/a.png')).toBe('![](<my assets/a.png>)');
  });

  it('alt 文本里的引号不会破坏语法', () => {
    expect(imageMarkdown('a.png', '他说"好"')).toBe('![](a.png "他说\'好\'")');
  });
});

describe('insertTextAtSelection', () => {
  it('在光标处插入并返回新光标位置', () => {
    const result = insertTextAtSelection('ab\n', 3, 3, '![](x.png)');
    expect(result.content).toBe('ab\n![](x.png)');
    expect(result.caret).toBe('ab\n![](x.png)'.length);
  });

  it('选区被替换（前面不在一行开头，先补换行）', () => {
    const result = insertTextAtSelection('hello world', 6, 11, '![](x.png)');
    expect(result.content).toBe('hello \n![](x.png)');
  });

  it('行内粘贴两侧都补换行（图片是块级元素）', () => {
    const result = insertTextAtSelection('文字：后面', 3, 3, '![](x.png)');
    expect(result.content).toBe('文字：\n![](x.png)\n后面');
  });

  it('段首粘贴只在后面补换行', () => {
    const text = '第一段\n第二段';
    const result = insertTextAtSelection(text, 4, 4, '![](x.png)');
    expect(result.content).toBe('第一段\n![](x.png)\n第二段');
  });

  it('文档开头粘贴不会粘住正文', () => {
    const result = insertTextAtSelection('# 标题\n正文', 0, 0, '![](x.png)');
    expect(result.content).toBe('![](x.png)\n# 标题\n正文');
    expect(result.caret).toBe('![](x.png)\n'.length);
  });

  it('越界的光标被夹回文本范围', () => {
    const result = insertTextAtSelection('abc', 99, 99, '!');
    expect(result.content).toBe('abc\n!');
    expect(result.caret).toBe(5);
  });

  it('空文本也能插入', () => {
    const result = insertTextAtSelection('', 0, 0, '![](x.png)');
    expect(result.content).toBe('![](x.png)');
  });
});
