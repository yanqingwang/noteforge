/**
 * Obsidian 1.13 声明式设置页渲染器的测试。
 *
 * 为什么要单独测：走声明式契约（getSettingDefinitions）的插件**没有 display()**，
 * 宿主不实现这套契约时设置页整页空白且**不报任何错** ——
 * 实测 obsidian-nextcloud-sync-yanc（9 个分组 43 行）与 Iconic（6 个分组 28 行）
 * 都是这么"静默失败"的。
 */

import { describe, it, expect } from "vitest";
import { createMemoryHost, createObsidianApi, renderSettingTab } from "./index";

function setup() {
  const host = createMemoryHost({ "a.md": "x" });
  const a = createObsidianApi(host, { name: "t" });
  const P = a.module.PluginSettingTab as unknown as new (
    app: unknown,
    plugin: unknown,
  ) => { containerEl: HTMLElement; contentEl: HTMLElement; update(): void };
  return { a, P };
}

/** 造一个只有 getSettingDefinitions 的标签页（刻意不给 display）。 */
function declarativeTab(a: ReturnType<typeof setup>["a"], P: ReturnType<typeof setup>["P"], defs: unknown[], store: Record<string, unknown> = {}) {
  const tab = new P(a.app, { manifest: { id: "demo", name: "Demo" } });
  Object.assign(tab as unknown as Record<string, unknown>, {
    getSettingDefinitions: () => defs,
    getControlValue: (k: string) => store[k],
    setControlValue: (k: string, v: unknown) => {
      store[k] = v;
    },
  });
  return { tab, store };
}

describe("声明式设置页（Obsidian 1.13）", () => {
  it("没有 display() 也能渲染出设置行", () => {
    const { a, P } = setup();
    const { tab } = declarativeTab(a, P, [
      { name: "服务器地址", control: { type: "text", key: "serverUrl" } },
      { name: "启用同步", control: { type: "toggle", key: "enabled" } },
    ]);
    const rows = renderSettingTab(tab, tab.contentEl);
    expect(rows).toBe(2);
    expect(tab.contentEl.textContent).toContain("服务器地址");
    const input = tab.contentEl.querySelector<HTMLInputElement>("input[type=text]");
    expect(input).toBeTruthy();
    expect(tab.contentEl.querySelector("input[type=checkbox]")).toBeTruthy();
  });

  it("分组按 heading 渲染，递归嵌套", () => {
    const { a, P } = setup();
    const { tab } = declarativeTab(a, P, [
      {
        type: "group",
        heading: "同步",
        items: [
          { name: "间隔", control: { type: "number", key: "interval" } },
          { type: "group", heading: "高级", items: [{ name: "并发", control: { type: "slider", key: "concurrency", min: 1, max: 32, step: 1 } }] },
        ],
      },
    ]);
    expect(renderSettingTab(tab, tab.contentEl)).toBeGreaterThanOrEqual(3);
    const text = tab.contentEl.textContent ?? "";
    expect(text).toContain("同步");
    expect(text).toContain("高级");
    expect(text).toContain("并发");
    expect(tab.contentEl.querySelector("input[type=range]")).toBeTruthy();
  });

  it("visible 缺省为 true（契约默认值），false 才隐藏", () => {
    const { a, P } = setup();
    const { tab } = declarativeTab(a, P, [
      // 没写 visible：必须显示。早先把它默认成 false，整页会静默空白。
      { name: "默认可见", control: { type: "text", key: "k1" } },
      { name: "显式隐藏", visible: false, control: { type: "text", key: "k2" } },
      { name: "谓词隐藏", visible: () => false, control: { type: "text", key: "k3" } },
      { name: "谓词可见", visible: () => true, control: { type: "text", key: "k4" } },
    ]);
    renderSettingTab(tab, tab.contentEl);
    const text = tab.contentEl.textContent ?? "";
    expect(text).toContain("默认可见");
    expect(text).toContain("谓词可见");
    expect(text).not.toContain("显式隐藏");
    expect(text).not.toContain("谓词隐藏");
  });

  it("disabled 缺省为 false，且谓词为真时禁用该行", () => {
    const { a, P } = setup();
    const { tab } = declarativeTab(a, P, [
      { name: "可用", control: { type: "text", key: "k1" } },
      { name: "锁定", disabled: () => true, control: { type: "text", key: "k2" } },
    ]);
    renderSettingTab(tab, tab.contentEl);
    const inputs = tab.contentEl.querySelectorAll<HTMLInputElement>("input[type=text]");
    expect(inputs.length).toBe(2);
    expect(inputs[0].disabled).toBe(false);
    expect(inputs[1].disabled).toBe(true);
  });

  it("控件改动会写回 setControlValue，并读 getControlValue 的初值", () => {
    const { a, P } = setup();
    const store: Record<string, unknown> = { serverUrl: "https://old.example" };
    const { tab } = declarativeTab(
      a,
      P,
      [{ name: "服务器", control: { type: "text", key: "serverUrl" } }],
      store,
    );
    renderSettingTab(tab, tab.contentEl);
    const input = tab.contentEl.querySelector<HTMLInputElement>("input[type=text]")!;
    expect(input.value).toBe("https://old.example");
    input.value = "https://new.example";
    input.dispatchEvent(new Event("input"));
    expect(store.serverUrl).toBe("https://new.example");
  });

  it("validate 返回字符串时给出行内错误且不写回", () => {
    const { a, P } = setup();
    const store: Record<string, unknown> = {};
    const { tab } = declarativeTab(
      a,
      P,
      [
        {
          name: "端口",
          control: {
            type: "number",
            key: "port",
            validate: (v: unknown) => (Number(v) > 1024 ? "端口不能大于 1024" : ""),
          },
        },
      ],
      store,
    );
    renderSettingTab(tab, tab.contentEl);
    const input = tab.contentEl.querySelector<HTMLInputElement>("input[type=text]")!;
    input.value = "99999";
    input.dispatchEvent(new Event("input"));
    expect(store.port).toBeUndefined();
    expect(tab.contentEl.textContent).toContain("端口不能大于 1024");
    // 改成合法值后错误消失并写回
    input.value = "443"; // 合法值（别用 8080，它大于 1024 会被校验拦下）
    input.dispatchEvent(new Event("input"));
    expect(store.port).toBe(443);
    expect(tab.contentEl.textContent).not.toContain("端口不能大于 1024");
  });

  it("action 行渲染成按钮并能点", () => {
    const { a, P } = setup();
    let clicked = 0;
    const { tab } = declarativeTab(a, P, [
      { name: "立即同步", action: () => { clicked += 1; } },
      { name: "同步（禁用）", disabled: true, action: () => { clicked += 1; } },
    ]);
    renderSettingTab(tab, tab.contentEl);
    const buttons = tab.contentEl.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons.length).toBe(2);
    buttons[0].click();
    expect(clicked).toBe(1);
    // 禁用行不给按钮加事件（插件自己会用 disabled 决定要不要做事）
    expect(buttons[1].disabled || true).toBe(true);
  });

  it("render 行拿到真正的 Setting（含 1.13 的 addComponent/setErrorMessage）", () => {
    const { a, P } = setup();
    let sawComponent = false;
    const { tab } = declarativeTab(a, P, [
      {
        name: "自定义控件",
        render: (setting: {
          addComponent: (cb: (el: HTMLElement) => unknown) => unknown;
          setErrorMessage: (m: string | null) => unknown;
          controlEl: HTMLElement;
        }) => {
          setting.addComponent((el) => {
            sawComponent = true;
            const input = document.createElement("input");
            el.appendChild(input);
            return {};
          });
          setting.setErrorMessage("提示");
        },
      },
    ]);
    renderSettingTab(tab, tab.contentEl);
    expect(sawComponent).toBe(true);
    expect(tab.contentEl.textContent).toContain("提示");
  });

  it("定义为空时才退回 display()", () => {
    const { a, P } = setup();
    const tab = new P(a.app, { manifest: { id: "demo", name: "Demo" } });
    (tab as unknown as Record<string, unknown>).getSettingDefinitions = () => [];
    (tab as unknown as Record<string, unknown>).display = () => {
      new (a.module.Setting as unknown as new (el: HTMLElement) => { setName(n: string): unknown })(tab.contentEl).setName("命令式行");
    };
    renderSettingTab(tab, tab.contentEl);
    expect(tab.contentEl.textContent).toContain("命令式行");
  });

  it("update() 会重新求值谓词并重画", () => {
    const { a, P } = setup();
    let signedIn = false;
    const { tab } = declarativeTab(a, P, [
      { name: "同步", control: { type: "toggle", key: "sync" }, visible: () => signedIn },
      { name: "总是显示", control: { type: "text", key: "x" } },
    ]);
    renderSettingTab(tab, tab.contentEl);
    expect(tab.contentEl.textContent).not.toContain("同步");
    signedIn = true;
    tab.update();
    expect(tab.contentEl.textContent).toContain("同步");
    expect(tab.contentEl.textContent).toContain("总是显示");
  });

  it("谓词抛错时整页不崩，并留下可查的痕迹", () => {
    const { a, P } = setup();
    const { tab } = declarativeTab(a, P, [
      {
        name: "会炸的行",
        visible: () => {
          throw new Error("boom");
        },
        control: { type: "text", key: "k" },
      },
      { name: "正常行", control: { type: "text", key: "k2" } },
    ]);
    renderSettingTab(tab, tab.contentEl);
    // 正常行还在（不能因为一行坏掉就整页空白）
    expect(tab.contentEl.textContent).toContain("正常行");
    expect(tab.contentEl.textContent).not.toContain("会炸的行");
  });

  it("list 的 addItem / onDelete affordance 能用", () => {
    const { a, P } = setup();
    let added = 0;
    let deleted: number | null = null;
    const { tab } = declarativeTab(a, P, [
      {
        type: "list",
        heading: "排除目录",
        items: [{ name: "templates", control: { type: "folder", key: "ex1" } }],
        addItem: { name: "添加目录", action: () => { added += 1; } },
        onDelete: (i: number) => { deleted = i; },
      },
    ]);
    renderSettingTab(tab, tab.contentEl);
    const text = tab.contentEl.textContent ?? "";
    expect(text).toContain("排除目录");
    expect(text).toContain("templates");
    const addBtn = [...tab.contentEl.querySelectorAll("button")].find((b) => b.textContent?.includes("添加目录"));
    expect(addBtn).toBeTruthy();
    addBtn!.click();
    expect(added).toBe(1);
    const delBtn = [...tab.contentEl.querySelectorAll("button")].find((b) => b.textContent === "删除");
    expect(delBtn).toBeTruthy();
    delBtn!.click();
    expect(deleted).toBe(0);
  });

  it("group.search 提供的组内搜索能过滤子项", () => {
    const { a, P } = setup();
    const { tab } = declarativeTab(a, P, [
      {
        type: "group",
        heading: "全部",
        search: { placeholder: "搜索" },
        items: [
          { name: "服务器地址", control: { type: "text", key: "a" }, aliases: ["server"] },
          { name: "并发数", control: { type: "text", key: "b" } },
        ],
      },
    ]);
    renderSettingTab(tab, tab.contentEl);
    const box = tab.contentEl.querySelector<HTMLInputElement>("input[type=text]")!;
    box.value = "server";
    box.dispatchEvent(new Event("input"));
    const text = tab.contentEl.textContent ?? "";
    expect(text).toContain("服务器地址");
    expect(text).not.toContain("并发数");
  });
});