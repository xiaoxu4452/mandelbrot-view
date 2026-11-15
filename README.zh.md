# Mandelbrot View — 桌面核心，运行在浏览器里

交互式 Mandelbrot / Julia 观测器，渲染器是**编译成 WebAssembly 的桌面 C++
核心**——与 [Meter-Mandelbrot-Desktop](https://github.com/xiaoxu4452/Meter-Mandelbrot-Desktop)
使用同一批翻译单元（扰动、级数近似、周期参考轨道、glitch 修复、自研 BigFloat
后端）。

**在线地址**：<https://xiaoxu4452.github.io/mandelbrot-view/> ·
English: [README.md](README.md)

界面用的是观测器原本那套成熟 UI，外观、工具栏、调色板、预设库、HUD、手势全部
没有改动；换掉的只是底下那颗“大脑”——原来用 JavaScript 逐像素迭代的引擎被
`core.wasm` 取代。界面不由核心生成，核心也不由页面重新实现。

![核心渲染的海马螺旋](docs/hero-deep.jpg)

---

## 结构

```
page (js/app.js)            js/webcore-worker.js        core.wasm (C++ → wasm32-wasi)
 ┌──────────────┐  postMessage ┌────────────────┐  mb_render()  ┌──────────────────────┐
 │ canvas、HUD、│ ───────────▶ │ 全精度中心字符串│ ────────────▶ │ deep / reference /   │
 │ 调色板、手势 │ ◀─────────── │ 十进制缩放、尺寸│ ◀──────────── │ render / bigfloat /  │
 │              │  场 1×f32/px │ → field4       │  field4       │ viewport（桌面原件） │
 └──────────────┘              └────────────────┘               └──────────────────────┘
```

* **画面归页面，数学归核心。** 一帧请求携带：全精度十进制中心字符串（从不经过
  double）、画面的复平面宽度、像素尺寸、迭代预算。核心回四通道场
  `[平滑迭代, 距离, 迭代数, 0]`，内部用负的平滑值标记；页面把它换算成颜色位置
  （`smooth / cycle + offset`）再查自己的调色板表——所以配色、渐变、重着色缓存
  的行为与过去完全一致。
* **没有第二套算法。** 参考轨道选举、级数近似、rebase、glitch 修复（含 SA
  重放）、精度规划（`digits = log10(zoom) + 50`）都是桌面源码，由
  `webcore/build.mjs` 从桌面原件镜像并打断言补丁（`throw` → 错误标志、
  `<thread>` 桩、GMP → BigFloat 桩 + 周期轨道补丁）后编译。`webcore/test.mjs`
  与桌面 `mset.exe` 生成的 PNG 逐像素比对。
* **一帧一条参考轨道（按横带并行）。** 成帧仍是一次整幅请求：这里的 wasm 是单线程
  （GitHub Pages 给不了 COOP/COEP，没有 `SharedArrayBuffer`），所以把整帧切成横带、
  由 N 个 wasm 实例并行渲染。每条带共用**帧中心**的参考轨道和整帧的像素尺度，结果与
  单带渲染逐字节相同（`?bands=N` 固定切法，`?bands=1` 走串行）。深视点先出 0.34×
  预览，再出整帧。
* **核心不支持的公式自动回退**到页面自己的内核：multibrot 次幂、tricorn、
  burning ship、celtic、perpendicular、phoenix、Newton、距离着色、trap、
  自定义公式。HUD 会写明这一帧是哪个引擎画的（`CORE` / `WASM` / `GPU`）。
* **为手机适配**：单指拖动平移，双指围绕移动中的中点捏合缩放，`touch-action:
  none` 阻止浏览器抢手势；手机的像素预算降到桌面的三分之一，捏合不会卡死。

## 构建与验证

```bash
node webcore/build.mjs        # 核心源码 → core.wasm（需要 zig）
node webcore/test.mjs         # 与桌面 PNG 逐像素比对
node webcore/test-view.mjs    # 核心 viewport 的缩放/平移/捏合往返
node tools/_families-check.mjs    # 非曼德勃罗族：缩放往返
node tools/_preset-zoom-check.mjs # 预设放大：迭代预算不得失控
node server/static-server.mjs # http://127.0.0.1:8777/index.html
```

**C++ 核心源码就在本仓库里**：`webcore/src/` 是 wasm 构建实际编译的那批翻译单元与
头文件，所以只 clone 本仓库就能重建 `core.wasm`，不需要别的检出。
`node webcore/sync-src.mjs <路径>` 从桌面工程刷新这份副本；`MB_SRC=<路径>` 可以
直接对桌面工作树编译（作者本机就是这么做的；两者产出的 `core.wasm` 逐字节相同）。

### 实验性：任意公式核心

`formulacore/` 是一个**独立**的 C++ 核心，尚未接入页面。它把用户写的表达式
编译成字节码再渲染：

| 文件 | 内容 |
| --- | --- |
| `formulacore/core.cpp` | 复数初等函数库、Pratt 表达式编译器、栈式 VM、整帧渲染、C ABI |
| `formulacore/build.mjs` | zig -> wasm32-wasi（与 `webcore/` 同一工具链） |
| `formulacore/test.mjs` | `z^2+c` 与 Node 参考逐像素比对，外加 9 组嵌套函数用例 |

第一阶段每个像素用双精度直接迭代，只是表达式引擎的**正确性参照**。
`orbit.mjs` + `core.cpp:fc_render_perturb` 是第二阶段：**一条任意精度 BigInt
定点参考轨道**（按缩放取 80..360 位小数）、jet 系数、float-exp 像素偏移、
整帧共用的线性级数近似跳过、glitch 检测。`perturb-test.mjs` 用精确
Misiurewicz 点 c=i（任意深度都有结构）验证两个硬要求：

| 缩放 | 逐点双精度 | 扰动 + SA | saSkip | 帧耗时 |
| --- | --- | --- | --- | --- |
| 1e10 | 96 档 | 98 档 | 18 | 273.9 ms |
| 1e30 | **全黑** | 91 档 | 71 | 308.9 ms |
| 1e100 | **全黑** | 88 档 | 257 | 270.4 ms |
| 1e300 | **全黑** | 94 档 | 789 | 269.7 ms |

1e300 / 1e10 耗时比 **0.98×**：精度成本只随那一条轨道增长，与像素数无关；
浅景下扰动帧与逐点帧逐像素相同。

第二阶段第二部分接上了**通用表达式机制**。`env.js` 直接复用页面已有库，不重复造轮子：
`customenv.js` 用 `hpeval.js` 为任意表达式建**一条**任意精度 BigInt 参考轨道，
`jet.js` 沿该轨道做 1..10 阶自动微分（全纯映射）或中心差分线性导数（非全纯
`abs`/`conj`）；系数被重排成 C++ `fc_render_jet()` 的 `coefA`/`coefB`。新 ABI
支持运行时 jet 阶数、`y0/y1` 横带、以及 singleref glitch **rebase**（抵消时
重锚到与像素最接近的轨道点）。

`env.js` 给出宿主必须遵守的 `usable` 契约，为 false 时**不得采用扰动帧**：

| 条件 | 扰动为何无效 | 宿主动作 |
| --- | --- | --- |
| 参考轨道早于预算逃逸 | 剩余像素没有 `Z_n`（铁律 #1） | 直接双精度渲染 |
| 非多项式 / 对 c 非线性且深度 < 1e12 | 截断级数只在偏移量极小时成立 | 直接双精度渲染 |

这与桌面核心一致（浅景本就走 double 直算）；多项式的级数是有限的，任意深度都精确。

验收（`node formulacore/general-test.mjs`）：`z^2+c`/`z^3+c` 在 zoom 1 与逐点
渲染逐像素一致；`sin`/`exp`/`log`/`sin*cos`/嵌套/非全纯表达式均能编译并正确
分类；精确 Misiurewicz 点 c=i 的 `z^2+c` 在 1e10..1e300 保持 28–29 档结构、
耗时比 **1.00×**；四条横带与整帧逐位相同。

`band-worker.mjs` + `bands.mjs` 把一帧分给 N 个独立 wasm 实例、共用同一条轨道。
`node formulacore/bands-test.mjs`：320×240 深帧 **0 像素差异**，4 worker **3.10×**。

逐像素对齐（`node formulacore/align-test.mjs`，同视点同预算的 z^2+c）：采用桌面
核心的 `kEscape2 = 4.0` 与 `n + 1 - log2` 平滑约定后，jet 场与 `core.wasm`
**常数偏移为 0**、1e10..1e100 平均残差 0.002–0.006 迭代；10800 像素中仅 1 个
边界像素的内外分类不同。

**已接入页面。** `js/formulacore-worker.js` + `js/formulacore.js` 起 N 个 wasm
实例各渲一条横带，`corePass()` / `coreFrame()` 把自定义公式（`spec.mode==='x'`）
与 multibrot 高次幂交给它们。`env.js` 除 `usable` 外还给出 `useJet`：浅景用 C++
wasm 逐点渲染（仍不是 JS 内核），深景走 jet 扰动。C++ 解析器编译不了的表达式会
被本会话拉黑并回退页面内核，**不会连带关闭曼德勃罗核心**。`?formula=0` 可切回
旧 JS 内核做 A/B。

`node tools/_formula-ui-check.mjs` 与 `tools/_formula-deep-check.mjs` 在真实浏览器里
验收：默认 M 集仍由 `core.wasm` 渲染；自定义 / 嵌套三角 / multibrot(3) 由 C++ wasm
渲染；1e30 深视点 jet 引擎 **2.48 s** 落帧、29 档结构，而旧 JS 内核 5.78 s 且
67% 画面仍是暗区。

**Julia 黑屏根治。** `webcore/src/deep.cpp` 不再把「参考轨道早死」变成黑帧：当
`ref.escaped` 时，标量内核从像素最后一个已知的 `z` 出发，用普通 double 继续迭代
（`z <- z^2 + c`）到 `maxiter`。参考结束后不再需要 `Z_n`，因为此时 `z` 已接近逃逸
半径，double 精度足够；真正的内部点仍判 interior。该分支**只对 Julia 生效**，
Mandelbrot 路径逐字节未变：用 `MB_SRC=webcore/src node webcore/build.mjs` 重编后
跑 `node webcore/test.mjs`，四个参考视点与桌面 `mset.exe` 的 PNG 仍是
**100.000% / maxDelta 0**。

v55 的页面侧保护（末帧全部 interior 且参考短于预算一半时保留上一帧）保留为第二道
防线。`node tools/_julia-fix-check.mjs` 在参考确实早死的视点上（实测
`refLen 75..255 / 2000`）对比新旧二进制：新核心保持 0% interior 且有结构化的逃逸
范围。这些探针**没有复现出用户截图里那个「整帧判内部」的精确视点**，因此最好仍用
`?diag=1` 对那一个视点补一张直接的前后对照。

### 第三阶段：五个折叠内建族

非全纯内建族（tricorn、burning ship、celtic、perpendicular、phoenix）不再只能
用浅景页面内核。它们在实部/虚部上是**分段二次多项式**，因此
`formulacore/core.cpp` 增加了专用内核，使用**完全精确的 δ 递推**（没有截断 Taylor
级数，折叠处也就没有一阶 jet 误差）：

```
Dr = (2X+dr)dr - (2Y+di)di      Di = X di + Y dr + dr di
三叉戟       d' = Dr + dc_r + i(-2Di + dc_i)
燃烧船       d' = Dr + dc_r + i((sp-sB) Bq + 2 sp Di + dc_i)
凯尔特       d' = ((sp-sA) Aq + sp Dr) + dc_r + i(2Di + dc_i)
垂直         d' = Dr + dc_r + i((sp-sB) Bq + 2 sp Di + dc_i)
凤凰         d' = Dr + p dprev_r + dc_r + i(2Di + p dprev_i + dc_i)
```

`A = X²-Y²`、`B = 2XY` 由任意精度 BigInt 轨道直接生成，不是两个 double 相减；
`sp` 是**像素自己**的折叠符号。参考轨道从 1 条扩成 4 条（中心散布在画面上），
glitch 像素可在**同一迭代序号**换轨重锚。`2^-900` 以外由 float-exp 内核接管，
以内则用纯 double 的「像素单位 δ」内核，快约 10 倍。

`1e12` 以下的浅景仍走页面内核（手势与配色时序已稳定），深景才切到新引擎。
首个深景预算为 1024 迭代，**只有返回的场确实被截断**才按 4 倍增长：`1e20`
视点在第 112 步就全部逃逸，按页面自动预算的 14 600 步会跑几分钟。

`node formulacore/family-test.mjs` 用逐像素任意精度 BigInt 参考实现作金标准，
对照 5 个族（M / Julia、浅景 / 1e20）：**数值离群 0**、横带拼接逐像素一致、
4 轨阶梯与单轨一致。`node tools/_family-page-check.mjs` 再走一遍真实浏览器
worker 池。

### 切换预设不允许累积负担

用 `node tools/_preset-lag-check.mjs`（无头 Edge 连切 12 次预设）实测并消除了
三个互相独立的累加源：

* `resizeCanvas()` 在每次 `applyDeepPixelCap()` 时都清空画布并涂深色，**哪怕
  尺寸根本没变**，还会取消在飞的 pass。现在尺寸不变的 resize 是真正的空操作，
  真实 resize 会回贴快照。
* 预设网格一次排入约 111 张缩略图，单张迭代上限 12 万，3 个 worker 被长期
  占满，之后每次切换都排在它们后面。现在缩略图上限 1.2 万迭代、只补渲可见
  卡片、一次只跑一张，且每次切预设都丢弃排队任务。
* 「饿死」规则对任何全 interior 帧都无条件跳到 8 万迭代，浅视点也永久继承
  这个上限。现在按当前视点自身深度缩放该跳转。

结果：同一对预设第 0 次 1298 ms、第 9 次 1302 ms（**1.00×**）；12 个不同预设
无黑帧、无增长队列；最坏一帧从 23 s 降到 1.3 s。

### 诊断开关

| 查询参数 | 作用 |
| --- | --- |
| `?diag=1` | 浮层：状态、最后落帧实际画的视点（`MATCH`/`STALE`）、当前在最上面的画布层、缓冲区与画布尺寸、丢帧计数 |
| `?bands=N` | 固定横带数量（1 = 串行，6 = 线程池） |
| `?scene=1` | 重新启用旧的 48 位片元迭代器做 A/B |
| `?engine=old` | 加载上一版纯 JavaScript 引擎 |

部署时必须升资源版本号，否则 CDN 或浏览器会把新 HTML 和旧模块配在一起：
`node tools/_bump-cache.mjs <n>`，然后 `node tools/_publish.mjs`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.html`、`css/`、`js/` | 观测器 UI（外观未改） |
| `js/app.js` | 手势、调色板、HUD，以及 `corePass()` 派帧 |
| `js/webcore.js`、`js/webcore-worker.js` | `core.wasm` 的薄 ABI 客户端 |
| `core.wasm` | 编译后的桌面核心 |
| `webcore/src/` | **C++ 核心源码**：bigfloat、参考轨道、扰动、render、palette、viewport |
| `webcore/build.mjs` | 镜像 + 补丁 + 编译流水线（默认用仓库内源码） |
| `webcore/adapter.cpp` | C ABI：`mb_render`、`mb_view_*`、`mb_render_strip`、stats POD |
| `webcore/sync-src.mjs` | 从桌面检出刷新 `webcore/src/` |
| `formulacore/core.cpp`、`formulacore.wasm` | 独立的任意表达式 C++ 核心 + 第三阶段折叠族内核 |
| `formulacore/env.js`、`familyenv.js` | jet 系数 / 任意精度参考阶梯 |
| `js/formulacore.js`、`js/formulacore-worker.js` | 公式核心的 6 worker 横带池 |
| `formulacore/family-test.mjs`、`tools/_family-page-check.mjs` | 折叠族的金标准与浏览器验收 |
| `tools/_preset-lag-check.mjs` | 预设切换累积回归 |
| `docs/` | README 用的截图 |
| `tools/` | 发布、缓存版本、以及 CDP 驱动的检查脚本 |

## 许可

MIT — 见 [LICENSE](LICENSE)。
