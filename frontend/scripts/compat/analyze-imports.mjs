/**
 * 静态分析：插件引用了哪些 `obsidian.X`，其中哪些 shim 没有导出。
 *
 * 这是兼容性测试的「前置扫描」——很多插件在类定义阶段（extends / 模块顶层）
 * 就崩，动态跑到一半才炸，静态一次列全更省事，也能直接排补 shim 的优先级。
 *
 * 用法：node scripts/compat/analyze-imports.mjs [插件id...]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "../..");
const PLUGIN_DIR = resolve(HERE, ".cache/plugins");
const BUNDLE = resolve(FRONTEND, "dist-harness/obsidian-shim.mjs");

/** shim 自己报的导出清单（避免「文档写了但没实现」）。 */
async function exportedNames() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  for (const k of ["window", "document", "HTMLElement", "Document"]) {
    try {
      globalThis[k] = dom.window[k];
    } catch {
      /* 只读全局忽略 */
    }
  }
  const shim = await import(BUNDLE);
  shim.createObsidianApi(shim.createMemoryHost({ "a.md": "x" }), { name: "analyze" });
  return new Set(shim.OBSIDIAN_EXPORT_NAMES);
}

function analyze(pluginId) {
  const code = readFileSync(resolve(PLUGIN_DIR, pluginId, "main.js"), "utf8");

  // 找别名必须线性扫描：用「标识符 + = + 惰性区间」的正则在压缩产物上会 O(n²)
  // 回溯（超长标识符很多），2MB 文件能跑几分钟。
  // 做法：定位字面量 require("obsidian")，再往回退几步取赋值目标。
  const aliases = new Set();
  for (const q of ['require("obsidian")', "require('obsidian')"]) {
    let i = code.indexOf(q);
    while (i !== -1) {
      let j = i - 1;
      while (j >= 0 && /\s/.test(code[j])) j--;
      if (code[j] === "(") {
        // esbuild/Rollup 的 interop 包装：$(require("obsidian")) / __toESM(require(...))
        while (j >= 0 && /[\w$()\s]/.test(code[j])) j--;
      }
      if (code[j] === "=") {
        j--;
        while (j >= 0 && /\s/.test(code[j])) j--;
        const end = j + 1;
        while (j >= 0 && /[\w$]/.test(code[j])) j--;
        if (end > j + 1) aliases.add(code.slice(j + 1, end));
      }
      i = code.indexOf(q, i + 1);
    }
  }

  const used = new Map();
  if (aliases.size) {
    const group = [...aliases].map((a) => a.replace(/\$/g, "\\$")).join("|");
    const re = new RegExp(`\\b(?:${group})\\.([A-Za-z_$][\\w$]*)`, "g");
    for (const m of code.matchAll(re)) used.set(m[1], (used.get(m[1]) ?? 0) + 1);
  }
  return { used, aliases: [...aliases] };
}

const known = await exportedNames();
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(PLUGIN_DIR).filter((d) => {
      try {
        statSync(resolve(PLUGIN_DIR, d, "main.js"));
        return true;
      } catch {
        return false;
      }
    });

console.log(`shim 导出 ${known.size} 个符号；扫描 ${targets.length} 个插件\n`);
const allMissing = new Map();
for (const p of targets) {
  let used, aliases;
  try {
    ({ used, aliases } = analyze(p));
  } catch (e) {
    console.log(`${p}: 解析失败 ${String(e?.message ?? e).slice(0, 80)}`);
    continue;
  }
  const missing = [...used].filter(([k]) => !known.has(k)).sort((a, b) => b[1] - a[1]);
  const size = (statSync(resolve(PLUGIN_DIR, p, "main.js")).size / 1024).toFixed(0);
  console.log(`${p} (${size}KB, 别名 ${aliases.join(",")})`);
  if (!missing.length) console.log("   ✓ 无缺失");
  else {
    for (const [k, v] of missing.slice(0, 20)) console.log(`   ${String(v).padStart(5)}x ${k}`);
    for (const [k, v] of missing) allMissing.set(k, (allMissing.get(k) ?? 0) + 1);
  }
}
console.log(`\n===== 全部插件合并的缺失符号（按影响插件数） =====`);
for (const [k, v] of [...allMissing].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)} 个插件  ${k}`);