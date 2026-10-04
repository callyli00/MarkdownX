# 出版社公式与双击定位 验证文档 (v1.8.5)

以下内容与真实书籍章节的 HTML 导出格式一致，用于验证三项修复：
① `<span class="math math-inline">` 包裹的裸 LaTeX 公式（图注内）正常排版；
② 双击任意位置跳转到源码中**点击处**（字符级），重复文本也不串位；
③ 跳转后源码视图出现**落点高亮**（呼吸脉冲 + 光标列指示条），返回预览时目标块闪烁提示。

## 一、重复段落测试（旧逻辑必错、新逻辑必对）

重复的段落内容——这句话在本文出现两次。

重复的段落内容——这句话在本文出现两次。

（请分别双击第一处与第二处的"重复的段落内容"：源码光标应分别落在各自所在行，绝不串到另一处。）

## 二、长段落折行测试（高亮落点必须贴着点击的那一行）

这是一段故意写得很长的正文，用来验证跳转高亮在折行场景下的准确性：当你双击本段靠后的词句时，源码视图的高亮条必须出现在该词所在的**视觉行**上，而不是按"逻辑行号 × 行高"估算出来的错误位置。排版时本段会在版心内折成多行，旧算法会随着折行数不断累积偏差，可能高出好几行；新实现用镜像测量真实光标位置，无论本段折成多少行，高亮都应准确贴合。请双击本段最后几个词试试，例如"准确贴合"这四个字。

## 三、图注公式与图形区域

<figure>
<img src="images/ch02-011.jpg" alt="FIG. 2.8. Illustration of twist and bend distortions in nematic liquid crystals. Vectors show orientations of the director at one point in space, \boldsymbol{n}(\boldsymbol{r}) , and a distance \delta r away, the small change \delta n and the direction of local curl n. For twist (a) deformation one obtains n \parallel \operatorname{curl} n , for bend (b) n \perp \operatorname{curl} n ." width="489" height="273" style="width: 489px; max-width: 100%; height: auto;">  
<figcaption>FIG. 2.8. Illustration of twist and bend distortions in nematic liquid crystals. Vectors show orientations of the director at one point in space, <span class="math math-inline">\boldsymbol{n}(\boldsymbol{r})</span> , and a distance <span class="math math-inline">\delta r</span> away, the small change <span class="math math-inline">\delta n</span> and the direction of local curl n. For twist (a) deformation one obtains <span class="math math-inline">n \parallel \operatorname{curl} n</span> , for bend (b) <span class="math math-inline">n \perp \operatorname{curl} n</span> .</figcaption>
</figure>

（双击图注任意词语应落到 `<figcaption>` 所在行；双击图片本体应落到 `<img>` 行；双击上方公式应落到对应公式源码处。）

## 四、四种公式写法混排

行内美元 $K_1$、行内圆括号 \(K_2\)、下方块级公式：

$$\mathcal{F} = \tfrac{1}{2} K_1 (\nabla \cdot \boldsymbol{n})^2 + \tfrac{1}{2} K_2 (\boldsymbol{n} \cdot \nabla \times \boldsymbol{n})^2 + \tfrac{1}{2} K_3 |\boldsymbol{n} \times \nabla \times \boldsymbol{n}|^2$$

（双击块级公式本体应落到该公式的 `$$` 起始处。）

## 五、双向跳转高亮

- 双击任意位置进入源码：落点行出现蓝色呼吸高亮 + 光标列指示条，约 2.5 秒渐隐；期间滚动文本时高亮跟随。
- 按 `Ctrl + /` 或双击切回预览：刚才编辑的块会闪烁一次，提醒你回到哪里。

测试成功。
