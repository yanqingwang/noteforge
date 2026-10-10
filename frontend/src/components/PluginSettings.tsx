/**
 * 插件设置页（设置对话框内的「插件」标签）：已安装管理 + Obsidian 官方市场安装。
 *
 * 市场索引用 obsidian-releases 的 community-plugins.json（官方插件浏览器同一份数据），
 * 走 jsDelivr 取，避免本机到 github.com 不通。索引有 2.5MB，缓存在 localStorage 24h。
 */

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { obsidianRuntime, type PluginSummary } from "../plugins/obsidianRuntime";
import { categorizePlugin, categoryLabel, categoryOrder } from "../plugins/categorize";
import {
  compatBadge,
  compatTitle,
  formatDownloads,
  MARKET_SORT_KEY,
  readMarketSort,
  SORT_OPTIONS,
  type CompatEntry,
  type MarketSort,
} from "../plugins/marketSort";

interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  has_main: boolean;
  bytes: number;
}

interface MarketEntry {
  id: string;
  name: string;
  repo: string;
  author: string;
  description: string;
  downloads: number;
}

const INDEX_KEY = "nf-plugin-market-index";
const INDEX_TS_KEY = "nf-plugin-market-index-at";
const STATS_KEY = "nf-plugin-market-stats";
const STATS_TS_KEY = "nf-plugin-market-stats-at";
const INDEX_TTL = 24 * 3600 * 1000;

interface PluginSettingsProps {
  vaultPath: string;
  dark: boolean;
  onChanged: () => void;
  onClose: () => void;
  /** 打开某个插件自己的设置页 */
  onOpenPluginSettings: (pluginId: string) => void;
}

export default function PluginSettings({ vaultPath, dark, onChanged, onClose, onOpenPluginSettings }: PluginSettingsProps) {
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [market, setMarket] = useState<MarketEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [sort, setSort] = useState<MarketSort>(() => readMarketSort());
  const [statsJson, setStatsJson] = useState("");
  const [compat, setCompat] = useState<Record<string, CompatEntry>>({});

  // 兼容性评测状态表（由 scripts/compat/gen-status.mjs 生成到 public/）
  useEffect(() => {
    let cancelled = false;
    fetch("/compat-status.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.plugins) setCompat(j.plugins as Record<string, CompatEntry>);
      })
      .catch(() => {
        /* 无数据 → 全部按「未测」展示 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 索引 + 下载量缓存 24h；排序/兼容数据变化时重取（索引走缓存，成本低）
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const at = Number(localStorage.getItem(INDEX_TS_KEY) ?? 0);
        let indexJson = at && Date.now() - at < INDEX_TTL ? localStorage.getItem(INDEX_KEY) : null;
        if (!indexJson) {
          indexJson = await invoke<string>("marketplace_index");
          localStorage.setItem(INDEX_KEY, indexJson);
          localStorage.setItem(INDEX_TS_KEY, String(Date.now()));
        }
        let st = localStorage.getItem(STATS_KEY) ?? "";
        const sat = Number(localStorage.getItem(STATS_TS_KEY) ?? 0);
        if (!st || !(sat && Date.now() - sat < INDEX_TTL)) {
          try {
            st = await invoke<string>("marketplace_stats");
            localStorage.setItem(STATS_KEY, st);
            localStorage.setItem(STATS_TS_KEY, String(Date.now()));
          } catch {
            /* 离线：下载量未知，排序回落 */
          }
        }
        if (cancelled) return;
        setStatsJson(st);
        const top = await invoke<MarketEntry[]>("marketplace_search", {
          indexJson: indexJson ?? "[]",
          statsJson: st,
          compatJson: JSON.stringify(compat),
          query: "",
          sort,
          limit: 60,
        });
        if (!cancelled) setMarket(top);
      } catch (e) {
        if (!cancelled) setStatus(`取市场索引失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sort, compat]);

  const search = async (q: string) => {
    setQuery(q);
    if (!q.trim()) return;
    setLoading(true);
    try {
      const indexJson = localStorage.getItem(INDEX_KEY) ?? "[]";
      const res = await invoke<MarketEntry[]>("marketplace_search", {
        indexJson,
        statsJson,
        compatJson: JSON.stringify(compat),
        query: q,
        sort,
        limit: 60,
      });
      setMarket(res);
    } finally {
      setLoading(false);
    }
  };

  const changeSort = (s: MarketSort) => {
    setSort(s);
    localStorage.setItem(MARKET_SORT_KEY, s);
  };

  const fg = dark ? "#ccc" : "#333";
  const border = dark ? "#3a3a3a" : "#e8e8e8";

  const refreshInstalled = async () => {
    try {
      const list = await invoke<InstalledPlugin[]>("list_plugins", { vaultRoot: vaultPath });
      setInstalled(list);
    } catch (e) {
      setStatus(`读取已安装插件失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    void refreshInstalled();
  }, [vaultPath]);

  const install = async (e: MarketEntry) => {
    setInstalling(e.id);
    setStatus(`正在安装 ${e.name}…`);
    try {
      const rep = await invoke<{ id: string; source: string; version: string; files: string[] }>(
        "install_plugin",
        { vaultRoot: vaultPath, repo: e.repo, idHint: e.id },
      );
      setStatus(`✓ ${rep.id} ${rep.version} 安装完成（${rep.files.join(", ")}；来源 ${rep.source}）`);
      await refreshInstalled();
      await obsidianRuntime.reload();
      onChanged();
    } catch (err) {
      setStatus(`✗ ${e.name} 安装失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(null);
    }
  };

  const toggleEnabled = async (p: InstalledPlugin) => {
    await invoke("set_plugin_enabled", { vaultRoot: vaultPath, id: p.id, enabled: !p.enabled });
    await refreshInstalled();
    await obsidianRuntime.reload();
    onChanged();
  };

  const uninstall = async (p: InstalledPlugin) => {
    if (!confirm(`删除插件 ${p.name}？\n目录：.obsidian/plugins/${p.id}`)) return;
    await invoke("uninstall_plugin", { vaultRoot: vaultPath, id: p.id });
    setStatus(`已卸载 ${p.name}`);
    await refreshInstalled();
    await obsidianRuntime.reload();
    onChanged();
  };

  const installedIds = useMemo(() => new Set(installed.map((p) => p.id)), [installed]);
  const runtimeList = obsidianRuntime.list() as PluginSummary[];

  // 已安装插件按功能分类分组（与侧栏插件面板同一套分类）
  const installedGroups = useMemo(() => {
    const byKey = new Map<string, InstalledPlugin[]>();
    for (const p of installed) {
      const key = categorizePlugin(p.name, p.description || "");
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(p);
    }
    return categoryOrder([...byKey.keys()]).map((key) => [key, byKey.get(key) ?? []] as const);
  }, [installed]);

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "8px 0",
    border: "none",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    background: active ? (dark ? "#333" : "#fff") : "transparent",
    color: fg,
  });

  const cardStyle: React.CSSProperties = {
    padding: "8px 10px",
    borderBottom: `1px solid ${border}`,
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 420, color: fg }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${border}` }}>
        <button style={tabStyle(tab === "installed")} onClick={() => setTab("installed")}>
          已安装 {installed.length ? `(${installed.length})` : ""}
        </button>
        <button style={tabStyle(tab === "market")} onClick={() => setTab("market")}>
          插件市场 {loading ? "…" : ""}
        </button>
      </div>

      {status && (
        <div style={{ padding: "6px 10px", fontSize: 12, background: dark ? "#333" : "#f2f2f2", borderBottom: `1px solid ${border}`, wordBreak: "break-all" }}>
          {status}
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", fontSize: 13 }}>
        {tab === "installed" ? (
          installed.length === 0 ? (
            <div style={{ padding: 20, opacity: 0.65, lineHeight: 1.8 }}>
              还没有安装插件。切到「插件市场」可直接安装 Obsidian 官方市场的插件。
              <br />
              也可以手动把插件放进 <code>.obsidian/plugins/&lt;id&gt;/</code>，然后点「刷新」。
              <br />
              <button style={{ ...btn, marginTop: 10 }} onClick={() => { void refreshInstalled(); void obsidianRuntime.reload(); onChanged(); }}>
                刷新
              </button>
            </div>
          ) : (
            installedGroups.map(([key, list]) => (
              <div key={key}>
                <div style={{ padding: "10px 10px 4px", fontWeight: 600, fontSize: 12, opacity: 0.8 }}>
                  {categoryLabel(key)}（{list.length}）
                </div>
                {list.map((p) => {
                  const rt = runtimeList.find((r) => r.id === p.id);
                  return (
                    <div key={p.id} style={cardStyle}>
                      <input type="checkbox" checked={p.enabled} onChange={() => void toggleEnabled(p)} title="启用/禁用" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>
                          <span title={compatTitle(compat[p.id])} style={{ marginRight: 5 }}>{compatBadge(compat[p.id]).icon}</span>
                          {p.name} <span style={{ opacity: 0.6, fontWeight: 400 }}>{p.version}</span>
                        </div>
                        <div style={{ opacity: 0.65, fontSize: 12, marginTop: 2 }}>{p.description}</div>
                        <div style={{ opacity: 0.5, fontSize: 11, marginTop: 2 }}>
                          {p.author} · {Math.round(p.bytes / 1024)} KB · {p.id}
                          {!p.has_main && <span style={{ color: "#d33" }}> · 缺少 main.js</span>}
                          {p.enabled && rt?.error && <span style={{ color: "#d33" }}> · 加载失败：{rt.error}</span>}
                          {p.enabled && !rt?.error && rt?.loaded && (
                            <span style={{ color: "#2a7" }}> · 已加载（命令 {rt.commands.length} / 视图 {rt.views.length}）</span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <button
                          style={btn}
                          onClick={() => onOpenPluginSettings(p.id)}
                          title={rt?.hasSettings ? "插件自己的设置页" : "这个插件没有设置页"}
                          disabled={!rt?.hasSettings}
                        >
                          设置
                        </button>
                        <button style={btn} onClick={() => void uninstall(p)} title="删除插件目录">
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )
        ) : (
          <>
            <div style={{ padding: 8, display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>排序</span>
              <select
                value={sort}
                onChange={(e) => changeSort(e.target.value as MarketSort)}
                style={{ padding: "4px 6px", fontSize: 12, font: "inherit", background: dark ? "#333" : "#fff", color: fg, border: `1px solid ${border}`, borderRadius: 4 }}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span style={{ fontSize: 11, opacity: 0.5 }}>兼容性通过的排前面</span>
            </div>
            <div style={{ padding: "0 8px 8px", display: "flex", gap: 6 }}>
              <input
                value={query}
                onChange={(e) => void search(e.target.value)}
                placeholder="搜索官方市场（8451 个插件）…"
                style={{ flex: 1, padding: "5px 8px", fontSize: 13, font: "inherit", background: dark ? "#333" : "#fff", color: fg, border: `1px solid ${border}`, borderRadius: 4 }}
              />
              {query && (
                <button
                  style={btn}
                  onClick={() => {
                    setQuery("");
                    void invoke<string>("marketplace_index").then(async (indexJson) => {
                      setMarket(await invoke<MarketEntry[]>("marketplace_search", {
                        indexJson, statsJson, compatJson: JSON.stringify(compat), query: "", sort, limit: 60,
                      }));
                    });
                  }}
                >
                  重置
                </button>
              )}
            </div>
            {market.map((e) => {
              const entry = compat[e.id];
              const badge = compatBadge(entry);
              return (
                <div key={e.id} style={cardStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>
                      <span title={compatTitle(entry)} style={{ marginRight: 5 }}>{badge.icon}</span>
                      {e.name}
                    </div>
                    <div style={{ opacity: 0.65, fontSize: 12, marginTop: 2 }}>{e.description}</div>
                    <div style={{ opacity: 0.5, fontSize: 11, marginTop: 2 }}>
                      {e.author} · {e.repo}
                      {formatDownloads(e.downloads) && <span> · ⬇ {formatDownloads(e.downloads)}</span>}
                      <span style={{ color: badge.color }}> · {badge.label}</span>
                    </div>
                  </div>
                  {installedIds.has(e.id) ? (
                    <span style={{ fontSize: 12, opacity: 0.6 }}>已安装</span>
                  ) : (
                    <button style={btn} disabled={installing === e.id} onClick={() => void install(e)}>
                      {installing === e.id ? "安装中…" : "安装"}
                    </button>
                  )}
                </div>
              );
            })}
            {!loading && market.length === 0 && (
              <div style={{ padding: 20, opacity: 0.65 }}>没有匹配的插件</div>
            )}
          </>
        )}
      </div>

      <div style={{ padding: 8, borderTop: `1px solid ${border}`, display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button style={btn} onClick={() => void (async () => { await refreshInstalled(); await obsidianRuntime.reload(); onChanged(); })}>
          刷新并重新加载
        </button>
        <button style={btn} onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  border: "1px solid #bbb",
  background: "transparent",
  color: "inherit",
  borderRadius: 4,
  cursor: "pointer",
  padding: "3px 10px",
  fontSize: 12,
  fontFamily: "inherit",
};
