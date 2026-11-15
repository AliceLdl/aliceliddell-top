# fonts/ —— 像素字体（「重度依赖 / raincandy」主题用）

| 文件 | 说明 | 许可 |
|---|---|---|
| （内嵌在 index.html 里的 base64 WOFF2） | **丁卯点阵体 / Dinkie Bitmap**（atelierAnchor，Willie Liu）试用版子集，12px 网格，2660 个字形 | 试用版：仅限非商业使用，不得修改/转换原始字体文件 |
| `fusion-pixel-12px-sc.woff2` | **缝合像素字体 / Fusion Pixel 12px Proportional SC**（TakWolf），31345 个字形，同 12px 像素网格；作为缺字兜底 | SIL Open Font License 1.1（见 `FusionPixel-LICENSE.txt`） |

## 为什么需要补字

丁卯点阵体官方只发布 7px / 9px 试用版（内含 2501 个汉字），完整版需向 atelierAnchor 申请授权。
内嵌子集在本作实际用到的 2665 个字符里缺 95 个（其中 46 个汉字，如「俗 俱 價 僻 卯 叹 吻 唱 囊 宏 寓 寿 岭 怪」等），
在「重度依赖」主题下会显示成空白/方框。

解决办法不是替换字形，而是**补一条同规格的兜底字体链**：

```
--rc-font: "DinkieBitmap", "FusionPixel12", "Zpix", "MS Gothic",
           "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB",
           "Segoe UI Symbol", "Noto Sans Symbols 2", "Segoe UI Emoji", "Noto Color Emoji",
           ui-monospace, monospace;
```

浏览器按字符逐字回退：Dinkie 有的字仍用 Dinkie 的像素字形，缺的字落到 FusionPixel12（同样 12px 网格，视觉一致），
剩下的数学符号与 emoji（∓ √ ≈ ⏱ ♻ ⚖ ⚠ ✓ ✔ ✕ ✗ 🌀 🌹 🏛 👍 💬 📊 🔁 🔥 🕊 🚩 🦅 🧩 等 27 个）交给系统符号/emoji 字体。

实测（fontTools 比对 cmap）：整条字体栈在 Windows 上**缺字 0 个**。

## 换成完整版丁卯点阵体

如果你拿到了完整版 `DinkieBitmap.ttf`（商业授权版），把它放到本目录，并把 `index.html` 里那条 `@font-face` 改成：

```css
@font-face{
  font-family:"DinkieBitmap";
  src:url(fonts/DinkieBitmap.ttf) format("truetype");   /* 本地完整版优先 */
  font-display:swap;
}
```

保留 `FusionPixel12` 作为后备即可——完整版也不一定覆盖全部 emoji 与数学符号。

> 注意：`fonts/` 目录要跟着 `index.html` 一起部署；只拷单文件 HTML 时会退回内嵌子集 + 系统字体，
> 缺字会重新出现（但没有字体文件也不会报错，只是回到旧样子）。
