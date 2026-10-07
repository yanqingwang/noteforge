/**
 * Obsidian 1.13 的「声明式设置页」渲染器。
 *
 * 背景：1.13 起插件可以不给 `display()`，而是实现 `getSettingDefinitions()` 返回一棵定义树，
 * 由宿主负责渲染并建立搜索索引（`display()` 只在定义为空时才调用）。实测影响：
 * obsidian-nextcloud-sync-yanc 走的就是这条路 —— 它没有 `display()`，只有
 * `getSettingDefinitions()` + `getControlValue()` / `setControlValue()`。
 * 宿主不实现这套契约时，设置页就是一片空白，而且不报任何错（最难查的一种坏法）。
 *
 * 契约以 obsidian.d.ts 为准（1.13）：
 *   PluginSettingTab.getSettingDefinitions(): SettingDefinitionItem[]
 *   PluginSettingTab.getControlValue(key): unknown
 *   PluginSettingTab.setControlValue(key, value): void | Promise<void>
 *   每一项：group / list / page，或带 render / action / control 的一行。
 *
 * 本模块被应用侧（插件设置对话框）与兼容测试 harness 共用，保证「测的就是跑的」。
 */

import { Setting, type SliderComponent, type TextComponent } from "./ui";
import type { SettingGroup } from "./extra";

/** 定义项里 `visible` / `searchable` / `disabled` 都是 boolean 或返回 boolean 的函数。 */
type Flag = boolean | (() => boolean) | undefined;

/**
 * 求值一个「boolean 或返回 boolean 的函数」字段。
 *
 * 默认值由调用方给：契约里 `visible` 默认 **true**，`searchable` / `disabled` 默认 false。
 * 早先三者共用一个默认 false 的求值器，结果每一项没写 visible 的设置行都被隐藏 ——
 * 表现是设置页整页空白且不报错（Iconic 6 个分组、Nextcloud 9 个分组全被吞掉）。
 */
function evalFlag(v: Flag, dflt: boolean, what: string): boolean {
  if (v === undefined) return dflt;
  if (typeof v === "function") {
    try {
      return Boolean((v as () => boolean)());
    } catch (e) {
      // 谓词读插件状态，插件还没初始化完时会抛；按「不显示」处理而不是让整页崩掉，
      // 但必须打出来 —— 静默隐藏整页时用户只会看到「设置页是空的」，无从排查。
      console.error(`[obsidian-shim] 设置项 ${what} 谓词求值失败，按隐藏处理：`, e);
      return false;
    }
  }
  return Boolean(v);
}

/** visible：契约默认 true。 */
const isVisible = (v: Flag): boolean => evalFlag(v, true, "visible");
/** disabled / searchable：契约默认 false。 */
const isTrue = (v: Flag): boolean => evalFlag(v, false, "布尔");

/** 插件侧实现的那三个方法（宿主只依赖它们，不要求插件继承具体基类）。 */
export interface DeclarativeSettingTab {
  containerEl?: HTMLElement;
  contentEl?: HTMLElement;
  display?: () => void;
  getSettingDefinitions?: () => unknown[];
  getControlValue?: (key: string) => unknown;
  setControlValue?: (key: string, value: unknown) => void | Promise<void>;
  [k: string]: unknown;
}

interface ControlSpec {
  type?: string;
  key?: string;
  defaultValue?: unknown;
  placeholder?: string;
  options?: Record<string, string>;
  min?: number;
  max?: number;
  step?: number;
  validate?: (v: unknown) => unknown;
  disabled?: Flag;
}

interface DefItem {
  type?: "group" | "list" | "page";
  name?: string;
  desc?: string | DocumentFragment;
  heading?: string;
  cls?: string;
  /** 1.13.1：组内搜索框（宿主提供过滤 UI）。 */
  search?: { placeholder?: string; match?: (def: unknown, query: string) => boolean };
  items?: unknown[];
  emptyState?: string | DocumentFragment;
  addItem?: { name: string; action: (el: HTMLElement) => void };
  onDelete?: (index: number) => void;
  onReorder?: (oldI: number, newI: number) => void;
  displayValue?: string | (() => string);
  status?: string | (() => string) | null;
  render?: (setting: Setting, group: unknown) => void;
  action?: (el: HTMLElement, index: number) => void;
  control?: ControlSpec;
  visible?: Flag;
  searchable?: Flag;
  disabled?: Flag;
  [k: string]: unknown;
}

function asItem(v: unknown): DefItem {
  return (v ?? {}) as DefItem;
}

/** desc 可以是 string 或 DocumentFragment；搜索与展示统一取其文本。 */
function textOf(desc: string | DocumentFragment | undefined): string {
  if (typeof desc === "string") return desc;
  return desc?.textContent ?? "";
}

/**
 * 渲染一个插件的设置页到 containerEl。
 *
 * 优先走声明式定义（1.13），没有定义再退回 `display()` —— 与 Obsidian 的判定顺序一致。
 * 返回实际渲染出来的行数（0 表示这个插件的设置页是空的，宿主据此给用户提示）。
 */
export function renderSettingTab(tab: unknown, containerEl: HTMLElement): number {
  const t = tab as DeclarativeSettingTab;
  // 让 tab.update() 能重画自己（谓词依赖插件状态，改完要刷新）
  (t as unknown as { __redraw?: () => void }).__redraw = () => {
    containerEl.replaceChildren();
    renderSettingTab(tab, containerEl);
  };
  let defs: unknown[] = [];
  try {
    defs = t.getSettingDefinitions?.() ?? [];
  } catch (e) {
    appendError(containerEl, `读取设置定义失败：${errMsg(e)}`);
    return 0;
  }

  if (defs.length > 0) {
    try {
      return renderItems(defs, t, containerEl, 0);
    } catch (e) {
      appendError(containerEl, `渲染设置定义失败：${errMsg(e)}`);
      return 0;
    }
  }

  // 定义为空才退回命令式 display()（obsidian.d.ts:6633 的行为）
  try {
    t.display?.();
  } catch (e) {
    appendError(containerEl, `设置页渲染失败：${errMsg(e)}`);
    return 0;
  }
  return countRendered(tab, containerEl);
}

/**
 * 等设置页真正长出内容，返回最终的行数（0 = 空白页）。
 *
 * 必须等：不少插件的 display()/定义渲染不是同步的 —— Svelte 面板、await 之后
 * 再画的设置项都很常见（calendar 就是）。同步判空会把这些插件一律误判成空白页。
 */
export async function waitForSettingRows(
  tab: unknown,
  body: HTMLElement,
  timeoutMs = 600,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = countRendered(tab, body);
  while (last === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    last = countRendered(tab, body);
  }
  return last;
}

/** 当前这一刻设置页里有多少内容（行数，或「有内容但不是 Setting 行」时的 1）。 */
function countRendered(tab: unknown, body: HTMLElement): number {
  const t = (tab ?? {}) as DeclarativeSettingTab;
  const root = t.containerEl ?? body;
  const rows = countRows(root);
  if (rows > 0) return rows;
  const text = (root.textContent ?? "").trim();
  const extraChildren = root.childElementCount - (t.contentEl ? 1 : 0);
  return text.length > 0 || extraChildren > 0 ? 1 : 0;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function appendError(containerEl: HTMLElement, text: string): void {
  const pre = document.createElement("pre");
  pre.textContent = text;
  // 长表达式必须能换行，否则只看到前半截，不知道是哪一步炸的
  pre.style.cssText = "color:#c00;white-space:pre-wrap;word-break:break-word;font-size:12px";
  containerEl.appendChild(pre);
}

function countRows(root: HTMLElement): number {
  return root.querySelectorAll(".nf-setting-item, .nf-setting-group, .nf-setting-page").length;
}

/** 递归渲染 items，返回渲染出的行/组数量。 */
function renderItems(
  items: unknown[],
  tab: DeclarativeSettingTab,
  parent: HTMLElement,
  depth: number,
): number {
  let n = 0;
  items.forEach((raw, index) => {
    const item = asItem(raw);
    if (!isVisible(item.visible)) return;

    if (item.type === "group" || item.type === "list") {
      n += renderGroup(item, tab, parent, depth);
      return;
    }
    if (item.type === "page") {
      // page 是「可导航子页」。不实现导航栈（那要处理历史与焦点），直接就地展开：
      // 用户照样能一次看到并改完所有配置，少一层点击比少一次「返回」更实用。
      n += renderPage(item, tab, parent, depth);
      return;
    }

    n += renderRow(item, tab, parent, index);
  });
  return n;
}

function renderGroup(item: DefItem, tab: DeclarativeSettingTab, parent: HTMLElement, depth: number): number {
  const groupEl = document.createElement("div");
  groupEl.className = `nf-setting-group nf-def-${item.type ?? "group"}${item.cls ? ` ${item.cls}` : ""}`;
  parent.appendChild(groupEl);

  const heading = item.heading ?? item.name;
  if (heading) {
    const h = document.createElement("div");
    h.className = "nf-setting-group-name";
    h.textContent = heading;
    groupEl.appendChild(h);
  }

  const items = item.items ?? [];
  if (item.type === "list" && items.length === 0 && item.emptyState) {
    const empty = document.createElement("div");
    empty.className = "nf-setting-group-desc";
    empty.textContent = textOf(item.emptyState);
    groupEl.appendChild(empty);
  }

  // group.search：1.13.1 起宿主提供组内搜索框
  if (item.search) {
    const row = document.createElement("div");
    row.className = "nf-setting-group-search";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = item.search.placeholder ?? "搜索";
    row.appendChild(input);
    groupEl.appendChild(row);
    const body = document.createElement("div");
    groupEl.appendChild(body);
    input.addEventListener("input", () => {
      const q = input.value.trim();
      body.replaceChildren();
      if (!q) {
        renderItems(items, tab, body, depth + 1);
        return;
      }
      // 过滤：name / desc / aliases 任一命中即保留（宿主不做模糊匹配，够用且可预期）
      const hit = items.filter((raw) => {
        const d = asItem(raw);
        if (!isVisible(d.visible)) return false;
        const hay = [d.name ?? "", textOf(d.desc), ...((d.aliases as string[] | undefined) ?? [])]
          .join(" ")
          .toLowerCase();
        return q.toLowerCase().split(/\s+/).every((part) => hay.includes(part));
      });
      renderItems(hit, tab, body, depth + 1);
    });
    // 只渲染进 body：否则同一批行会出现两份，搜索过滤只影响其中一份
    return 1 + renderItems(items, tab, body, depth + 1);
  }

  renderItems(items, tab, groupEl, depth + 1);

  // list 的增删改 affordance：能用的都渲染，缺失的接口不猜
  if (item.type === "list") {
    if (item.addItem) {
      const bar = document.createElement("div");
      bar.className = "nf-setting-list-actions";
      const btn = document.createElement("button");
      btn.textContent = `+ ${item.addItem.name}`;
      btn.title = item.addItem.name;
      btn.addEventListener("click", () => {
        try {
          item.addItem?.action(btn);
        } catch (e) {
          appendError(groupEl, `操作失败：${errMsg(e)}`);
        }
      });
      bar.appendChild(btn);
      groupEl.appendChild(bar);
    }
    if (item.onDelete) {
      // 逐行加删除按钮（定义里没有独立的行包装，只能按渲染顺序找出来配对）
      wireRowActions(groupEl, items, item);
    }
  }
  return groupEl.childElementCount;
}

function renderPage(item: DefItem, tab: DeclarativeSettingTab, parent: HTMLElement, depth: number): number {
  const pageEl = document.createElement("div");
  pageEl.className = `nf-setting-page${item.cls ? ` ${item.cls}` : ""}`;
  parent.appendChild(pageEl);

  const title = document.createElement("div");
  title.className = "nf-setting-page-title";
  title.textContent = item.name ?? "";
  pageEl.appendChild(title);

  if (item.desc) {
    const desc = document.createElement("div");
    desc.className = "nf-setting-group-desc";
    desc.textContent = textOf(item.desc);
    pageEl.appendChild(desc);
  }

  const dv = typeof item.displayValue === "function" ? item.displayValue() : item.displayValue;
  if (dv) {
    const v = document.createElement("div");
    v.className = "nf-setting-page-value";
    v.textContent = dv;
    pageEl.appendChild(v);
  }
  const status = typeof item.status === "function" ? item.status() : item.status;
  if (status) {
    const s = document.createElement("div");
    s.className = `nf-setting-page-status is-${status}`;
    s.textContent = status === "warning" ? "需要注意" : String(status);
    pageEl.appendChild(s);
  }

  if (item.page) {
    // 工厂：返回自定义 SettingPage 实例，宿主直接 display 它
    try {
      const page = (item.page as () => { display?: () => void })();
      page?.display?.();
    } catch (e) {
      appendError(pageEl, `子页渲染失败：${errMsg(e)}`);
    }
    return 1;
  }

  renderItems(item.items ?? [], tab, pageEl, depth + 1);
  return 1 + pageEl.childElementCount;
}

/** 给已经渲染出来的行配 delete / reorder 按钮。 */
function wireRowActions(groupEl: HTMLElement, items: unknown[], item: DefItem): void {
  const rows = groupEl.querySelectorAll(".nf-setting-item");
  items.forEach((raw, index) => {
    const d = asItem(raw);
    if (!isVisible(d.visible)) return;
    const row = rows[index];
    if (!row) return;
    const tools = document.createElement("div");
    tools.className = "nf-setting-list-rowtools";
    if (item.onDelete) {
      const del = document.createElement("button");
      del.textContent = "删除";
      del.addEventListener("click", () => {
        try {
          item.onDelete?.(index);
        } catch (e) {
          appendError(groupEl, `删除失败：${errMsg(e)}`);
        }
      });
      tools.appendChild(del);
    }
    if (item.onReorder) {
      const up = document.createElement("button");
      up.textContent = "↑";
      up.addEventListener("click", () => {
        if (index === 0) return;
        try {
          item.onReorder?.(index, index - 1);
        } catch (e) {
          appendError(groupEl, `重排失败：${errMsg(e)}`);
        }
      });
      const down = document.createElement("button");
      down.textContent = "↓";
      down.addEventListener("click", () => {
        try {
          item.onReorder?.(index, index + 1);
        } catch (e) {
          appendError(groupEl, `重排失败：${errMsg(e)}`);
        }
      });
      tools.append(up, down);
    }
    if (tools.childElementCount > 0) row.appendChild(tools);
  });
}

function renderRow(item: DefItem, tab: DeclarativeSettingTab, parent: HTMLElement, index: number): number {
  const setting = new Setting(parent);
  if (item.name) setting.setName(item.name);
  if (item.desc) setting.setDesc(item.desc);
  // 注意：disabled 必须等控件挂上来之后再应用 —— Setting.setDisabled 只禁用「已有」的组件，
  // 先设后加就等于没设（这一行的输入框会保持可编辑）。
  const applyDisabled = (): void => {
    if (isTrue(item.disabled)) setting.setDisabled(true);
  };

  // 三种形态：自定义渲染 / 点击动作 / 控件
  if (typeof item.render === "function") {
    try {
      item.render(setting, undefined as unknown as SettingGroup);
    } catch (e) {
      appendError(setting.settingEl, `渲染失败：${errMsg(e)}`);
    }
    applyDisabled();
    return 1;
  }

  if (typeof item.action === "function") {
    setting.addButton((b) => {
      b.setButtonText(item.name ?? "执行");
      b.onClick(() => {
        try {
          item.action?.(setting.settingEl, index);
        } catch (e) {
          appendError(setting.settingEl, `操作失败：${errMsg(e)}`);
        }
      });
    });
    applyDisabled();
    return 1;
  }

  if (item.control) {
    renderControl(setting, item.control, tab);
    applyDisabled();
    return 1;
  }

  // 空定义：只有标题/描述的信息行
  return 1;
}

function renderControl(setting: Setting, control: ControlSpec, tab: DeclarativeSettingTab): void {
  const key = control.key ?? "";
  const read = (): unknown => {
    try {
      const v = tab.getControlValue?.(key);
      return v === undefined ? control.defaultValue : v;
    } catch {
      return control.defaultValue;
    }
  };
  const write = (value: unknown): void => {
    // validate 先跑：返回非空字符串即视为错误信息（Obsidian 语义）
    if (typeof control.validate === "function") {
      try {
        const msg = control.validate(value);
        if (typeof msg === "string" && msg) {
          setting.setErrorMessage(msg);
          return;
        }
      } catch (e) {
        setting.setErrorMessage(`校验失败：${errMsg(e)}`);
        return;
      }
    }
    setting.setErrorMessage(null);
    try {
      const r = tab.setControlValue?.(key, value);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((e) => setting.setErrorMessage(`保存失败：${errMsg(e)}`));
      }
    } catch (e) {
      setting.setErrorMessage(`保存失败：${errMsg(e)}`);
    }
  };
  const controlDisabled = isTrue(control.disabled);

  switch (control.type) {
    case "toggle":
      setting.addToggle((c) => {
        c.setValue(Boolean(read())).onChange((v) => write(v));
        c.setDisabled(controlDisabled);
      });
      break;
    case "dropdown":
      setting.addDropdown((c) => {
        c.addOptions(control.options ?? {});
        c.setValue(String(read() ?? ""));
        c.onChange((v) => write(v));
        c.setDisabled(controlDisabled);
      });
      break;
    case "textarea":
      setting.addTextArea((c) => {
        c.setValue(String(read() ?? ""));
        if (control.placeholder) c.setPlaceholder(control.placeholder);
        c.onChange((v) => write(v));
        c.setDisabled(controlDisabled);
      });
      break;
    case "number":
      setting.addText((c: TextComponent) => {
        c.setValue(String(read() ?? ""));
        if (control.placeholder) c.setPlaceholder(control.placeholder);
        c.setDisabled(controlDisabled);
        c.onChange((v) => {
          const n = Number(v);
          if (Number.isNaN(n)) {
            setting.setErrorMessage("请输入数字");
            return;
          }
          if (typeof control.min === "number" && n < control.min) {
            setting.setErrorMessage(`不能小于 ${control.min}`);
            return;
          }
          if (typeof control.max === "number" && n > control.max) {
            setting.setErrorMessage(`不能大于 ${control.max}`);
            return;
          }
          write(n);
        });
      });
      break;
    case "slider":
      setting.addSlider((c: SliderComponent) => {
        c.setLimits(control.min ?? 0, control.max ?? 100, control.step ?? 1);
        c.setValue(Number(read() ?? control.min ?? 0));
        c.setDynamicTooltip();
        c.setDisabled(controlDisabled);
        c.onChange((v) => write(v));
      });
      break;
    case "color":
      setting.addColorPicker((c) => {
        c.setValue(String(read() ?? "#000000"));
        c.onChange?.((v: string) => write(v));
        if (controlDisabled) c.setDisabled?.(true);
      });
      break;
    case "file":
    case "folder":
      // 文件/文件夹选择器依赖原生文件对话框，宿主暂不支持；给文本框，
      // 让配置仍然可写（插件读到的是同一个 key 的字符串）
      setting.addText((c) => {
        c.setPlaceholder(control.placeholder ?? (control.type === "file" ? "文件路径" : "文件夹路径"));
        c.setValue(String(read() ?? ""));
        c.setDisabled(controlDisabled);
        c.onChange((v) => write(v));
      });
      break;
    case "text":
    default:
      setting.addText((c) => {
        c.setValue(String(read() ?? ""));
        if (control.placeholder) c.setPlaceholder(control.placeholder);
        c.setDisabled(controlDisabled);
        c.onChange((v) => write(v));
      });
      break;
  }
}
