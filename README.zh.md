# Mandelbrot View — 桌面核心，运行在浏览器里

交互式 Mandelbrot / Julia 观测器，渲染器是**编译成 WebAssembly 的桌面 C++
核心**——与 [Meter-Mandelbrot-Desktop](https://github.com/xiaoxu4452/Meter-Mandelbrot-Desktop)
使用同一批翻译单元（扰动引擎、级数近似、周期参考轨道、自研 BigFloat
后端）。这里没有第二套算法：网页渲染的就是桌面渲染的画面，逐像素一致。

**在线地址**：<https://xiaoxu4452.github.io/mandelbrot-view/>
English: [README.md](README.md)

---

## 架构

```
浏览器                      shell-worker.js           core.wasm（C++ → wasm32-wasi）
 ┌────────────┐  postMessage  ┌──────────────┐  mb_render()  ┌──────────────────┐
 │ shell.js   │ ────────────▶ │ 字符串 ABI    │ ────────────▶ │ 桌面核心：        │
 │ 画布/手势  │ ◀──────────── │ RGB → ImageData│ ◀──────────── │ deep / reference │
 │ HUD/面板   │   ImageData   │              │    RGB        │ / render / bigfloat│
 └────────────┘               └──────────────┘               └──────────────────┘
```

* **一个引擎、一个 worker。** 手势（滚轮 / 平移 / 捏合）期间用同一个核心
  重画低分辨率整帧；提交帧永远是一次全分辨率渲染。没有 shader 迭代、
  没有 WebGPU、没有渐进 tile 混合。
* **中心坐标是全深度十进制字符串。** 每个手势用 BigInt 十进制运算叠加一个
  小 double 增量，63 位中心上的 1e-600 平移不会丢一位。坐标以字符串直传
  核心，与桌面 CLI 完全一致。
* **精度**由核心自行规划：`digits = log10(zoom) + 50`、64 limb 对齐——与
  桌面规则相同。
* **滚轮**沿用桌面壳模型：一格约 1.522×、快照在光标下反馈、360 ms 防抖、
  无滑行。

## 核心构建（`webcore/`）

`webcore/build.mjs` 从桌面源码树复制渲染链翻译单元
（`C:\Users\harve\Desktop\mande\new\src`），应用三处有文档的机械构建期
适配，用 zig 编译：

1. `throw std::invalid_argument`（7 处，仅输入解析）→ 错误标志——zig 的
   wasm32-wasi libc++ 不带异常展开器。
2. `<thread>` → 单线程桩；壳层始终以 `threads = 1` 渲染，不会 spawn 任何
   线程。
3. `gmp_bridge.cpp` → `gmp_stub.cpp`：运行时后端选择器固定为自研
   BigFloat 后端——与桌面在缺少 GMP DLL 时完全同数值，也正是 B2 oracle
   测试验证过的后端。BigFloat 路径补上了周期参考探测（精确重复检测 +
   平铺，镜像 `orbit_gmp`），使周期中心在任意深度保持精确。

桌面原件一律不改；每个补丁都在 `webcore/build.mjs` 里断言数量，桌面侧
变更不可能静默漂移进网页构建。

```bash
# 重新构建 core.wasm（需要 zig 0.16+）
npm run build:core

# 与桌面 mset.exe 逐像素对拍
# （视点：首页、1e15.2、1e38、c=i @ 1e600、Julia）
npm run test:core

# 浏览器冒烟（Playwright，桌面 + 手机触屏）
npm run page &      # 本地静态服务 :8777
npm run smoke
```

当前验收：五个参考视点对桌面金标准 **100.000% 逐像素一致（maxDelta = 0）**。

## 文件

| 路径 | 作用 |
| --- | --- |
| `index.html`, `shell.css`, `shell.js` | 壳：画布、手势、HUD、面板 |
| `shell-worker.js` | WASM 宿主：字符串 ABI、RGB → ImageData |
| `core.wasm` | 编译好的桌面核心（供浏览器加载） |
| `webcore/` | 核心的构建与逐像素对拍测试 |
| `server/static-server.mjs` | 本地开发服务 |
| `tools/` | 发布、历史重建、浏览器冒烟、PNG 读取 |

## 分享视点

菜单 → **复制视点链接**，链接内含全精度中心、视窗宽度、迭代数与配色。
旧网页引擎的链接（`#st=…` 旧格式）仍可解码。
