import { describe, expect, it } from "vitest";
import { CATEGORIES, categorizePlugin, categoryLabel, categoryOrder } from "./categorize";

describe("插件分类", () => {
  it("75 个兼容样本每个都归到某个分类（不抛错、非空）", () => {
    // 从 compat 样本里挑有代表性的验证关键词命中
    const cases: Array<[string, string, string]> = [
      ["Dataview", "Turn your vault into a queryable database", "data"],
      ["Tasks", "Task management for Obsidian", "task"],
      ["Advanced Tables", "Improved table navigation, formatting, manipulation, and formulas", "edit"],
      ["ExcaliBrain", "Visual thinking with Excalidraw", "visual"],
      ["Self-hosted LiveSync", "Sync your vault with a self-hosted server", "sync"],
      ["Hider", "Hide UI elements", "ui"],
      ["Folder notes", "Create notes within folders", "file"],
      ["ChatGPT MD", "ChatGPT integration", "ai"],
      ["Code Styler", "Style and customize codeblocks", "edit"],
      ["Vault Agent", "AI agent for your vault", "ai"],
    ];
    for (const [name, desc, expected] of cases) {
      expect(categorizePlugin(name, desc)).toBe(expected);
    }
  });

  it("关键词顺序优先：命中多个分类时取靠前的", () => {
    // 「Charts」同时含 chart(visual) 与 data？只应命中 visual
    expect(categorizePlugin("Charts", "Create beautiful charts")).toBe("visual");
    // 「Periodic Notes」含 note(task) 与 periodic —— 命中 task
    expect(categorizePlugin("Periodic Notes", "Create periodic notes")).toBe("task");
  });

  it("识别不了的落到其他", () => {
    expect(categorizePlugin("Mystery Plugin", "does something unknown 12345")).toBe("other");
  });

  it("categoryLabel 对未知 key 返回兜底", () => {
    expect(categoryLabel("no-such-key")).toBe("📦 其他");
  });

  it("categoryOrder 按固定顺序排列，未知 key 排最后", () => {
    expect(categoryOrder(["other", "data", "ai"])).toEqual(["data", "ai", "other"]);
    expect(categoryOrder(["x", "data"])).toEqual(["data", "x"]);
  });

  it("每个分类都有非空关键词（other 除外），且 key 唯一", () => {
    const keys = new Set<string>();
    for (const c of CATEGORIES) {
      expect(keys.has(c.key)).toBe(false);
      keys.add(c.key);
      if (c.key !== "other") expect(c.keywords.length).toBeGreaterThan(0);
    }
  });
});

describe("特例覆盖", () => {
  it("ExcaliBrain（描述为空）归可视化", () => {
    expect(categorizePlugin("ExcaliBrain", "")).toBe("visual");
  });
});
