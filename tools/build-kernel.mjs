import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

/** 找 zig（C++ 工具链）；没有则回退到 AssemblyScript 版本 */
function findZig() {
  const probes = process.platform === 'win32' ? ['where zig', 'zig version'] : ['which zig', 'command -v zig'];
  for (const cmd of probes) {
    try {
      const out = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split(/\r?\n/)[0].trim();
      if (!out) continue;
      if (cmd === 'zig version') return 'zig';
      let p = out;
      if (p.startsWith('/')) {
        try { p = execSync(`cygpath -w "${p}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* ignore */ }
      }
      return p;
    } catch { /* ignore */ }
  }
  return null;
}

let src = 'wasm/kernel.ts';
let binPath = 'wasm/kernel.wasm';
let compiler = 'AssemblyScript';

const zig = findZig();
if (zig) {
  console.log('编译 wasm/kernel.cpp （zig c++ / wasm32-freestanding + SIMD）...');
  execSync(
    `"${zig}" c++ -target wasm32-freestanding -O3 -msimd128 -fno-exceptions -fno-rtti ` +
    `-Wl,--no-entry -Wl,--export=render -Wl,--strip-all -o wasm/kernel.wasm wasm/kernel.cpp`,
    { cwd: root, stdio: 'inherit' }
  );
  src = 'wasm/kernel.cpp';
  compiler = 'zig c++ (C++ → wasm, simd128)';
} else {
  console.log('未找到 zig，回退到 AssemblyScript...');
  execSync('npx asc wasm/kernel.ts -O3 --runtime stub --use abort= -o wasm/kernel.wasm', { cwd: root, stdio: 'inherit' });
}

const bin = fs.readFileSync(path.join(root, binPath));
const b64 = bin.toString('base64');
const out = `/* 由 tools/build-kernel.mjs 自动生成，请勿手改。
 * 源文件: ${src}
 * 编译器: ${compiler}
 * 生成时间: ${new Date().toISOString()}
 * 大小: ${bin.length} bytes
 */
export const KERNEL_B64 = "${b64}";
export const KERNEL_BYTES = ${bin.length};
export const KERNEL_SRC = ${JSON.stringify(src)};
`;
fs.writeFileSync(path.join(root, 'js/kernel-wasm.js'), out);
console.log(`已写入 js/kernel-wasm.js  (${src}, ${(bin.length / 1024).toFixed(1)} KB wasm, ${(b64.length / 1024).toFixed(1)} KB base64)`);
