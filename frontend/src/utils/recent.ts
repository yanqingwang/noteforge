/**
 * 最近使用记录（localStorage 持久化，最新的在最前）。
 * QuickSwitcher / 命令面板的排序加权使用。
 */

export function getRecent(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(x => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 记录一次使用：去重置顶，截断到 max 条 */
export function pushRecent(key: string, value: string, max = 30): void {
  if (!value) return;
  try {
    const list = getRecent(key).filter(v => v !== value);
    list.unshift(value);
    localStorage.setItem(key, JSON.stringify(list.slice(0, max)));
  } catch {
    /* 隐私模式等场景下 localStorage 不可用，静默忽略 */
  }
}
