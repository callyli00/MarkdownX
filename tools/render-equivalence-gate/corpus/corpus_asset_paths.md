# 资产路径等价性用例（延迟改写风险点）

本文件专用于验证"Worker 出未改写 HTML、主线程做最后一遍改写"与原路径逐字节一致。

## 1. Markdown 语法图片（相对路径）

![相对路径图](images/ch02-011.jpg)

![带空格的相对路径](figures/图 3-1 微观形貌.png)

![带标题的图](images/ch03-002.jpg "图 3-2 断口形貌")

## 2. 原始 HTML 图片（相对路径）

<figure>
  <img src="images/ch02-011.jpg" alt="原始 HTML 相对路径" style="width: 60%;" />
  <figcaption>图 3-3 原始 HTML 写法</figcaption>
</figure>

## 3. 远程 / data / asset 前缀（不应被改写）

![远程图片](https://example.org/figures/remote.png)

<img src="data:image/png;base64,iVBORw0KGgo=" alt="内联图" />

<img src="asset://localhost/C:/already/absolute.png" alt="已是 asset URL" />

## 4. 绝对路径

![绝对路径图](C:/docs/book/images/abs.png)

<img src="/rooted/images/rooted.png" alt="以斜杠开头" />

## 5. 与公式/图表混排（确认哨兵与 token 还原不受影响）

设定应力张量 $\sigma_{ij}$ 与应变 $\varepsilon_{kl}$ 满足

$$\sigma_{ij} = C_{ijkl}\,\varepsilon_{kl} \tag{A.1}$$

其中 $C_{ijkl}$ 为四阶弹性张量。图见 @fig:ch02-011。

```python
# 代码块里出现 <img src="images/fake.jpg"> 也不应被改写
print("<img src='images/fake.jpg'>")
```

```mermaid
graph LR
  A[载荷] --> B[变形] --> C[应力] --> D[失效]
```