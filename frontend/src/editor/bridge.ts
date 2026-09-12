/**
 * EditorPane ↔ App 的轻量桥接：
 * - latestDoc：编辑器当前最新文档（App 的保存按钮用它，避免 React 缓存滞后丢字）
 * - requestSave：请求编辑器立即保存（走编辑器自身的原子写 + 脏标记）
 * - requestOutlineJump：大纲面板请求跳转到某行
 */
export interface OutlineItem {
  level: number;
  text: string;
  /** 1-based 行号 */
  line: number;
  /** 文档内偏移（跳转定位用） */
  pos: number;
}

export const editorBridge: {
  latestDoc: string | null;
  activeFile: string | null;
  requestSave: (() => void) | null;
  jumpListeners: ((item: OutlineItem) => void)[];
} = {
  latestDoc: null,
  activeFile: null,
  requestSave: null,
  jumpListeners: [],
};

export function requestOutlineJump(item: OutlineItem) {
  for (const fn of editorBridge.jumpListeners) fn(item);
}

/**
 * 是否应把外部 content 回灌进编辑器（防止编辑器 echo 触发全文重置）。
 * - content 与 lastEmitted 相同 → 是自己刚发出的 echo，跳过
 * - content 与当前文档相同 → 无需变更
 */
export function shouldSyncExternal(docStr: string, content: string, lastEmitted: string | null): boolean {
  if (content === lastEmitted) return false;
  return docStr !== content;
}

/** 从 Markdown 文档提取标题大纲（跳过围栏代码块内的 # 行） */
export function extractOutline(doc: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let inFence = false;
  let fenceMarker = "";
  let pos = 0;
  let lineNo = 1;
  for (const rawLine of doc.split("\n")) {
    const fenceMatch = rawLine.trimStart().match(/^(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false;
      }
    } else if (!inFence) {
      const m = rawLine.match(/^(#{1,6})\s+(.*\S)\s*$/);
      if (m) items.push({ level: m[1].length, text: m[2], line: lineNo, pos });
    }
    pos += rawLine.length + 1;
    lineNo++;
  }
  return items;
}
