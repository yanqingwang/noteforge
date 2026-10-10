import { describe, expect, it } from "vitest";
import { categorizePlugin } from "./categorize";

// 真实 vault（/home/wang/wk/wk/.obsidian/plugins）的插件 → 期望分类
const VAULT_PLUGINS: Array<[string, string, string]> = [
  ["Dataview", "Complex data views for the data-obsessed.", "data"],
  ["Diagrams", "Draw.io diagrams for Obsidian. This plugin introduces diagrams", "visual"],
  ["HTML Effectiveness", "Render spatial HTML in notes — compare, timeline, diagram, report, slides", "edit"],
  ["HTML to MD Effectiveness", "Convert HTML files to clean Markdown — headings, lists, code", "edit"],
  ["Iconic", "Customize your icons and their colors directly from the UI", "ui"],
  ["MD to HTML Effectiveness", "Render spatial HTML in notes — compare, timeline, diagram", "edit"],
  ["Nextcloud sync YANC", "Bidirectional sync between your Vault and Nextcloud using hashed file", "sync"],
  ["Quadrant Chart", "Draw labelled N x M quadrant charts with free-floating text", "visual"],
  ["Vault Agent", "AI vault agent powered by China-accessible LLM APIs — DeepSeek", "ai"],
];

describe("真实 vault 插件分类", () => {
  it("每个插件都归到预期分类", () => {
    for (const [name, desc, expected] of VAULT_PLUGINS) {
      expect(categorizePlugin(name, desc), name).toBe(expected);
    }
  });
});
