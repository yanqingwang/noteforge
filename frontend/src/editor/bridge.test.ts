import { describe, it, expect } from "vitest";
import { extractOutline, shouldSyncExternal, editorBridge, requestOutlineJump } from "./bridge";

describe("extractOutline", () => {
  it("extracts headings with level/line/pos", () => {
    const doc = "intro\n\n# 标题一\n内容\n## 子标题\n### 三级\n";
    const items = extractOutline(doc);
    expect(items.map(i => [i.level, i.text, i.line])).toEqual([
      [1, "标题一", 3],
      [2, "子标题", 5],
      [3, "三级", 6],
    ]);
    // pos points at the line start
    expect(doc.slice(items[0].pos, items[0].pos + 1)).toBe("#");
  });

  it("skips headings inside fenced code blocks", () => {
    const doc = "# real\n```python\n# not a heading\n```\n## also real\n~~~\n# not either\n~~~\n";
    const items = extractOutline(doc);
    expect(items.map(i => i.text)).toEqual(["real", "also real"]);
  });

  it("ignores hash without space and trailing fence variants", () => {
    const doc = "#nospace\n# ok\n";
    expect(extractOutline(doc).map(i => i.text)).toEqual(["ok"]);
  });

  it("returns empty for doc without headings", () => {
    expect(extractOutline("plain\n text\n")).toEqual([]);
  });
});

describe("shouldSyncExternal（光标跳动修复核心）", () => {
  it("rejects the editor's own echo even when doc raced ahead", () => {
    // 连续打字：doc = "ab"，App 只回写了 "a"（上一次的 echo）
    expect(shouldSyncExternal("ab", "a", "a")).toBe(false);
  });

  it("rejects no-op when content equals doc", () => {
    expect(shouldSyncExternal("abc", "abc", null)).toBe(false);
  });

  it("accepts genuine external load (file switch)", () => {
    expect(shouldSyncExternal("old doc", "new file content", "old doc")).toBe(true);
  });

  it("accepts stale content that differs from both doc and echo marker", () => {
    expect(shouldSyncExternal("ab", "X", "a")).toBe(true);
  });
});

describe("editorBridge outline jump", () => {
  it("notifies registered listeners", () => {
    const received: number[] = [];
    const fn = (item: { pos: number }) => received.push(item.pos);
    editorBridge.jumpListeners.push(fn as any);
    requestOutlineJump({ level: 1, text: "t", line: 3, pos: 42 });
    editorBridge.jumpListeners = editorBridge.jumpListeners.filter(f => f !== (fn as any));
    expect(received).toEqual([42]);
  });
});
