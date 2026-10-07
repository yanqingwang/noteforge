/**
 * `file.*` 与公式求值需要的 vault 宿主能力。
 *
 * 抽成接口的原因：Bases 求值引擎不能直接依赖 IndexStore 或 Vault
 * —— harness（jsdom 内存 vault）与真机（Tauri 真实磁盘）各自的实现不同，
 * 引擎只认这个接口，两边就能共用同一份引擎代码与测试。
 */

import type { LinkValue } from "./values";

export interface FileApi {
  /** 文件是否存在 */
  exists(path: string): boolean;
  basename(path: string): string;
  folder(path: string): string;
  ext(path: string): string;
  size(path: string): number;
  ctime(path: string): Date;
  mtime(path: string): Date;
  /** frontmatter 全量属性（已按 YAML 真值类型解析） */
  properties(path: string): Record<string, unknown>;
  hasProperty(path: string, name: string): boolean;
  /** 全部标签（frontmatter tags + 行内标签） */
  tags(path: string): string[];
  /** 出链（已解析到 vault 内路径的优先） */
  links(path: string): LinkValue[];
  embeds(path: string): LinkValue[];
  /** 反向链接：指向本文件的文件 */
  backlinks(path: string): string[];
  /** 链接解析：把 `[[x]]`/路径/URL 解析成 vault 内路径；解析不到返回 null */
  resolve(target: string): string | null;
}

/** 日期算术用的时长单位（大小写敏感：M 是月、m 是分） */
export const DURATION_UNITS: Record<string, "year" | "month" | "week" | "day" | "hour" | "minute" | "second"> = {
  y: "year",
  year: "year",
  years: "year",
  M: "month",
  month: "month",
  months: "month",
  w: "week",
  week: "week",
  weeks: "week",
  d: "day",
  day: "day",
  days: "day",
  h: "hour",
  hour: "hour",
  hours: "hour",
  m: "minute",
  minute: "minute",
  minutes: "minute",
  s: "second",
  second: "second",
  seconds: "second",
};

export interface Duration {
  year: number;
  month: number;
  week: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 解析 `"1M"` / `"2 hours"` / `"7d 4h"` 这样的时长字符串 */
export function parseDuration(s: string): Duration | null {
  const d: Duration = { year: 0, month: 0, week: 0, day: 0, hour: 0, minute: 0, second: 0 };
  const re = /(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;
  let m: RegExpExecArray | null;
  let seen = false;
  while ((m = re.exec(s))) {
    const unit = DURATION_UNITS[m[2]];
    if (!unit) return null; // 未知单位 → 整个串不合法（而不是默默当 0）
    d[unit] += Number(m[1]);
    seen = true;
  }
  return seen ? d : null;
}

/**
 * 日期加时长。年/月走日历运算而不是毫秒 —— `2024-01-31 + "1M"` 应该是 2024-02-29，
 * 用毫秒加会得到 2024-03-02。
 */
export function addDuration(date: Date, dur: Duration): Date {
  const out = new Date(date.getTime());
  if (dur.year || dur.month) {
    const y = out.getFullYear() + dur.year;
    const targetMonth = out.getMonth() + dur.month;
    const day = out.getDate();
    out.setFullYear(y, targetMonth, 1);
    // setFullYear 会把 day 溢出到下月，先归零再夹到目标月最后一天
    out.setDate(Math.min(day, daysInMonth(out.getFullYear(), out.getMonth())));
  }
  const ms =
    dur.week * 7 * 86400000 +
    dur.day * 86400000 +
    dur.hour * 3600000 +
    dur.minute * 60000 +
    dur.second * 1000;
  return new Date(out.getTime() + ms);
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** 时长折算成毫秒（差值、除法用） */
export function durationToMs(dur: Duration): number {
  return (
    dur.year * 365 * 86400000 +
    dur.month * 30 * 86400000 +
    dur.week * 7 * 86400000 +
    dur.day * 86400000 +
    dur.hour * 3600000 +
    dur.minute * 60000 +
    dur.second * 1000
  );
}