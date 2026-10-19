import { describe, it, expect } from "vitest";
import { findAnchorPos } from "./anchor";

const doc = [
  "# 第一篇",           // 0
  "",                   // 6
  "正文段落 ^abc123",   // 7
  "",                   // 20
  "## 小节标题",        // 21
  "内容",               // 29
  "^standalone",        // 32
  "尾部不是标记 ^abc123 后面还有字", // 44
].join("\n");

describe("findAnchorPos", () => {
  it("块引用：定位行尾 ^id 所在行行首", () => {
    expect(findAnchorPos(doc, "^abc123")).toBe(7);
  });

  it("块引用：整行独立 ^id 也能定位", () => {
    expect(findAnchorPos(doc, "^standalone")).toBe(32);
  });

  it("块引用：id 后还有文字不算行尾标记", () => {
    // 第 8 行 ^abc123 后面有文字，不应命中；命中的是第 3 行
    expect(findAnchorPos(doc, "^abc123")).toBe(7);
  });

  it("标题：完全匹配（忽略大小写与闭合 #）", () => {
    expect(findAnchorPos(doc, "第一篇")).toBe(0);
    expect(findAnchorPos(doc, "小节标题")).toBe(21);
  });

  it("找不到返回 null；空锚点返回 null", () => {
    expect(findAnchorPos(doc, "不存在的标题")).toBeNull();
    expect(findAnchorPos(doc, "^missing")).toBeNull();
    expect(findAnchorPos(doc, "")).toBeNull();
    expect(findAnchorPos(doc, "  ")).toBeNull();
  });

  it("标题不匹配非标题行；锚点带 # 前缀已由调用方剥掉", () => {
    expect(findAnchorPos(doc, "内容")).toBeNull();
  });
});
