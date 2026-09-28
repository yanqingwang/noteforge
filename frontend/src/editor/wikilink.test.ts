/**
 * Wikilink 解析测试：别名/锚点剥离、大小写、路径后缀、重名歧义、
 * 模糊匹配唯一性（防止跳错文件）。
 */
import { describe, it, expect } from "vitest";
import { splitWikilink, resolveWikilink } from "./wikilink";

const FILES = [
  { path: "work.md" },
  { path: "Daily 思考/深度思考-2026-09-28.md" },
  { path: "docs/overview.md" },
  { path: "archive/overview.md" },
  { path: "wechat/docs/微信云托管部署清单-fde-jobs-2026-09-24.md" },
  { path: "attachments/2026/09/pic.png" },
  { path: "reports/单文件报告.html" },
  { path: "docs", is_dir: true },
];

describe("splitWikilink", () => {
  it("拆出目标 / 别名 / 锚点", () => {
    expect(splitWikilink("note")).toEqual({ target: "note", alias: undefined, subpath: undefined });
    expect(splitWikilink("note|显示名")).toEqual({ target: "note", alias: "显示名", subpath: undefined });
    expect(splitWikilink("note#标题")).toEqual({ target: "note", alias: undefined, subpath: "标题" });
    expect(splitWikilink("dir/note#^block|别名")).toEqual({
      target: "dir/note", alias: "别名", subpath: "^block",
    });
  });

  it("去掉前导 ./ 与 /，并解码 URL 编码", () => {
    expect(splitWikilink("./docs/overview").target).toBe("docs/overview");
    expect(splitWikilink("/work").target).toBe("work");
    expect(splitWikilink("Daily%20%E6%80%9D%E8%80%83").target).toBe("Daily 思考");
  });
});

describe("resolveWikilink", () => {
  it("完整路径、路径后缀、文件名（忽略大小写）都能命中", () => {
    expect(resolveWikilink("work", FILES).path).toBe("work.md");
    expect(resolveWikilink("work.md", FILES).path).toBe("work.md");
    expect(resolveWikilink("docs/overview", FILES).path).toBe("docs/overview.md");
    expect(resolveWikilink("深度思考-2026-09-28", FILES).path).toBe("Daily 思考/深度思考-2026-09-28.md");
    expect(resolveWikilink("WORK", FILES).path).toBe("work.md");
  });

  it("中文长文件名与 .html 附件可解析", () => {
    expect(resolveWikilink("微信云托管部署清单-fde-jobs-2026-09-24", FILES).path)
      .toBe("wechat/docs/微信云托管部署清单-fde-jobs-2026-09-24.md");
    expect(resolveWikilink("单文件报告", FILES).path).toBe("reports/单文件报告.html");
  });

  it("别名与锚点不参与文件匹配", () => {
    expect(resolveWikilink("work|工作笔记", FILES).path).toBe("work.md");
    expect(resolveWikilink("work#2026 计划", FILES).path).toBe("work.md");
  });

  it("同名多文件：取层级最浅，同深度按字典序，并报告歧义", () => {
    const dup = [
      { path: "a/deep/deeper/x.md" },
      { path: "b/x.md" },
      { path: "c/x.md" },
    ];
    const r = resolveWikilink("x", dup);
    expect(r.path).toBe("b/x.md");          // b/ 与 c/ 同深度，b 在前
    expect(r.ambiguous).toHaveLength(3);
    // 同深度按字典序，结果稳定可预期
    expect(resolveWikilink("x", dup).path).toBe(resolveWikilink("x", dup).path);
  });

  it("模糊匹配仅在唯一时接受，避免跳到错误文件", () => {
    const r = resolveWikilink("单文件", FILES);
    expect(r.path).toBe("reports/单文件报告.html");
    // pic 只有一个模糊候选 → 接受
    expect(resolveWikilink("pic", FILES).path).toBe("attachments/2026/09/pic.png");
  });

  it("找不到 / 空目标返回 null", () => {
    expect(resolveWikilink("不存在的笔记", FILES).path).toBeNull();
    expect(resolveWikilink("", FILES).empty).toBe(true);
  });

  it("目录名不会被当成目标（也不会随机命中子文件）", () => {
    const r = resolveWikilink("docs", FILES);
    expect(r.path).toBeNull();
    expect(r.ambiguous).toBeTruthy();
  });
});
