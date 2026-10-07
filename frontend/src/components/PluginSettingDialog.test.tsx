/**
 * 插件设置入口的组件测试。
 *
 * 背景：插件自己的设置页（PluginSettingTab）实现了但 UI 上没有入口 ——
 * 插件能装能启用，却打不开它的配置页。这里守住这条链路：
 *   命令面板能搜到设置命令 → 打开模态框 → 插件的 Setting 组件真的渲染出来。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";

const PLUGIN_MAIN = `
var obsidian = require("obsidian");
class Demo extends obsidian.Plugin {
  onload() {
    this.addCommand({ id: "hello", name: "打招呼", callback: () => {} });
    this.addSettingTab(new (class extends obsidian.PluginSettingTab {
      display() {
        new obsidian.Setting(this.containerEl)
          .setName("API Key")
          .setDesc("填入你的模型 API Key")
          .addText((t) => t.setValue("sk-test").onChange(() => {}));
      }
    })(this.app, this));
  }
}
module.exports = Demo;
`;

const FILES: Record<string, string> = {
  ".obsidian/plugins/demo/manifest.json": JSON.stringify({
    id: "demo", name: "Demo 插件", version: "1.2.3", description: "设置页测试用", author: "t",
  }),
  ".obsidian/plugins/demo/main.js": PLUGIN_MAIN,
  ".obsidian/community-plugins.json": JSON.stringify(["demo"]),
};

const mocks = vi.hoisted(() => ({ files: {} as Record<string, string> }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const files = mocks.files;
    if (cmd === "list_plugins") {
      const enabled = JSON.parse(files[".obsidian/community-plugins.json"] ?? "[]") as string[];
      const out: unknown[] = [];
      for (const [path, content] of Object.entries(files)) {
        if (!path.startsWith(".obsidian/plugins/") || !path.endsWith("manifest.json")) continue;
        const id = path.split("/")[2];
        const mf = JSON.parse(content) as Record<string, string>;
        out.push({
          id, name: mf.name, version: mf.version, description: mf.description ?? "",
          author: mf.author ?? "", enabled: enabled.includes(id), has_main: true, bytes: 1000,
        });
      }
      return out;
    }
    if (cmd === "read_file") {
      const p = String(args.path);
      if (!(p in files)) throw new Error(`文件不存在: ${p}`);
      return files[p];
    }
    throw new Error(`未 mock 的命令: ${cmd}`);
  },
}));

const VAULT = "/tmp/nf-plugin-settings-test";

describe("插件设置入口", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetModules();
    mocks.files = { ...FILES };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("命令面板里有「打开插件设置」的命令，且会回调宿主", async () => {
    const { obsidianRuntime } = await import("../plugins/obsidianRuntime");
    const opened: string[] = [];
    await obsidianRuntime.init({
      vaultPath: () => VAULT,
      activeFile: () => null,
      openFile: async () => undefined,
      ensureViewContainer: async () => null,
      openPluginSettings: (id) => opened.push(id),
    });

    const summary = obsidianRuntime.list().find((p) => p.id === "demo")!;
    expect(summary.hasSettings).toBe(true);

    // 名字里带插件 id，便于只用 ASCII 过滤（也能被自动化验证到）
    const cmd = obsidianRuntime.commands().find((c) => c.id === "plugin-settings:demo");
    expect(cmd).toBeTruthy();
    expect(cmd!.name).toContain("demo");
    expect(cmd!.name).toContain("设置");

    cmd!.run();
    expect(opened).toEqual(["demo"]);
    obsidianRuntime.dispose();
  });

  it("设置对话框把插件自己的 Setting 组件渲染出来", async () => {
    const { obsidianRuntime } = await import("../plugins/obsidianRuntime");
    await obsidianRuntime.init({
      vaultPath: () => VAULT,
      activeFile: () => null,
      openFile: async () => undefined,
      ensureViewContainer: async () => null,
      openPluginSettings: () => undefined,
    });

    const { default: PluginSettingDialog } = await import("./PluginSettingDialog");
    let closed = 0;
    await act(async () => {
      root.render(
        <PluginSettingDialog
          pluginId="demo"
          dark={false}
          onClose={() => {
            closed++;
          }}
        /> as ReactElement,
      );
    });

    // 插件的 Setting 组件树真的挂进对话框了（名称/描述/输入框值）
    expect(container.textContent).toContain("Demo 插件");
    expect(container.textContent).toContain("1.2.3");
    expect(container.textContent).toContain("API Key");
    expect(container.textContent).toContain("填入你的模型 API Key");
    const input = container.querySelector<HTMLInputElement>("input[type=text]");
    expect(input?.value).toBe("sk-test");
    // 顶部有重载与关闭按钮
    expect(container.querySelectorAll("button").length).toBeGreaterThanOrEqual(3);

    await act(async () => {
      root.unmount();
    });
    expect(closed).toBe(0);
    obsidianRuntime.dispose();
  });

  it("没有设置页的插件给出明确说明而不是空白", async () => {
    vi.resetModules();
    mocks.files = {
      ...FILES,
      ".obsidian/plugins/bare/main.js": "module.exports = class extends require('obsidian').Plugin { onload(){} };",
      ".obsidian/plugins/bare/manifest.json": JSON.stringify({ id: "bare", name: "无设置插件", version: "0.1" }),
      ".obsidian/community-plugins.json": JSON.stringify(["bare"]),
    };
    const { obsidianRuntime } = await import("../plugins/obsidianRuntime");
    await obsidianRuntime.init({
      vaultPath: () => VAULT,
      activeFile: () => null,
      openFile: async () => undefined,
      ensureViewContainer: async () => null,
      openPluginSettings: () => undefined,
    });
    const { default: PluginSettingDialog } = await import("./PluginSettingDialog");
    await act(async () => {
      root.render(<PluginSettingDialog pluginId="bare" dark={false} onClose={() => undefined} /> as ReactElement);
    });
    expect(container.textContent).toContain("没有提供设置页");
    await act(async () => {
      root.unmount();
    });
    obsidianRuntime.dispose();
  });
});
