/**
 * `.base` 的会话态叠加层。
 *
 * 现状是**只读**：noteforge 不会改用户 vault 里的 .base 文件。但工具栏仍然要能用
 * —— 切视图、换布局、调筛选/排序/列/汇总 —— 否则 base 文件里已有的视图配置
 * 之外什么都做不了。
 *
 * 所以做法是：解析出的配置之上叠一层「内存里的视图改动」，UI 全走叠加层，
 * 并明确标出「未保存」。落盘（写回 .base YAML）是后续一期的独立增量。
 */

import type { BasesConfigFile, BasesConfigFileView, BasesPropertyId, BasesSortConfig } from "../../plugins/obsidian/bases/config";

/** 一个视图在会话里的覆盖项（全部可选，只写用户动过的那些） */
export interface ViewOverride {
  type?: string;
  filters?: unknown;
  sort?: BasesSortConfig[];
  order?: BasesPropertyId[];
  limit?: number;
  groupBy?: BasesConfigFileView["groupBy"];
  summaries?: Record<string, string>;
  /** 插件视图的 options 值（key → 值） */
  options?: Record<string, unknown>;
}

/** 会话态：视图名 → 覆盖项 */
export type SessionOverlay = Record<string, ViewOverride>;

/** 把覆盖项应用到视图配置上，返回一个新的 view 对象 */
export function applyOverride(view: BasesConfigFileView, ov: ViewOverride | undefined): BasesConfigFileView {
  if (!ov) return view;
  const out: BasesConfigFileView = { ...view };
  if (ov.type !== undefined) out.type = ov.type;
  if (ov.filters !== undefined) out.filters = ov.filters as BasesConfigFileView["filters"];
  if (ov.sort !== undefined) out.sort = ov.sort;
  if (ov.order !== undefined) out.order = ov.order;
  if (ov.limit !== undefined) out.limit = ov.limit;
  if (ov.groupBy !== undefined) out.groupBy = ov.groupBy;
  if (ov.summaries !== undefined) out.summaries = ov.summaries;
  // 插件视图的 options 也进视图对象（官方语义：用户填的值自动存进 .base）
  if (ov.options) {
    for (const [k, v] of Object.entries(ov.options)) {
      if (!CORE_KEYS.has(k)) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

const CORE_KEYS = new Set(["type", "name", "filters", "order", "sort", "groupBy", "groupOrder", "limit", "summaries"]);

/** 应用整份叠加层 */
export function applyOverlay(config: BasesConfigFile, overlay: SessionOverlay): BasesConfigFileView[] {
  const views = config.views ?? [{ type: "table", name: "Table" }];
  return views.map((v) => applyOverride(v, overlay[v.name]));
}

/** 视图的 options 在 config 对象上的合成结果（给 config.get() 用） */
export function optionDefaultsOf(view: BasesConfigFileView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(view)) {
    if (!CORE_KEYS.has(k)) out[k] = view[k];
  }
  return out;
}

/** 叠加层里是否有任何改动（用来显示「未保存」标记） */
export function overlayDirty(overlay: SessionOverlay): boolean {
  return Object.values(overlay).some((ov) => Object.keys(ov).length > 0);
}

/**
 * 解析排序输入。工具栏给的是人类可读的一行行文本（`file.mtime DESC`），
 * 这里转成 BasesSortConfig。空行与 # 注释忽略。
 */
export function parseSortLines(text: string): BasesSortConfig[] {
  const out: BasesSortConfig[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(.+?)(?:\s+(asc|desc))?$/i.exec(line);
    if (!m) continue;
    const property = m[1].trim().replace(/,$/, "");
    if (!property) continue;
    out.push({ property, direction: m[2]?.toUpperCase() === "DESC" ? "DESC" : "ASC" });
  }
  return out;
}

/** 排序配置的文本形式（parseSortLines 的逆） */
export function formatSortLines(sorts: BasesSortConfig[] | undefined): string {
  return (sorts ?? []).map((s) => `${s.property} ${s.direction}`).join("\n");
}

/** 解析「每行一个属性」的输入（列顺序） */
export function parsePropertyLines(text: string): BasesPropertyId[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/,$/, ""))
    .filter((l) => l && !l.startsWith("#"));
}

/** 汇总配置的文本形式：`属性: 汇总名`，每行一条 */
export function parseSummaryLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.lastIndexOf(":");
    if (i <= 0) continue;
    const prop = line.slice(0, i).trim();
    const key = line.slice(i + 1).trim();
    if (prop && key) out[prop] = key;
  }
  return out;
}

export function formatSummaryLines(summaries: Record<string, string> | undefined): string {
  return Object.entries(summaries ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}