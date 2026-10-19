/**
 * #tag 自动补全源测试：触发位置、排除场景（wikilink 锚点/标题记号/URL）、过滤与插入。
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { makeTagSource } from "./extensions";

const TAGS = ["AI", "AI/机器学习", "机器学习", "notes", "read-later"];

function ctx(doc: string, pos?: number): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, pos ?? doc.length, false);
}

function run(doc: string) {
  const source = makeTagSource(() => TAGS);
  return source(ctx(doc));
}

describe("makeTagSource", () => {
  it("行首 # 后输入触发，返回匹配标签", () => {
    const r = run("#机");
    expect(r).not.toBeNull();
    const labels = r!.options.map(o => o.label);
    expect(labels).toContain("#机器学习");
    expect(labels).toContain("#AI/机器学习"); // 子串匹配嵌套标签
    expect(labels).not.toContain("#notes");
  });

  it("空白/标点后触发；大小写不敏感", () => {
    const r = run("这是 #ai");
    expect(r).not.toBeNull();
    const labels = r!.options.map(o => o.label);
    expect(labels).toEqual(["#AI", "#AI/机器学习"]);
  });

  it("from 在 # 之后，apply 替换标签名并带尾随空格", () => {
    const doc = "#机";
    const r = run(doc)!;
    expect(r.from).toBe(1);
    const opt = r.options.find(o => o.label === "#机器学习")!;
    expect(opt.apply).toBe("机器学习 ");
  });

  it("wikilink 锚点 [[note#xx 不触发", () => {
    expect(run("[[note#标")).toBeNull();
    expect(run("[[#标")).toBeNull();
  });

  it("标题记号 ## 不触发；单独 #（无标签字符）不触发", () => {
    expect(run("##")).toBeNull();
    expect(run("#")).toBeNull();
    expect(run("# ")).toBeNull();
  });

  it("URL 锚点不触发（# 前是词字符）", () => {
    expect(run("http://example.com#frag")).toBeNull();
  });

  it("无匹配标签返回 null", () => {
    expect(run("#zzz不存在")).toBeNull();
  });
});
