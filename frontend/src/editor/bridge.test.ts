import { describe, it, expect } from "vitest";
import { extractOutline, EchoTracker, editorBridge, requestOutlineJump } from "./bridge";

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

describe("EchoTracker（页面被清空修复核心）", () => {
  it("single stale echo is rejected (old behaviour already covered)", () => {
    const t = new EchoTracker();
    t.mark("a"); t.mark("ab");
    expect(t.isEcho("a")).toBe(true);
    expect(t.isEcho("ab")).toBe(true);
  });

  it("out-of-order echoes never clobber: any previously emitted value is an echo", () => {
    // 模拟真实场景：打字 abc，render_markdown promise 乱序完成
    const t = new EchoTracker();
    t.mark("a"); t.mark("ab"); t.mark("abc");
    // P3 先到（最新值），再 P1 晚到（旧值 "a"）——旧值也必须被丢弃
    expect(t.isEcho("a")).toBe(true);
    expect(t.isEcho("ab")).toBe(true);
    // 只有从未发过的外部内容才允许回灌
    expect(t.isEcho("external load")).toBe(false);
  });

  it("reset after external load clears fingerprints", () => {
    const t = new EchoTracker();
    t.mark("old");
    t.reset("new file");
    expect(t.isEcho("old")).toBe(false);
    expect(t.isEcho("new file")).toBe(true);
  });

  it("capacity bounded: very old fingerprints expire", () => {
    const t = new EchoTracker(4);
    for (let i = 0; i < 10; i++) t.mark("v" + i);
    expect(t.isEcho("v0")).toBe(false);
    expect(t.isEcho("v9")).toBe(true);
  });

  it("identical content typed twice still tracked", () => {
    const t = new EchoTracker();
    t.mark("x"); t.mark("y"); t.mark("x");
    expect(t.isEcho("x")).toBe(true);
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
