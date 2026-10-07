/**
 * `.base` 文件配置：类型 + YAML 解析 + 属性 ID 处理。
 *
 * 格式权威依据 obsidian.md/help/bases/syntax。几个从真实 .base 文件里确认、
 * 但文档没写清的点：
 * - 排序键是 `sort:`（不是 `sorts:`），值是 `{property, direction}` 列表
 * - `views[]` 除了已知键，还有各视图自己的状态键（`columnSize`、`rowHeight`、
 *   `propertyDisplay1`…），对应公开声明里的索引签名
 * - `order: []` 是**有意义的**（该视图不显示任何属性），和「没写 order」不同
 */

import { parse as parseYaml } from "yaml";

export type BasesPropertyType = "note" | "formula" | "file";

/** 属性 ID 形如 `note.price` / `file.ext` / `formula.ppu` */
export type BasesPropertyId = string;

export interface BasesProperty {
  type: BasesPropertyType;
  name: string;
}

/**
 * 拆属性 ID。无前缀按官方规则算 note 属性（"If no prefix is specified,
 * the property is assumed to be a note property"）。
 */
export function parsePropertyId(propertyId: string): BasesProperty {
  const i = propertyId.indexOf(".");
  if (i <= 0) return { type: "note", name: propertyId };
  const prefix = propertyId.slice(0, i);
  if (prefix === "note" || prefix === "formula" || prefix === "file") {
    return { type: prefix, name: propertyId.slice(i + 1) };
  }
  // 属性名里带点（`file.properties.a.b`）——前缀之后的全当名字
  return { type: "note", name: propertyId };
}

export type BasesConfigFileFilter =
  | string
  | { and?: BasesConfigFileFilter[]; or?: BasesConfigFileFilter[]; not?: BasesConfigFileFilter[] };

export interface BasesSortConfig {
  property: BasesPropertyId;
  direction: "ASC" | "DESC";
}

export interface BasesConfigFileView {
  type: string;
  name: string;
  filters?: BasesConfigFileFilter;
  groupBy?: { property: BasesPropertyId; direction: "ASC" | "DESC" };
  /** 只有列出的分组才显示，按此顺序；`null` 表示「该属性无值的文件」 */
  groupOrder?: (string | null)[];
  order?: BasesPropertyId[];
  sort?: BasesSortConfig[];
  limit?: number;
  summaries?: Record<string, BasesPropertyId>;
  /** 视图自己往里塞的状态（Obsidian 明确说别占用核心 Bases 的键） */
  [key: string]: unknown;
}

export interface BasesConfigFile {
  filters?: BasesConfigFileFilter;
  properties?: Record<string, Record<string, unknown>>;
  formulas?: Record<string, string>;
  /** 自定义汇总公式，表达式里 `values` 是该属性在结果集里的全部取值 */
  summaries?: Record<string, string>;
  views?: BasesConfigFileView[];
}

/** 解析结果带错误信息（.base 是用户手写的 YAML，报错要能指出行） */
export interface ParseConfigResult {
  config: BasesConfigFile;
  error: string | null;
}

/**
 * 解析 .base 内容。空内容是合法的（等于「显示所有文件、一个默认视图」），
 * 所以不报错，只给一个兜底视图。
 */
export function parseConfig(text: string): ParseConfigResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { config: { views: [{ type: "table", name: "Table" }] }, error: null };
  }
  let raw: unknown;
  try {
    raw = parseYaml(trimmed);
  } catch (e) {
    return { config: { views: [] }, error: e instanceof Error ? e.message : String(e) };
  }
  if (raw === null || raw === undefined) return { config: { views: [] }, error: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { config: { views: [] }, error: "顶层必须是映射（filters/formulas/views 等）" };
  }
  const obj = raw as Record<string, unknown>;
  const config: BasesConfigFile = {};
  if (isFilter(obj.filters)) config.filters = obj.filters;
  if (isRecord(obj.properties)) config.properties = obj.properties as Record<string, Record<string, unknown>>;
  if (isRecord(obj.formulas)) config.formulas = strMap(obj.formulas);
  if (isRecord(obj.summaries)) config.summaries = strMap(obj.summaries);
  if (Array.isArray(obj.views)) {
    config.views = obj.views
      .filter(isRecord)
      .map((v) => normalizeView(v as Record<string, unknown>))
      .filter((v): v is BasesConfigFileView => v !== null);
  }
  if (!config.views || config.views.length === 0) {
    // 官方：没有 views 时默认按 table 显示全部
    config.views = [{ type: "table", name: "Table" }];
  }
  return { config, error: null };
}

function normalizeView(v: Record<string, unknown>): BasesConfigFileView | null {
  const type = typeof v.type === "string" ? v.type : "table";
  const name = typeof v.name === "string" && v.name ? v.name : "Table";
  const out: BasesConfigFileView = { ...v, type, name };
  if (!isFilter(v.filters)) delete out.filters;
  if (isRecord(v.groupBy)) {
    const p = (v.groupBy as Record<string, unknown>).property;
    if (typeof p === "string") {
      const dir = (v.groupBy as Record<string, unknown>).direction;
      out.groupBy = { property: p, direction: dir === "DESC" ? "DESC" : "ASC" };
    }
  }
  if (Array.isArray(v.sort)) {
    const sorts: BasesSortConfig[] = [];
    for (const s of v.sort) {
      if (!isRecord(s)) continue;
      const p = (s as Record<string, unknown>).property;
      if (typeof p !== "string") continue;
      const dir = (s as Record<string, unknown>).direction;
      sorts.push({ property: p, direction: dir === "DESC" ? "DESC" : "ASC" });
    }
    if (sorts.length) out.sort = sorts;
  }
  if (Array.isArray(v.order)) {
    out.order = v.order.filter((o): o is string => typeof o === "string");
  }
  if (Array.isArray(v.groupOrder)) {
    out.groupOrder = v.groupOrder.map((g) => (g === null ? null : String(g)));
  }
  if (typeof v.limit === "number" && v.limit > 0) out.limit = Math.floor(v.limit);
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strMap(v: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}

export function isFilter(v: unknown): v is BasesConfigFileFilter {
  if (typeof v === "string") return true;
  if (!isRecord(v)) return false;
  return Array.isArray(v.and) || Array.isArray(v.or) || Array.isArray(v.not);
}

/** 官方内置视图类型（插件可通过 registerBasesView 加更多） */
export const BUILTIN_VIEW_TYPES = ["table", "list"] as const;

/** 属性 ID 的规范形式：裸名字补上 note. 前缀，便于统一比较 */
export function normalizePropertyId(id: string): string {
  const p = parsePropertyId(id);
  return `${p.type}.${p.name}`;
}