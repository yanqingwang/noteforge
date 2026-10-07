/**
 * 生成 40 个分层插件样本（compat/plugins.sample.json）。
 *
 * 分层依据：官方市场 community-plugin-stats.json 的下载量排名，再按 id/name
 * 关键词分到功能类别，每类取下载量最高的若干个 —— 这样覆盖面由数据决定，
 * 而不是手挑几个好装的。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, ".cache");
const TARGET = Number(process.argv[2] ?? 40);

const CDN = "https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases@master";

/** 带重试的 fetch（网络是本机最不稳的一环，缺重试会让整轮测试变成随机失败）。 */
async function getJSON(url, cacheName) {
  mkdirSync(CACHE, { recursive: true });
  const cached = resolve(CACHE, cacheName);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  let lastErr;
  for (let i = 1; i <= 4; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      writeFileSync(cached, text);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr;
}

/** 功能类别：关键词命中即归类。顺序即优先级（先匹配先归属）。 */
const CATEGORIES = [
  ["数据视图", ["dataview", "dbfolder", "projects", "obsidian-metadata-menu", "smart-connections", "projects"]],
  ["任务待办", ["task", "todo", "kanban", "habit"]],
  ["日历日记", ["calendar", "daily-note", "journal", "periodic-note", "reminder"]],
  ["样式外观", ["style", "theme", "minimal", "border", "hider", "color"]],
  ["导航大纲", ["outliner", "outline", "waypoint", "explorer", "bookmark", "link", "navigation", "header"]],
  ["编辑写作", ["linter", "editing", "compact", "word-count", "note-automation", "various-complements", "slash-command", "format"]],
  ["图谱白板", ["excalidraw", "canvas", "mindmap", "draw", "chart", "diagram"]],
  ["同步集成", ["git", "sync", "remote", "backup", "publish", "uri", "shell", "webhook", "github"]],
  ["AI 智能体", ["copilot", "text-generator", "vault-agent", "ai", "llm", "gpt", "assistant"]],
  ["模板自动化", ["templater", "quickadd", "template", "macro", "auto-note", "daily-note"]],
  ["媒体附件", ["image", "img", "attachment", "media", "pdf", "audio", "video", "zoom"]],
  ["整理归档", ["archive", "housekeeping", "unused", "file-hider", "folder-note", "organiz"]],
];

function classify(id, name) {
  const hay = `${id} ${name}`.toLowerCase();
  for (const [cat, keys] of CATEGORIES) {
    if (keys.some((k) => hay.includes(k))) return cat;
  }
  return "其他";
}

const [meta, stats] = await Promise.all([
  getJSON(`${CDN}/community-plugins.json`, "community-plugins.json"),
  getJSON(`${CDN}/community-plugin-stats.json`, "community-plugin-stats.json"),
]);

const dl = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.downloads]));
const pool = meta
  .map((p) => ({ ...p, downloads: dl[p.id] ?? 0, category: classify(p.id, p.name) }))
  .filter((p) => p.downloads > 0)
  .sort((a, b) => b.downloads - a.downloads);

// 按类别轮转取样：先给下载量最高的一批，再轮流补齐其它类别，避免全被头部插件占满。
const byCat = new Map();
for (const p of pool) {
  if (!byCat.has(p.category)) byCat.set(p.category, []);
  byCat.get(p.category).push(p);
}
const cats = [...byCat.keys()].sort((a, b) => (byCat.get(a)[0]?.downloads ?? 0) < (byCat.get(b)[0]?.downloads ?? 0) ? 1 : -1);

const picked = [];
const seen = new Set();
for (let round = 0; picked.length < TARGET && round < 60; round++) {
  let progressed = false;
  for (const c of cats) {
    if (picked.length >= TARGET) break;
    const list = byCat.get(c);
    const p = list?.[round];
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    picked.push(p);
    progressed = true;
  }
  if (!progressed) break;
}

// vault-agent 是本项目的自有插件，无论排名都要在样本里。
const va = meta.find((p) => p.id === "vault-agent");
if (va && !seen.has("vault-agent")) {
  const last = picked.length > TARGET ? picked.pop() : null;
  if (last) seen.delete(last.id);
  picked.push({ ...va, downloads: dl[va.id] ?? 0, category: "AI 智能体" });
  if (last) picked.push(last);
}

const out = {
  generatedAt: new Date().toISOString(),
  source: `${CDN}/community-plugins.json + community-plugin-stats.json`,
  totalInMarketplace: meta.length,
  target: TARGET,
  sampled: picked.length,
  byCategory: Object.fromEntries(
    cats.map((c) => [c, picked.filter((p) => p.category === c).length]).filter(([, n]) => n > 0),
  ),
  plugins: picked.map((p) => ({
    id: p.id, name: p.name, repo: p.repo, category: p.category, downloads: p.downloads,
  })),
};

const file = resolve(HERE, "plugins.sample.json");
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`样本已写入 ${file}`);
console.log(`市场总数 ${meta.length}，样本 ${out.sampled}，类别分布：`, JSON.stringify(out.byCategory));
console.log("\n下载量前 10：");
for (const p of [...picked].sort((a, b) => b.downloads - a.downloads).slice(0, 10)) {
  console.log(`  ${String(p.downloads).padStart(10)}  ${p.category.padEnd(6)} ${p.id}`);
}