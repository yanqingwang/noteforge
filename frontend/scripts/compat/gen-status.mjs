/**
 * 把 harness 的评测结果压成应用可直接 fetch 的紧凑状态表。
 *
 * 用法：node scripts/compat/gen-status.mjs
 * 产物：frontend/public/compat-status.json
 *   { generatedAt, total, summary, plugins: { "<id>": { s: status, p?: phase, e?: error } } }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "../..");

const src = JSON.parse(readFileSync(resolve(HERE, "compat-results.json"), "utf8"));
const plugins = {};
for (const r of src.results ?? []) {
  if (!r?.id) continue;
  const entry = { s: String(r.status ?? "") };
  if (r.phase) entry.p = String(r.phase);
  if (r.error) entry.e = String(r.error).slice(0, 200);
  plugins[r.id] = entry;
}

const out = {
  generatedAt: src.generatedAt ?? null,
  total: src.total ?? Object.keys(plugins).length,
  summary: src.summary ?? null,
  plugins,
};
const dest = resolve(FRONTEND, "public/compat-status.json");
writeFileSync(dest, JSON.stringify(out));
console.log(`写入 ${dest}：${Object.keys(plugins).length} 条（${out.generatedAt}）`);
