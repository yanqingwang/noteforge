/**
 * 插件市场：兼容性徽标与排序相关的纯函数 / 常量（便于单测）。
 *
 * 排序本身在 Rust 侧完成（marketplace_search 先排序再截断），这里只放展示用的映射。
 */

export interface CompatEntry {
  /** harness 的 status：pass / pass-view-error / pass-settings-error / load-only / fail-* */
  s: string;
  /** 失败阶段（可选，用于悬浮提示） */
  p?: string;
  /** 错误信息（可选，用于悬浮提示） */
  e?: string;
}

export type CompatStatus = CompatEntry | undefined;

export type MarketSort = "compat" | "downloads" | "official";

/** 排序偏好落 localStorage（沿用 nf-* 前缀的既有模式）。 */
export const MARKET_SORT_KEY = "nf-plugin-market-sort";

export const SORT_OPTIONS: ReadonlyArray<{ value: MarketSort; label: string }> = [
  { value: "compat", label: "兼容优先" },
  { value: "downloads", label: "热门（下载量）" },
  { value: "official", label: "官方默认序" },
];

export function readMarketSort(): MarketSort {
  const v = typeof localStorage === "undefined" ? null : localStorage.getItem(MARKET_SORT_KEY);
  return v === "downloads" || v === "official" || v === "compat" ? v : "compat";
}

export interface CompatBadge {
  icon: string;
  label: string;
  color: string;
}

/** harness status → 徽标。无记录 = 未测。 */
export function compatBadge(entry: CompatStatus): CompatBadge {
  const s = entry?.s ?? "";
  switch (s) {
    case "pass":
      return { icon: "✅", label: "已测通过", color: "#2a7" };
    case "pass-view-error":
    case "pass-settings-error":
      return { icon: "⚠️", label: "部分可用", color: "#c47f00" };
    case "load-only":
      return { icon: "🟡", label: "仅能加载", color: "#b58900" };
    case "":
      return { icon: "➖", label: "未测", color: "#999" };
    default:
      return { icon: "❌", label: "不兼容", color: "#d33" };
  }
}

/** 悬浮提示：把阶段与错误带出来。 */
export function compatTitle(entry: CompatStatus): string {
  const b = compatBadge(entry);
  if (!entry || !entry.s) return "未在兼容性测试样本中（可直接安装试用）";
  const parts = [b.label];
  if (entry.p) parts.push(`阶段：${entry.p}`);
  if (entry.e) parts.push(entry.e);
  return parts.join(" · ");
}

const isFail = (entry: CompatStatus) => !!entry?.s && !entry.s.startsWith("pass") && entry.s !== "load-only";

/** 是否属于「测试不通过」——用于市场里给用户一个直白的说明。 */
export function isIncompatible(entry: CompatStatus): boolean {
  return isFail(entry);
}

/** 下载量的紧凑展示。 */
export function formatDownloads(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
