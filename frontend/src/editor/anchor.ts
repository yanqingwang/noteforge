/**
 * wikilink 锚点定位：`[[note#标题]]` / `[[note#^block-id]]` 打开后
 * 在目标文档中定位对应行，返回文档偏移（行首）。
 *
 * Obsidian 语义：
 *  - `#^block-id`：行尾（或块尾）的 `^id` 标记；
 *  - `#标题`：ATX 标题行，文本完全匹配（忽略大小写与首尾空白）；
 *  - 找不到时返回 null（调用方退化为只打开文件）。
 */

/** 在 doc 中查找锚点，返回该行的起始偏移；未找到返回 null。 */
export function findAnchorPos(doc: string, anchor: string): number | null {
  const a = anchor.trim();
  if (!a) return null;
  if (a.startsWith("^")) return findBlockIdPos(doc, a.slice(1));
  return findHeadingPos(doc, a);
}

/** `^block-id`：匹配行尾标记（Obsidian 要求 id ≥ 1 字符，前后为空白或行界） */
function findBlockIdPos(doc: string, id: string): number | null {
  if (!id) return null;
  const lines = doc.split("\n");
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    // 行尾 ` ^id` 或整行就是 `^id`（Obsidian 块引用标记惯例）
    if (trimmed.endsWith(`^${id}`)) {
      const before = trimmed.slice(0, trimmed.length - id.length - 1);
      if (before === "" || /\s$/.test(before)) return offset;
    }
    offset += line.length + 1;
  }
  return null;
}

/** `#标题`：ATX 标题文本完全匹配（忽略大小写），返回最靠前的一个 */
function findHeadingPos(doc: string, heading: string): number | null {
  const target = heading.trim().toLowerCase();
  const lines = doc.split("\n");
  let offset = 0;
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m && m[1].trim().toLowerCase() === target) return offset;
    offset += line.length + 1;
  }
  return null;
}
