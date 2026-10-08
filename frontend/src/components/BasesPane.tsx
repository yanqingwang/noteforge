/**
 * `.base` 主面板。
 *
 * 承载 Obsidian 的 Bases 视图：工具栏（视图切换 / 布局 / 筛选 / 排序 / 列 / 汇总 /
 * 结果数 / 导出）+ 视图主体（内置 table、list，或插件 registerBasesView 注册的类型）。
 *
 * 只读：改动只进会话态叠加层，不写回 .base 文件（写回是后续独立增量）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parse as parseYaml } from "yaml";
import { parseConfig, type BasesConfigFile, type BasesConfigFileView, type BasesPropertyId } from "../plugins/obsidian/bases/config";
import { DEFAULT_SUMMARIES, defaultOrder, propertyValue, runQuery, summaryValue, type QueryRow } from "../plugins/obsidian/bases/query";
import { currentBasesHost, mountBasesView } from "../plugins/obsidian/bases/registry";
import type { BasesOption } from "../plugins/obsidian/bases/api";
import { Value } from "../plugins/obsidian/bases/expr/values";
import { humanizePropertyName } from "./bases/labels";
import {
  applyOverlay,
  formatSortLines,
  formatSummaryLines,
  overlayDirty,
  parsePropertyLines,
  parseSortLines,
  parseSummaryLines,
  type SessionOverlay,
  type ViewOverride,
} from "./bases/view-state";

export interface BasesPaneProps {
  /** .base 文件的 vault 内路径 */
  basePath: string;
  dark: boolean;
  /** 点文件链接时跳过去 */
  onNavigate: (path: string) => void;
  onStatus: (msg: string) => void;
  /** 视图内容有变化时通知外层（用于刷新嵌入） */
  onDirtyChange?: (dirty: boolean) => void;
}

interface LoadState {
  config: BasesConfigFile;
  raw: string;
  error: string | null;
  /** YAML 改了就重载 */
  stamp: string;
}

export function BasesPane({ basePath, dark, onNavigate, onStatus, onDirtyChange }: BasesPaneProps): React.ReactElement {
  const [state, setState] = useState<LoadState | null>(null);
  const [activeView, setActiveView] = useState<string>("");
  const [overlay, setOverlay] = useState<SessionOverlay>({});
  const [tool, setTool] = useState<null | "filter" | "sort" | "order" | "summary" | "options">(null);
  const [draft, setDraft] = useState("");
  const pluginHostRef = useRef<HTMLDivElement | null>(null);
  const [pluginMounted, setPluginMounted] = useState<string | null>(null);

  // ── 读 .base 文件 ────────────────────────────────────────────────
  const reload = useCallback(async () => {
    try {
      const raw = await invoke<string>("read_file", { path: basePath });
      const parsed = parseConfig(raw);
      setState({
        config: parsed.config,
        raw,
        error: parsed.error,
        stamp: `${raw.length}:${raw.slice(0, 64)}`,
      });
      setActiveView((prev) => {
        const names = (parsed.config.views ?? []).map((v) => v.name);
        return prev && names.includes(prev) ? prev : (names[0] ?? "");
      });
    } catch (e) {
      setState({ config: { views: [] }, raw: "", error: `读取失败：${e}`, stamp: "" });
    }
  }, [basePath]);

  useEffect(() => {
    void reload();
    setOverlay({});
    setTool(null);
  }, [reload]);

  // 外部改了 .base 就重载（与编辑器那边对磁盘变更的处理一致）
  useEffect(() => {
    let stopped = false;
    let last = "";
    const timer = setInterval(async () => {
      if (stopped) return;
      try {
        const s = await invoke<{ mtime_ms: number; size: number }>("stat_note", { notePath: basePath });
        const key = `${s.mtime_ms}:${s.size}`;
        if (last && key !== last) await reload();
        last = key;
      } catch {
        /* 文件没了就等下一次 */
      }
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [basePath, reload]);

  // ── 视图与结果集 ─────────────────────────────────────────────────
  const views = useMemo(() => (state ? applyOverlay(state.config, overlay) : []), [state, overlay]);
  const view: BasesConfigFileView | null = views.find((v) => v.name === activeView) ?? views[0] ?? null;
  const dirty = overlayDirty(overlay);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const host = currentBasesHost();
  const outcome = useMemo(() => {
    if (!state || !view || !host) return null;
    return runQuery(
      { config: state.config, fileApi: host.fileApi, files: host.files(), selfPath: basePath },
      view,
    );
  }, [state, view, host, basePath]);

  const viewTypes = host?.viewTypes() ?? [];
  const currentType = view?.type ?? "table";
  const isPluginView = Boolean(view && !viewTypes.find((t) => t.type === currentType)?.builtin);

  // ── 插件视图挂载 ─────────────────────────────────────────────────
  useEffect(() => {
    const el = pluginHostRef.current;
    if (!el || !state || !view || !host) return;
    if (!isPluginView) {
      el.replaceChildren();
      setPluginMounted(null);
      return;
    }
    const mounted = mountBasesView({
      viewType: view.type,
      config: state.config,
      view,
      containerEl: el,
      app: {},
      selfPath: basePath,
      fileApi: host.fileApi,
    });
    setPluginMounted(mounted ? view.type : null);
    if (!mounted) {
      el.replaceChildren();
      const pre = document.createElement("pre");
      pre.textContent = `视图类型「${view.type}」没有可用的 factory（插件可能没加载）`;
      pre.style.cssText = "color:#c33;white-space:pre-wrap;padding:8px";
      el.appendChild(pre);
    }
    return () => {
      el?.replaceChildren();
    };
  }, [state, view, host, basePath, isPluginView]);

  const setOv = useCallback(
    (patch: ViewOverride) => {
      if (!activeView) return;
      setOverlay((prev) => ({ ...prev, [activeView]: { ...(prev[activeView] ?? {}), ...patch } }));
    },
    [activeView],
  );

  const resetOverlay = useCallback(() => {
    setOverlay({});
    setTool(null);
    onStatus("已放弃会话内的视图改动（.base 文件本来就没被改过）");
  }, [onStatus]);

  if (!state) return <div style={panelStyle(dark)}>正在读取 {basePath} …</div>;
  if (state.error) {
    return (
      <div style={panelStyle(dark)}>
        <div style={errStyle()}>`.base` 解析失败：{state.error}</div>
        <pre style={{ fontSize: 12, color: dark ? "#bbb" : "#555", whiteSpace: "pre-wrap", padding: 12 }}>{state.raw.slice(0, 2000)}</pre>
      </div>
    );
  }

  const rows = outcome?.rows ?? [];
  const errors = outcome?.errors ?? [];
  const allProps = outcome?.allProperties ?? [];

  return (
    <div style={panelStyle(dark)}>
      {/* ── 工具栏 ── */}
      <div style={toolbarStyle(dark)}>
        <select
          value={activeView}
          onChange={(e) => {
            setActiveView(e.target.value);
            setTool(null);
          }}
          title="视图"
          style={selectStyle(dark)}
        >
          {views.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>

        <select
          value={currentType}
          onChange={(e) => setOv({ type: e.target.value })}
          title="布局"
          style={selectStyle(dark)}
        >
          <optgroup label="内置">
            {viewTypes.filter((t) => t.builtin).map((t) => (
              <option key={t.type} value={t.type}>
                {t.name}
              </option>
            ))}
          </optgroup>
          {viewTypes.some((t) => !t.builtin) && (
            <optgroup label="插件">
              {viewTypes.filter((t) => !t.builtin).map((t) => (
                <option key={t.type} value={t.type}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        <ToolbarButton label="筛选" active={tool === "filter"} onClick={() => openTool("filter")} />
        <ToolbarButton label="排序" active={tool === "sort"} onClick={() => openTool("sort")} />
        <ToolbarButton label="列" active={tool === "order"} onClick={() => openTool("order")} />
        <ToolbarButton label="汇总" active={tool === "summary"} onClick={() => openTool("summary")} />
        {isPluginView && viewTypes.find((t) => t.type === currentType)?.options && (
          <ToolbarButton label="视图设置" active={tool === "options"} onClick={() => openTool("options")} />
        )}

        <span style={{ flex: 1 }} />
        <span style={countStyle()} title="结果数（limit 之前的全部命中）">
          {outcome ? outcome.matched.length : 0} 项
          {view?.limit ? ` / 显示 ${rows.length}` : ""}
        </span>
        {dirty && (
          <>
            <span style={{ ...badgeStyle(dark), color: "#b8860b" }} title="改动只在本次会话里，.base 文件没有被修改">
              未保存
            </span>
            <button onClick={resetOverlay} style={btnStyle(dark)} title="放弃本次会话里的视图改动">
              放弃改动
            </button>
          </>
        )}
        <button
          onClick={() => exportCsv(rows, view, outcome, basePath, onStatus)}
          disabled={rows.length === 0}
          style={{ ...btnStyle(dark), opacity: rows.length ? 1 : 0.5 }}
          title="把当前结果导出成 CSV"
        >
          导出 CSV
        </button>
      </div>

      {/* ── 工具面板 ── */}
      {tool && (
        <ToolPanel
          tool={tool}
          dark={dark}
          view={view}
          allProperties={allProps}
          draft={draft}
          onDraft={setDraft}
          onApply={(text) => applyTool(tool, text, setOv, setTool, setDraft, onStatus)}
          onOptionChange={(k, v) => setOv({ options: { ...(overlay[activeView]?.options ?? {}), [k]: v } })}
          optionItems={isPluginView ? optionItemsOf(viewTypes.find((t) => t.type === currentType)?.options) : []}
          onClose={() => {
            setTool(null);
            setDraft("");
          }}
        />
      )}

      {errors.length > 0 && (
        <details style={errBoxStyle(dark)}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "#b25" }}>
            {errors.length} 处求值问题（点开看）
          </summary>
          <pre style={{ fontSize: 11, margin: "6px 0 0", whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{errors.join("\n")}</pre>
        </details>
      )}

      {/* ── 主体 ── */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {isPluginView ? (
          <div ref={pluginHostRef} style={{ padding: 8, minHeight: 120 }} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 16, color: dark ? "#888" : "#999", fontSize: 13 }}>没有符合条件的文件</div>
        ) : currentType === "list" ? (
          <ListBody rows={rows} view={view} dark={dark} allProperties={allProps} onNavigate={onNavigate} fileApi={host?.fileApi} selfPath={basePath} />
        ) : (
          <TableBody
            rows={rows}
            view={view}
            dark={dark}
            allProperties={allProps}
            onNavigate={onNavigate}
            fileApi={host?.fileApi}
            selfPath={basePath}
            customSummaries={state.config.summaries}
            onSortToggle={(propertyId) => {
              const cur = view?.sort ?? [];
              const i = cur.findIndex((s) => s.property === propertyId);
              let next: typeof cur;
              if (i < 0) next = [...cur, { property: propertyId, direction: "ASC" as const }];
              else if (cur[i].direction === "ASC") next = cur.map((s, k) => (k === i ? { ...s, direction: "DESC" as const } : s));
              else next = cur.filter((_, k) => k !== i);
              setOv({ sort: next });
            }}
          />
        )}
      </div>

      <div style={footerStyle(dark)}>
        <span>{basePath}</span>
        {pluginMounted && <span>· 插件视图 {pluginMounted}</span>}
        {view?.filters !== undefined && <span>· 有筛选条件</span>}
        {view?.groupBy && <span>· 按 {view.groupBy.property} 分组</span>}
      </div>
    </div>
  );

  function openTool(which: NonNullable<typeof tool>): void {
    if (tool === which) {
      setTool(null);
      return;
    }
    setTool(which);
    if (which === "filter") setDraft(yamlOf(view?.filters));
    else if (which === "sort") setDraft(formatSortLines(view?.sort));
    else if (which === "order") setDraft((view?.order ?? []).join("\n"));
    else if (which === "summary") setDraft(formatSummaryLines(view?.summaries));
    else if (which === "options") setDraft("");
  }

  function applyTool(
    which: NonNullable<typeof tool>,
    text: string,
    patch: (o: ViewOverride) => void,
    close: (t: null) => void,
    resetDraft: (t: string) => void,
    status: (m: string) => void,
  ): void {
    if (which === "filter") {
      try {
        patch({ filters: yamlOfParse(text) });
        status("筛选已更新（仅本次会话）");
      } catch (e) {
        status(`筛选 YAML 有问题：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else if (which === "sort") patch({ sort: parseSortLines(text) });
    else if (which === "order") patch({ order: parsePropertyLines(text) });
    else if (which === "summary") patch({ summaries: parseSummaryLines(text) });
    close(null);
    resetDraft("");
  }
}

/**
 * 筛选条件的文本形式。
 *
 * 官方的高级筛选编辑器就是「直接显示 .base 语法」，所以这里给同样的东西：
 * 一行一条语句（等价于 and 列表），也可以直接写 and/or/not 的 YAML 块。
 */
function yamlOf(filter: BasesConfigFileView["filters"]): string {
  if (filter === undefined) return "";
  if (typeof filter === "string") return filter;
  const parts: string[] = [];
  for (const key of ["and", "or", "not"] as const) {
    const list = filter[key];
    if (!Array.isArray(list)) continue;
    parts.push(`${key}:`);
    for (const f of list) parts.push(`  - ${typeof f === "string" ? JSON.stringify(f) : JSON.stringify(f)}`);
  }
  return parts.join("\n");
}

function yamlOfParse(text: string): BasesConfigFileView["filters"] | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // 每行一条语句（没有 YAML 结构标记时）
  if (!/^[\s]*[a-z]+:\s*$/m.test(trimmed)) {
    const lines = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (lines.length === 1) return lines[0];
    return { and: lines };
  }
  const doc = parseYaml(trimmed) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("顶层必须是 and/or/not 之一");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k !== "and" && k !== "or" && k !== "not") throw new Error(`只认 and / or / not，遇到 “${k}”`);
    if (!Array.isArray(v)) throw new Error(`${k} 必须是一个列表`);
    out[k] = v;
  }
  return out as BasesConfigFileView["filters"];
}


// ── 表格 ────────────────────────────────────────────────────────────

interface BodyProps {
  rows: QueryRow[];
  view: BasesConfigFileView;
  dark: boolean;
  allProperties: BasesPropertyId[];
  onNavigate: (path: string) => void;
  fileApi: NonNullable<ReturnType<typeof currentBasesHost>>["fileApi"] | undefined;
  selfPath: string;
}

function columnsOf(view: BasesConfigFileView, allProperties: BasesPropertyId[]): BasesPropertyId[] {
  return view.order && view.order.length ? view.order : defaultOrder(allProperties);
}

function TableBody(props: BodyProps & {
  customSummaries?: Record<string, string>;
  onSortToggle: (propertyId: BasesPropertyId) => void;
}): React.ReactElement {
  const { rows, view, dark, allProperties, onNavigate, fileApi, selfPath, customSummaries, onSortToggle } = props;
  const columns = columnsOf(view, allProperties);
  const groups = useMemo(() => groupRows(rows, view), [rows, view]);
  const displayNames = useMemo(() => displayNameMap(view), [view]);
  const sortOf = (prop: BasesPropertyId): "ASC" | "DESC" | null => view.sort?.find((s) => s.property === prop)?.direction ?? null;

  return (
    <table style={tableStyle()}>
      <thead>
        <tr>
          {columns.map((c) => {
            const dir = sortOf(c);
            return (
              <th key={c} style={thStyle(dark)}>
                <button
                  onClick={() => onSortToggle(c)}
                  title={`按 ${c} 排序（点三次取消）`}
                  style={{ ...thBtnStyle, opacity: dir ? 1 : 0.6 }}
                >
                  {displayNames[c] ?? humanizePropertyName(c)}
                  {dir ? (dir === "ASC" ? " ▲" : " ▼") : ""}
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.label}>
          {g.label !== null && (
            <tr>
              <td colSpan={Math.max(1, columns.length)} style={groupStyle(dark)}>
                {g.label} <span style={{ opacity: 0.6 }}>({g.rows.length})</span>
              </td>
            </tr>
          )}
          {g.rows.map((row) => (
            <tr key={row.path}>
              {columns.map((c) => (
                <td key={c} style={tdStyle(dark)}>
                  <Cell
                    row={row}
                    propertyId={c}
                    onNavigate={onNavigate}
                    fileApi={fileApi}
                    selfPath={selfPath}
                  />
                </td>
              ))}
            </tr>
          ))}
          {view.summaries && Object.keys(view.summaries).length > 0 && (
            <tr>
              {columns.map((c) => {
                const key = view.summaries?.[c];
                const v = key && fileApi ? summaryValue(key, rows, c, customSummaries, fileApi, selfPath) : null;
                return (
                  <td key={c} style={{ ...tdStyle(dark), fontWeight: 600, background: dark ? "#262626" : "#f6f6f6" }}>
                    {key ? `${key}: ${v?.toString() ?? ""}` : ""}
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );
}

function ListBody(props: BodyProps): React.ReactElement {
  const { rows, view, dark, allProperties, onNavigate, fileApi, selfPath } = props;
  const columns = columnsOf(view, allProperties);
  const groups = useMemo(() => groupRows(rows, view), [rows, view]);
  const displayNames = useMemo(() => displayNameMap(view), [view]);
  return (
    <div style={{ padding: "4px 0" }}>
      {groups.map((g) => (
        <div key={g.label ?? "__none"}>
          {g.label !== null && (
            <div style={groupBlockStyle(dark)}>
              {g.label} <span style={{ opacity: 0.6 }}>({g.rows.length})</span>
            </div>
          )}
          {g.rows.map((row) => (
            <div key={row.path} style={listItemStyle(dark)}>
              {columns.map((c, i) => {
                const v = propertyValue(row, c);
                if (v.isEmpty()) return null;
                return (
                  <span key={c} style={{ display: "inline-flex", alignItems: "baseline", gap: 4 }}>
                    {i > 0 && <span style={{ opacity: 0.4 }}>·</span>}
                    <span style={{ opacity: 0.65, fontSize: 11 }} title={c}>
                      {displayNames[c] ?? humanizePropertyName(c)}
                    </span>
                    <Cell row={row} propertyId={c} onNavigate={onNavigate} fileApi={fileApi} selfPath={selfPath} />
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 单个单元格的值渲染（走 Value.renderTo，链接/图片/复选框各自正确渲染） */
function Cell(props: {
  row: QueryRow;
  propertyId: BasesPropertyId;
  onNavigate: (path: string) => void;
  fileApi: BodyProps["fileApi"];
  selfPath: string;
}): React.ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null);
  const { row, propertyId, onNavigate, selfPath } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren();
    let v: Value | null = null;
    try {
      v = propertyValue(row, propertyId);
    } catch {
      v = null;
    }
    if (!v || v.isEmpty()) {
      el.textContent = "";
      return;
    }
    try {
      v.renderTo(el, {
        sourcePath: selfPath,
        openFile: (p) => onNavigate(p),
      });
    } catch {
      el.textContent = v.toString();
    }
  }, [row, propertyId, onNavigate, selfPath]);
  return <span ref={ref} />;
}

/** 按 groupBy 分组（返回带标题的行数组） */
function groupRows(rows: QueryRow[], view: BasesConfigFileView): Array<{ label: string | null; rows: QueryRow[] }> {
  const prop = view.groupBy?.property;
  if (!prop) return [{ label: null, rows }];
  const buckets = new Map<string, { label: string | null; rows: QueryRow[] }>();
  for (const row of rows) {
    let label: string;
    try {
      const v = propertyValue(row, prop);
      label = v.isEmpty() ? "" : v.toString();
    } catch {
      label = "";
    }
    const key = label;
    let b = buckets.get(key);
    if (!b) {
      b = { label: label || "（无值）", rows: [] };
      buckets.set(key, b);
    }
    b.rows.push(row);
  }
  if (view.groupOrder !== undefined) {
    const out: Array<{ label: string | null; rows: QueryRow[] }> = [];
    for (const want of view.groupOrder) {
      const key = want === null ? "" : String(want);
      const b = buckets.get(key);
      if (b) out.push(b);
    }
    return out;
  }
  const desc = view.groupBy?.direction === "DESC";
  return [...buckets.values()].sort((a, b) => {
    const an = a.label === "（无值）";
    const bn = b.label === "（无值）";
    if (an !== bn) return an ? 1 : -1;
    return desc ? (a.label! < b.label! ? 1 : -1) : a.label! < b.label! ? -1 : 1;
  });
}

/** properties 里配的 displayName */
function displayNameMap(view: BasesConfigFileView): Record<string, string> {
  const out: Record<string, string> = {};
  const props = (view as unknown as { properties?: Record<string, { displayName?: string }> }).properties;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v?.displayName) out[k] = v.displayName;
  }
  return out;
}

/** 导出 CSV */
function exportCsv(
  rows: QueryRow[],
  view: BasesConfigFileView | null,
  outcome: ReturnType<typeof runQuery> | null,
  basePath: string,
  onStatus: (m: string) => void,
): void {
  if (!view || !outcome) return;
  const columns = view.order && view.order.length ? view.order : defaultOrder(outcome.allProperties);
  const names = columns.map((c) => displayNameMap(view)[c] ?? humanizePropertyName(c));
  const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [names.map(esc).join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          try {
            return esc(propertyValue(row, c).toString());
          } catch {
            return "";
          }
        })
        .join(","),
    );
  }
  // BOM：Excel 打开中文 CSV 需要它，否则全是乱码
  const csv = `\uFEFF${lines.join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${basePath.split("/").pop()?.replace(/\.base$/, "") ?? "base"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  onStatus(`已导出 ${rows.length} 行 CSV`);
}

// ── 工具面板 ────────────────────────────────────────────────────────

type ToolKind = "filter" | "sort" | "order" | "summary" | "options";

function ToolPanel(props: {
  tool: ToolKind;
  dark: boolean;
  view: BasesConfigFileView | null;
  allProperties: BasesPropertyId[];
  draft: string;
  onDraft: (s: string) => void;
  onApply: (s: string) => void;
  onOptionChange: (key: string, value: unknown) => void;
  optionItems: BasesOption[];
  onClose: () => void;
}): React.ReactElement {
  const { tool, dark, draft, onDraft, onApply, onClose, view, allProperties, optionItems, onOptionChange } = props;
  const titles: Record<ToolKind, string> = {
    filter: "筛选（官方 Bases 语法，一行一条；and / or / not 都支持）",
    sort: "排序（每行一条：属性名 + 可选 ASC/DESC）",
    order: "显示的属性（每行一个属性 ID，空的用默认列）",
    summary: "汇总（每行一条：属性ID: 汇总名）",
    options: "视图设置",
  };
  const hints: Record<ToolKind, string> = {
    filter: "例：status == \"done\"　file.hasTag(\"book\")　price > 10",
    sort: "例：file.mtime DESC　file.name ASC",
    order: "例：file.name　note.status　formula.ppu",
    summary: `可用汇总：${DEFAULT_SUMMARIES.join(" / ")}`,
    options: "",
  };
  return (
    <div style={toolPanelStyle(dark)}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 4 }}>
        <strong style={{ fontSize: 12 }}>{titles[tool]}</strong>
        {hints[tool] && <span style={{ fontSize: 11, opacity: 0.65 }}>{hints[tool]}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={btnStyle(dark)}>
          收起
        </button>
      </div>
      {tool === "options" ? (
        <OptionsForm dark={dark} view={view} items={optionItems} onChange={onOptionChange} />
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))}
            style={textareaStyle(dark)}
            spellCheck={false}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
            <button onClick={() => onApply(draft)} style={btnStyle(dark)}>
              应用
            </button>
            {tool === "summary" && (
              <span style={{ fontSize: 11, opacity: 0.6 }}>共 {Object.keys(view?.summaries ?? {}).length} 项</span>
            )}
            {tool === "order" && (
              <span style={{ fontSize: 11, opacity: 0.6 }}>可用属性 {allProperties.length} 个</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 调插件声明的 options() 并展平分组，拿不到就当没声明（插件的 options 抛错不该挡住界面） */
export function optionItemsOf(
  options: ((cfg: never) => unknown) | undefined,
): BasesOption[] {
  if (!options) return [];
  try {
    const out: BasesOption[] = [];
    for (const item of options({} as never) as Array<Record<string, unknown>>) {
      if (item && Array.isArray(item.options)) out.push(...(item.options as BasesOption[]));
      else out.push(item as unknown as BasesOption);
    }
    return out;
  } catch {
    return [];
  }
}

/** 插件视图的声明式 options 表单 */
function OptionsForm(props: {
  dark: boolean;
  view: BasesConfigFileView | null;
  items: BasesOption[];
  onChange: (key: string, value: unknown) => void;
}): React.ReactElement {
  const { dark, view, onChange, items } = props;
  if (!items.length) return <div style={{ fontSize: 12, opacity: 0.7 }}>这个视图没有声明 options</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
      {items.map((o) => {
        const cur = (view as unknown as Record<string, unknown>)?.[o.key] ?? o.default;
        return (
          <label key={o.key} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11 }}>
            <span style={{ opacity: 0.75 }}>{o.displayName}</span>
            {o.type === "toggle" ? (
              <input
                type="checkbox"
                checked={Boolean(cur)}
                onChange={(e) => onChange(o.key, e.target.checked)}
                style={{ justifySelf: "start" }}
              />
            ) : o.type === "dropdown" ? (
              <select value={String(cur ?? "")} onChange={(e) => onChange(o.key, e.target.value)} style={selectStyle(dark)}>
                {(o.options ?? []).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label ?? opt.value}
                  </option>
                ))}
              </select>
            ) : o.type === "slider" ? (
              <input
                type="range"
                min={o.min ?? 0}
                max={o.max ?? 100}
                step={o.step ?? 1}
                value={Number(cur ?? o.default ?? 0)}
                onChange={(e) => onChange(o.key, Number(e.target.value))}
              />
            ) : o.type === "multitext" ? (
              <input
                type="text"
                value={Array.isArray(cur) ? cur.join(", ") : String(cur ?? "")}
                placeholder={o.placeholder ?? "逗号分隔"}
                onChange={(e) =>
                  onChange(
                    o.key,
                    e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  )
                }
                style={inputStyle(dark)}
              />
            ) : (
              <input
                type="text"
                value={String(cur ?? o.default ?? "")}
                placeholder={o.placeholder ?? ""}
                onChange={(e) => onChange(o.key, e.target.value)}
                style={inputStyle(dark)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

function ToolbarButton(props: { label: string; active: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      onClick={props.onClick}
      style={{
        padding: "2px 8px",
        border: `1px solid ${props.active ? "#4a90d9" : "transparent"}`,
        borderRadius: 4,
        background: props.active ? "rgba(74,144,217,.16)" : "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      {props.label}
    </button>
  );
}

// ── 样式 ────────────────────────────────────────────────────────────

function panelStyle(dark: boolean): React.CSSProperties {
  return {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: dark ? "#1e1e1e" : "#fff",
    color: dark ? "#ddd" : "#222",
    minHeight: 0,
  };
}
function toolbarStyle(dark: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 8px",
    borderBottom: `1px solid ${dark ? "#333" : "#e5e5e5"}`,
    fontSize: 12,
    flexWrap: "wrap",
  };
}
function selectStyle(dark: boolean): React.CSSProperties {
  return {
    background: dark ? "#2a2a2a" : "#fff",
    color: "inherit",
    border: `1px solid ${dark ? "#3a3a3a" : "#ddd"}`,
    borderRadius: 4,
    fontSize: 12,
    padding: "2px 4px",
    maxWidth: 180,
  };
}
function inputStyle(dark: boolean): React.CSSProperties {
  return {
    background: dark ? "#2a2a2a" : "#fff",
    color: "inherit",
    border: `1px solid ${dark ? "#3a3a3a" : "#ddd"}`,
    borderRadius: 4,
    fontSize: 12,
    padding: "2px 4px",
  };
}
function textareaStyle(dark: boolean): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    background: dark ? "#2a2a2a" : "#fff",
    color: "inherit",
    border: `1px solid ${dark ? "#3a3a3a" : "#ddd"}`,
    borderRadius: 4,
    fontSize: 12,
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    padding: 6,
  };
}
function btnStyle(dark: boolean): React.CSSProperties {
  return {
    padding: "2px 8px",
    border: `1px solid ${dark ? "#3a3a3a" : "#ddd"}`,
    borderRadius: 4,
    background: dark ? "#2a2a2a" : "#fafafa",
    color: "inherit",
    cursor: "pointer",
    fontSize: 12,
  };
}
function tableStyle(): React.CSSProperties {
  return { width: "100%", borderCollapse: "collapse", fontSize: 12 };
}
function thStyle(dark: boolean): React.CSSProperties {
  return {
    textAlign: "left",
    padding: "4px 8px",
    borderBottom: `1px solid ${dark ? "#3a3a3a" : "#ddd"}`,
    position: "sticky",
    top: 0,
    background: dark ? "#252525" : "#fafafa",
    whiteSpace: "nowrap",
  };
}
const thBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  padding: 0,
  fontWeight: 600,
};
function tdStyle(dark: boolean): React.CSSProperties {
  return { padding: "3px 8px", borderBottom: `1px solid ${dark ? "#2e2e2e" : "#f0f0f0"}`, verticalAlign: "top" };
}
function groupStyle(dark: boolean): React.CSSProperties {
  return { padding: "4px 8px", background: dark ? "#2b2b2b" : "#f2f2f2", fontWeight: 600, fontSize: 12 };
}
function groupBlockStyle(dark: boolean): React.CSSProperties {
  return { padding: "6px 10px 2px", fontWeight: 600, fontSize: 12, color: dark ? "#bbb" : "#555" };
}
function listItemStyle(dark: boolean): React.CSSProperties {
  return {
    padding: "3px 12px",
    borderBottom: `1px solid ${dark ? "#2a2a2a" : "#f5f5f5"}`,
    fontSize: 12,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: 2,
  };
}
function toolPanelStyle(dark: boolean): React.CSSProperties {
  return { padding: "6px 8px", borderBottom: `1px solid ${dark ? "#333" : "#e5e5e5"}`, background: dark ? "#232323" : "#fafafa" };
}
function footerStyle(dark: boolean): React.CSSProperties {
  return {
    padding: "2px 8px",
    borderTop: `1px solid ${dark ? "#333" : "#e5e5e5"}`,
    fontSize: 11,
    opacity: 0.65,
    display: "flex",
    gap: 8,
  };
}
function errBoxStyle(dark: boolean): React.CSSProperties {
  return { padding: "4px 8px", background: dark ? "#2a1f1f" : "#fff5f5", borderBottom: `1px solid ${dark ? "#4a2a2a" : "#f0d0d0"}` };
}
function errStyle(): React.CSSProperties {
  return { padding: 10, color: "#c33", fontSize: 13 };
}
function countStyle(): React.CSSProperties {
  return { fontSize: 11, opacity: 0.7 };
}
function badgeStyle(dark: boolean): React.CSSProperties {
  return { fontSize: 11, border: `1px solid ${dark ? "#5a4a20" : "#e0d0a0"}`, borderRadius: 3, padding: "0 4px" };
}
