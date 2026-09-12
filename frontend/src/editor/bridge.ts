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

/**
 * 编辑器 echo 追踪器（乱序安全）。
 *
 * App 每次编辑都异步触发 render_markdown，promise 完成顺序不保证；
 * 单值守卫挡不住「旧的 echo 晚到」——旧内容一通过守卫就会把文档整篇
 * 重置成旧值（表现为页面被清空）。这里记录编辑器发出过的所有近期内容
 * 指纹，凡命中一律视为 echo 丢弃；只有文件切换等真正的外部加载才回灌。
 */
export class EchoTracker {
  private emitted = new Set<string>();
  private order: string[] = [];
  private capacity: number;

  constructor(capacity = 128) {
    this.capacity = capacity;
  }

  /** 编辑器发出新内容时调用 */
  mark(content: string): void {
    if (this.emitted.has(content)) return;
    this.emitted.add(content);
    this.order.push(content);
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift()!;
      this.emitted.delete(oldest);
    }
  }

  /** 该 content 是否为编辑器自己发出的（echo → 丢弃） */
  isEcho(content: string): boolean {
    return this.emitted.has(content);
  }

  /** 外部加载（文件切换等）后重置指纹 */
  reset(seed?: string): void {
    this.emitted.clear();
    this.order = [];
    if (seed !== undefined) this.mark(seed);
  }
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
