# MANDELBROT · 精密分形观测台

交互式高精度分形渲染器。纯前端即可运行，也可以把渲染内核搬到浏览器之外，用本机多线程跑满。
视觉语言参照 Fluent / 科研工具：半透明玻璃、克制的层级、没有多余的装饰。

**在线演示**：<https://xiaoxu4452.github.io/mandelbrot-view/>
**English**：[README.en.md](README.en.md)

---

## 快速开始

### 1. 直接打开（零安装）

访问上面的在线演示地址。首次加载会编译 WebAssembly 内核，之后所有计算都在本机完成。

### 2. 本地完整版（推荐，性能最好）

页面内「设置 → 渲染核心 → 下载核心包」可获得 `mandelbrot-core.zip`，解压后：

- **Windows**：双击 `start-core.bat`
- **macOS / Linux**：`bash start-core.sh`

启动脚本会拉起两个本地服务并打开浏览器：

| 服务 | 地址 | 作用 |
| --- | --- | --- |
| 渲染核心 | `http://127.0.0.1:8778` | Node 线程池承载 C++/WASM 内核，返回原始 RGBA |
| 静态页面 | `http://127.0.0.1:8777` | 以 HTTP 提供页面（ES Module / Worker 必需） |

两者都只监听回环地址，不对局域网或公网开放。

### 3. 从源码运行

```bash
git clone https://github.com/xiaoxu4452/mandelbrot-view.git
cd mandelbrot-view
node server/render-server.mjs   # 可选：本地渲染核心 127.0.0.1:8778
node server/static-server.mjs   # 页面 127.0.0.1:8777
```

> **必须通过 HTTP 访问。** 直接用 `file://` 双击 `index.html` 时，浏览器会拦截
> ES Module 与 Web Worker，页面无法启动——为此启动界面内置了诊断提示，会直接告诉你
> 该执行哪条命令，而不是停在 0%。

---

## 界面

- **顶栏**：分形族、512 预设、公式编辑器、自定义预设、数值精度、**控制台开关**、设置。
- **控制台**：可拖动、可最小化。点右上角的「—」或按 `P`，面板会收进顶栏的控制台按钮，再点一下原地展开。
- **移动端**：窄屏自动切换为底部抽屉（带拖拽手柄），顶栏压缩为图标 + 可横向滚动的导航，
  单指拖动平移、双指捏合缩放、点画布收起抽屉。
- **HUD**：左下角实时显示缩放倍率、中心坐标、引擎路径（`CORE` / `WASM` / `HP`）、位宽、参考轨道长度与耗时。

| 操作 | 桌面 | 移动端 |
| --- | --- | --- |
| 缩放 | 滚轮（以光标为锚点） | 双指捏合 |
| 平移 | 拖动 | 单指拖动 |
| 放大 / 缩小 | 双击 / Shift + 双击 | 双击 |
| 重置视图 | `R` | 控制台「重置」 |
| 控制台 | `P` | 顶栏按钮 |
| 全屏 | `F` | — |
| 导出 PNG | `S` | 控制台「导出 PNG」 |
| 迭代 | `+` / `-` | 控制台滑杆 |

---

## 渲染管线

```
主线程                        Worker × N                    本地核心（可选）
────────                     ──────────                    ─────────────────
视图状态（十进制字符串坐标）
尺度 mantissa × 2^exp   ──►  ① WASM 像素内核  ──HTTP──►   Node worker_threads
渐进式瓦片调度                · 直算 / 扰动 / 牛顿          （同一套内核）
（0.13 → 0.38 → 0.68 → 1.0）  · SIMD f64x2 双像素
                            ② BigInt 高精度层
                            · 参考轨道 + 级数近似
```

1. **坐标表示**：中心坐标以十进制字符串保存，像素尺度拆成 `mantissa × 2^exp`，
   避免 double 在 `1e-300` 以下直接下溢。
2. **精度自动分档**：按 `log₂(像素尺度)` 选择 64 / 128 / 256 / 512 / 1024 / 2048 / 4096 位定点。
3. **参考轨道扰动**：先在参考点用高精度迭代出一条轨道，像素只在 double 上递推偏移量 `δ`；
   参考点在视口内按「存活最久」选举，优先选择永不逃逸的内部点。
4. **级数近似**：`δ` 的前若干步由 A/B/C 系数直接给出，跳过上百次迭代；
   跳过半径按像素尺度与容差计算，一旦越界立即回退到逐次迭代。
5. **混叠修复**：内核把精度失效的像素坐标写回内存，主机用视口级二级参考轨道只重算这些像素，
   不再整块重绘——既保证了干净的画面，也保住了 WASM 的速度。
6. **渐进渲染**：每帧四趟（0.13 → 1.0），迭代次数始终按最终值计算，
   所以中途看到的低分辨率预览不会塌成纯色块。

---

## 高精度求值器（`js/hpeval.js`）

自定义公式在深层放大时，坐标必须比 double 精确得多。求值器把表达式编译成闭包树，
在 `BigInt` 定点数（小数位 = 位宽 + 26 位保护位）上求值：

| 能力 | 实现 |
| --- | --- |
| `+ - * / ^` | 定点四则；整数幂用平方-乘；一般幂走 `exp(b·log a)` |
| `sin cos tan sinh cosh tanh` | 参数归约 + 泰勒级数；复数按标准恒等式组合 |
| `exp log sqrt` | `k·ln2` 归约、atanh 级数、牛顿迭代 |
| `arg atan atan2` | 定点 atan（两次半角归约 + 泰勒），`log` 的相位同样高精度 |
| `abs conj re im`、`Σ Π`、分段函数 | 逐项实现 |

验证脚本 `tools/hpverify.mjs` / `tools/hpconverge.mjs`：

- 全部初等函数与 double 结果一致到 `1e-12` 以内；
- 迭代 `z²+c` 2000 次后，512 位与 256 位结果**逐位一致到 85 位十进制（≈282 bit）**，
  512 位与 128 位一致到 47 位——精度确实随位宽增长，不是"假高精度"。

速度：`z²+c` 约 13 万次迭代/秒（128–256 位），`sin(z)+c` 约 2.5 万次/秒（128 位）。

## 任意公式的深层扰动（`js/jet.js`）

`z²+c` 的扰动只需二阶项，`z³+c` 缺了 `ε³` 就会算错。因此对任意表达式求
`F(Z+ε, c+δ)` 关于 `ε` 的截断幂级数：

```
F  = p₀ + p₁ε + … + p_K ε^K + (q₀ + q₁ε + …) δ
ε' = (p₁ + p₂ε + …) ε + (q₀ + q₁ε + …) δ
```

系数用幂级数自动微分在参考轨道上求得（不是有限差分），阶数按多项式次数自动选择：
多项式公式（`z^p`、组合、`Σ`）在任意深度都是**精确**的；`sin/exp/log` 等超越函数在中浅层准确，
极深时 HUD 会标注为近似。

---

## 数学库（`js/mathlib.js`）

自研的复数表达式前端，行为对齐 Desmos 的输入习惯：

- Pratt 解析器，隐式乘法（`2z`、`3(z+1)`、`az`）；
- 公共子表达式消除 + `new Function` 生成迭代步进函数（周期检测内联在生成代码里）；
- `Σ` / `Π` / 分段函数 / 用户函数 `f(x)=…` / 比较与布尔运算；
- 任意自由单字母自动成为参数并生成滑块（`z`、`c`、`n`、`z_1` 为保留名）；
- 同一份 AST 同时输出 LaTeX，供公式面板排版显示。

## 预设

512 个预设 = 64 个观测锚点 × 8 套配色。锚点由 `tools/gen-presets.mjs` 用边界扫描 +
构图评分自动筛选，再由 `tools/searchviews.mjs` 精修，覆盖 Mandelbrot、Julia、Newton
与多种异形族。

---

## 目录

```
index.html            界面骨架 + 启动守卫（file:// 诊断）
css/app.css           Fluent 玻璃风格、深/浅主题、移动端断点
js/app.js             视图状态、渐进式瓦片调度、交互、窗口
js/worker.js          渲染线程：WASM 调度、参考轨道/级数缓存、混叠修复
js/render.js          CPU 瓦片渲染（扰动 / 高精度 / 牛顿 / 自定义）
js/corepanel.js       「渲染核心」面板（下载本地核、状态探测）
js/remote.js          本地核心客户端（127.0.0.1:8778）
js/formulas.js        分形族定义与高精度参考轨道
js/bigfixed.js        任意精度定点数（BigInt）
js/environment.js     级数近似（A/B/C 系数、跳过步数）
js/customenv.js       自定义公式的高精度环境
js/hpeval.js          高精度求值器
js/jet.js             幂级数（jet）自动微分
js/mathlib.js         复数表达式库（解析 / 代码生成 / LaTeX）
js/palettes.js        配色 LUT
js/presets-data.js    512 个预设（生成文件）
wasm/kernel.cpp       WASM 内核源码（C++ / SIMD）
wasm/kernel.ts        AssemblyScript 参考实现
js/kernel-wasm.js     内联 base64 内核（生成文件）
server/               本地渲染核心与静态服务
core/                 可下载的核心包（由 tools/build-core-package.mjs 生成）
tools/                构建与验证脚本
```

## 重新构建

```bash
node tools/build-kernel.mjs          # C++ → wasm → js/kernel-wasm.js（需要 zig）
node tools/build-core-package.mjs    # 打包 core/mandelbrot-core.zip
node tools/gen-presets.mjs           # 重新生成 512 个预设
```

## 许可

[MIT](LICENSE)。配色与预设的组织方式参考 Retinamandelbrot / Retinajulia 的示例集。
