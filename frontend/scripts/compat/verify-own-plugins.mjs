/**
 * 自有插件的功能级验证（不是「能不能加载」，而是「关键功能有没有真的工作」）。
 *
 * 覆盖 vault 里作者为 rosswang / yanqingwang 的插件：
 *   html-effectiveness / md-to-html-effect / html-to-md-effect /
 *   vault-agent / quadrant-chart / obsidian-nextcloud-sync-yanc
 *
 * 判据分三类，逐类都过才算这个插件「能正常工作」：
 *   1. 加载：产物能求值、构造、onload 不抛错
 *   2. 能力：注册了**该有的**命令/视图/设置页（按 id 逐个点名，不看数量）
 *   3. 渲染：视图与设置页真的画出了内容（DOM 摘要非空），设置页行数达阈值
 *
 * 用法：
 *   node scripts/compat/verify-own-plugins.mjs                # 测 vault 里的插件
 *   node scripts/compat/verify-own-plugins.mjs --vault <路径>  # 指定 vault
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const VAULT = argsVault();

function argsVault() {
  const i = process.argv.indexOf("--vault");
  return i >= 0 ? process.argv[i + 1] : "/home/wang/wk/wk";
}

/**
 * 每个插件的期望。字段含义：
 *   commands     必须注册的命令 id（缺失即失败 —— 数量对但 id 错也说明功能不对）
 *   minCommands  命令数下限（允许插件自己增加）
 *   views        期望注册的视图类型
 *   minSettingRows 设置页最少渲染行数（0 = 不检查）
 *   minViewText  视图内容最少文本长度（0 = 不检查）
 */
const EXPECT = {
  "html-effectiveness": {
    label: "HTML Effectiveness（md/html 效果渲染）",
    // id 取自实际产物，不猜
    commands: [
      "html-effectiveness:open-html-view",
      "html-effectiveness:toggle-html-edit",
      "html-effectiveness:export-note",
    ],
    minCommands: 9,
    views: 1,
    minSettingRows: 2, // 设置页就是「标题 + 默认主题下拉」两行（见 main.ts display()）
    // 它的视图 onOpen 是空的（见 main.ts:1058），iframe 在打开 html 文件时才填 ——
    // 所以"视图打开后是空的"是设计如此，不能当缺陷。真机验证过 paint-board.html 能渲染。
    containerView: true,
  },
  "md-to-html-effect": {
    label: "MD to HTML Effectiveness（Markdown 转 HTML）",
    commands: ["md-to-html-effect:convert-md-to-html", "md-to-html-effect:convert-batch-md-to-html"],
    minCommands: 2,
    views: 0,
    minSettingRows: 2, // 同上：标题 + 输出主题
  },
  "html-to-md-effect": {
    label: "HTML to MD Effectiveness（HTML 转 Markdown）",
    optional: true, // vault 里未启用（只有旧版目录残留），缺失不算失败
    commands: [],
    minCommands: 1,
    views: 0,
    minSettingRows: 0,
  },
  "vault-agent": {
    label: "Vault Agent（AI agent）",
    commands: ["vault-agent:open-agent"],
    minCommands: 1,
    views: 1,
    minSettingRows: 8,
    minViewText: 100, // 视图要真的画出界面，不只是没抛错
  },
  "quadrant-chart": {
    label: "Quadrant Chart（.mdx 象限图）",
    commands: [
      "quadrant-chart:create-chart",
      "quadrant-chart:open-chart",
      "quadrant-chart:export-image",
    ],
    minCommands: 4,
    views: 1,
    minSettingRows: 3,
    expectViewTags: ["svg"], // 接管扩展名(.mdx)的视图：画布是 SVG，文本长度为 0 是正常的
  },
  "obsidian-nextcloud-sync-yanc": {
    label: "Nextcloud sync YANC（双向同步）",
    // 命令 id 用 manifest.id（nextcloud-sync-yanc），目录名是 obsidian-nextcloud-sync-yanc
    commands: ["nextcloud-sync-yanc:sync-now", "nextcloud-sync-yanc:open-sync-status"],
    minCommands: 5,
    views: 0,
    minSettingRows: 20,
  },
};

const results = JSON.parse(readFileSync(resolve(HERE, "compat-results.json"), "utf8")).results;
const byId = new Map(results.map((r) => [r.id, r]));

let failed = 0;
const rows = [];

for (const [id, exp] of Object.entries(EXPECT)) {
  const r = byId.get(id);
  if (!r) {
    // vault 里没启用（如 html-to-md-effect 只有旧目录残留）——不算失败，但要说明
    const verdict = exp.optional ? "— 未启用" : "❌ 未测到";
    if (!exp.optional) failed += 1;
    rows.push({
      id,
      label: exp.label,
      verdict,
      commands: 0,
      views: 0,
      settingRows: 0,
      problems: exp.optional ? [] : ["compat-results.json 里没有这个插件（先跑 run.mjs --from-vault）"],
    });
    continue;
  }

  const problems = [];
  if (r.status === "artifact-unavailable") {
    problems.push(`产物不可达：${r.error ?? ""}`);
  } else if (!["pass", "pass-view-error", "load-only"].includes(r.status)) {
    problems.push(`加载失败（${r.status}）：${r.error ?? ""}`);
  }

  // 命令：点名 + 数量
  const ids = r.commandIds ?? [];
  for (const want of exp.commands ?? []) {
    if (!ids.includes(want)) problems.push(`缺少命令 ${want}（现有：${ids.join(", ") || "无"}）`);
  }
  if (ids.length < (exp.minCommands ?? 0)) {
    problems.push(`命令数 ${ids.length} < 期望下限 ${exp.minCommands}`);
  }

  // 视图：数量 + 是否画出内容
  if ((r.views ?? 0) < (exp.views ?? 0)) {
    problems.push(`视图数 ${r.views} < 期望 ${exp.views}`);
  }
  for (const [type, shell] of Object.entries(r.viewShells ?? {})) {
    const tags = shell.tags ?? [];
    if (exp.expectViewTags?.length) {
      for (const t of exp.expectViewTags) {
        if (!tags.includes(t)) problems.push(`视图 ${type} 里没有 <${t}>（现有标签：${tags.join(",") || "无"}）`);
      }
      continue;
    }
    if (exp.containerView) continue; // 容器型视图：打开后为空是设计如此
    const empty = shell.children === 0 && shell.textLen === 0;
    if (empty) problems.push(`视图 ${type} 渲染为空（0 子元素 / 0 文本）`);
    else if ((exp.minViewText ?? 0) > shell.textLen) {
      problems.push(`视图 ${type} 文本仅 ${shell.textLen} 字符 < 期望 ${exp.minViewText}`);
    }
  }

  // 设置页：行数
  const rowsGot = r.settingRows ?? 0;
  if ((exp.minSettingRows ?? 0) > 0) {
    if ((r.settingTabs ?? 0) === 0) problems.push("没有设置页（设置入口会消失）");
    else if (rowsGot < exp.minSettingRows) {
      problems.push(`设置页只渲染 ${rowsGot} 行 < 期望 ${exp.minSettingRows}`);
    }
  }
  // 写路径命令冒烟：要真的产出文件，光"回调没抛错"不算数
  for (const [cid, res] of Object.entries(r.commandSmoke ?? {})) {
    if (!res.ok) problems.push(`命令 ${cid} 执行失败：${res.error ?? "未知"}`);
    else if (!res.newFiles?.length) problems.push(`命令 ${cid} 执行了但没有任何文件产出`);
  }

  if (r.settingTabErrors?.length) problems.push(`设置页报错：${r.settingTabErrors[0]}`);
  if (r.viewErrors?.length) problems.push(`视图报错：${r.viewErrors[0]}`);

  const ok = problems.length === 0;
  if (!ok) failed += 1;
  rows.push({
    id,
    label: exp.label,
    verdict: ok ? "✅ 正常" : "❌ 有问题",
    commands: ids.length,
    views: r.views ?? 0,
    settingRows: rowsGot,
    problems,
  });
}

/* ---------- 输出 ---------- */
const icon = (v) => (v.startsWith("✅") ? "✅" : v.startsWith("—") ? "—" : "❌");
const line = (row) =>
  `${icon(row.verdict)} ${row.id.padEnd(30)} ${row.label.padEnd(38)} ` +
  `命令=${String(row.commands ?? "-").padStart(3)} 视图=${row.views ?? "-"} 设置页行数=${row.settingRows ?? "-"}`;
console.log(`\n自有插件功能验证（vault: ${VAULT}）\n`);
for (const row of rows) {
  console.log(line(row));
  for (const p of row.problems) console.log(`      ↳ ${p}`);
}
const okCount = rows.filter((r) => r.verdict.startsWith("✅")).length;
const skipped = rows.filter((r) => r.verdict.startsWith("—")).length;
console.log(`\n合计：${okCount} 正常 / ${failed} 有问题${skipped ? ` / ${skipped} 未启用` : ""}`);

// vault 里作者的插件是否都覆盖到了（漏测要喊出来）
const AUTHORS = /rosswang|yanqingwang/i;
const pluginDir = resolve(VAULT, ".obsidian/plugins");
const mine = existsSync(pluginDir)
  ? readFileSync(resolve(pluginDir, "../community-plugins.json"), "utf8")
  : "[]";
let enabledIds = [];
try {
  enabledIds = JSON.parse(mine);
} catch {
  /* 读不到就跳过 */
}
const uncovered = enabledIds.filter((id) => {
  try {
    const m = JSON.parse(readFileSync(resolve(pluginDir, id, "manifest.json"), "utf8"));
    return AUTHORS.test(m.author ?? "") && !EXPECT[id];
  } catch {
    return false;
  }
});
if (uncovered.length) {
  console.log(`\n⚠️ vault 里已启用、作者是你、但本脚本没覆盖的插件：${uncovered.join(", ")}`);
}

process.exit(failed > 0 || uncovered.length > 0 ? 1 : 0);