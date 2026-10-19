/**
 * 模糊匹配评分：QuickSwitcher / 命令面板共用。
 *
 * 规则（分数越低越好，null 表示不匹配）：
 *  1. 文件名（basename，去扩展名）精确相等          → 0
 *  2. 文件名前缀匹配                              → 10 + 查询长度差
 *  3. 路径前缀匹配                                → 20 + 查询长度差
 *  4. 文件名子串匹配                              → 30 + 起始位置
 *  5. 路径子串匹配                                → 40 + 起始位置
 *  6. 子序列（乱序跳字，如 "rd" 命中 "readme"）    → 60 + 跨度
 * 最近使用加权：调用方在得分上减 recencyBonus（建议 0~15）。
 *
 * 说明：曾考虑拼音首字母匹配，但无词库时多音字错误率高，暂不支持。
 */

export interface MatchCandidate {
  /** 参与匹配的完整文本（文件路径 / 命令名） */
  text: string;
}

const baseName = (p: string): string => p.split("/").pop() ?? p;
const stripExt = (p: string): string => p.replace(/\.[^.]+$/, "");

/** 子序列匹配跨度（越小越好）；不匹配返回 null */
function subsequenceSpan(query: string, text: string): number | null {
  if (!query) return 0;
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) {
      if (first < 0) first = i;
      last = i;
      qi++;
    }
  }
  if (qi < query.length) return null;
  return last - first;
}

/**
 * 计算匹配得分；不匹配返回 null。分数越小越好。
 * @param query 用户输入（不要求小写）
 * @param text  候选文本（路径或命令名）
 */
export function scoreMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const base = baseName(t);
  const baseNoExt = stripExt(base);

  if (baseNoExt === q || base === q) return 0;
  if (baseNoExt.startsWith(q) || base.startsWith(q)) return 10 + (baseNoExt.length - q.length) / 100;
  if (t.startsWith(q)) return 20 + (t.length - q.length) / 100;
  const bi = base.indexOf(q);
  if (bi >= 0) return 30 + bi;
  const ti = t.indexOf(q);
  if (ti >= 0) return 40 + ti;
  const span = subsequenceSpan(q, baseNoExt) ?? subsequenceSpan(q, t);
  if (span !== null) return 60 + span;
  return null;
}

/**
 * 过滤 + 排序候选。
 * @param items   候选列表
 * @param query   用户输入
 * @param getText 取候选的匹配文本
 * @param recent  最近使用列表（text 值，最新在前）；命中者按名次加分（最多 15）
 * @param limit   返回条数上限
 */
export function rankCandidates<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  recent: readonly string[] = [],
  limit = 20,
): T[] {
  const q = query.trim();
  const recentIdx = new Map(recent.map((r, i) => [r, i]));
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const text = getText(item);
    let score = scoreMatch(q, text);
    if (score === null) continue;
    const ri = recentIdx.get(text);
    if (ri !== undefined) score -= Math.max(0, 15 - ri);
    scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map(s => s.item);
}
