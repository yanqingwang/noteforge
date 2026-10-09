/**
 * 图片/附件插入（纯函数）测试：路径生成（目录 / 子目录 / 命名 / 防撞）与 markdown 文本。
 */
import { describe, it, expect } from "vitest";
import { buildAttachmentRel, buildImageMarkdown, buildImageLinkPath, relativePath } from "./extensions";

const NOW = new Date(2026, 9, 9, 12, 34, 56); // 本地时间 2026-10-09 12:34:56
const never = () => false;

describe("buildAttachmentRel", () => {
  it("默认：时间戳 + 按月子目录", () => {
    const rel = buildAttachmentRel({ dir: "attachments", subfolder: true, nameStyle: "timestamp" }, "png", NOW, never);
    expect(rel).toBe("attachments/2026-10/20261009123456.png");
  });

  it("关闭子目录", () => {
    const rel = buildAttachmentRel({ dir: "assets", subfolder: false, nameStyle: "timestamp" }, "webp", NOW, never);
    expect(rel).toBe("assets/20261009123456.webp");
  });

  it("目录为空时回落 attachments；首尾斜杠被清洗", () => {
    expect(buildAttachmentRel({ dir: "  ", subfolder: false, nameStyle: "timestamp" }, "png", NOW, never))
      .toBe("attachments/20261009123456.png");
    expect(buildAttachmentRel({ dir: "/img/", subfolder: false, nameStyle: "timestamp" }, "png", NOW, never))
      .toBe("img/20261009123456.png");
  });

  it("时间戳冲突时追加 -1", () => {
    const taken = new Set(["attachments/2026-10/20261009123456.png"]);
    const rel = buildAttachmentRel(
      { dir: "attachments", subfolder: true, nameStyle: "timestamp" }, "png", NOW, (r) => taken.has(r));
    expect(rel).toBe("attachments/2026-10/20261009123456-1.png");
  });

  it("序号命名：img-<epoch>-<n>，冲突时递增", () => {
    const epoch = NOW.getTime();
    const taken = new Set([
      `attachments/2026-10/img-${epoch}-0.png`,
      `attachments/2026-10/img-${epoch}-1.png`,
    ]);
    const rel = buildAttachmentRel(
      { dir: "attachments", subfolder: true, nameStyle: "sequence" }, "png", NOW, (r) => taken.has(r));
    expect(rel).toBe(`attachments/2026-10/img-${epoch}-2.png`);
  });
});

describe("buildImageMarkdown", () => {
  it("wikilink 样式", () => {
    expect(buildImageMarkdown("attachments/a.png", "wikilink")).toBe("![[attachments/a.png]]");
  });

  it("markdown 样式（含 alt 文本）", () => {
    expect(buildImageMarkdown("attachments/a.png", "markdown", "图 1")).toBe("![图 1](attachments/a.png)");
  });

  it("markdown 样式无 alt", () => {
    expect(buildImageMarkdown("attachments/a.png", "markdown")).toBe("![](attachments/a.png)");
  });
});

describe("relativePath / buildImageLinkPath", () => {
  const REL = "attachments/2026-10/x.png";

  it("relativePath：同目录 / 上溯 / 根目录", () => {
    expect(relativePath("attachments/2026-10", "attachments/2026-10/x.png")).toBe("x.png");
    expect(relativePath("notes", REL)).toBe("../attachments/2026-10/x.png");
    expect(relativePath("", REL)).toBe(REL);
  });

  it("absolute（默认）原样返回", () => {
    expect(buildImageLinkPath(REL, "absolute", { activeFile: "notes/a.md" })).toBe(REL);
  });

  it("relative：相对当前笔记目录", () => {
    expect(buildImageLinkPath(REL, "relative", { activeFile: "notes/a.md" })).toBe("../attachments/2026-10/x.png");
    expect(buildImageLinkPath(REL, "relative", { activeFile: "a.md" })).toBe(REL);
  });

  it("shortest：唯一时用文件名，重名时回落完整路径", () => {
    expect(buildImageLinkPath(REL, "shortest", { files: ["notes/a.md"] })).toBe("x.png");
    expect(buildImageLinkPath(REL, "shortest", { files: ["other/x.png"] })).toBe(REL);
  });
});
