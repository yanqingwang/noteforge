/**
 * 兼容层的第二批 API：来自 41 插件样本的静态引用分析（见 scripts/compat/analyze-imports.mjs）。
 *
 * 每一项都对应「样本里至少一个插件在模块顶层引用它」——缺了会在加载阶段就抛，
 * 因此它们和 Vault/Plugin 一样属于「加载必需」而不是「锦上添花」。
 */

import { StateField } from "@codemirror/state";
import { Component, Scope, escapeHtml, setIcon } from "./events";
import { ICONS } from "./icon-registry";
import { base64ToBytes, bytesToBase64 } from "./types";
import { EditableFileView, MarkdownView, Workspace } from "./workspace";
import { Modal, SearchComponent, Setting } from "./ui";

/* ---------- 语言 / 版本 / 图标 ---------- */

/** Obsidian 界面语言（如 zh / en）。插件用它决定内置提示文案。 */
export function getLanguage(): string {
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav?.language ?? "zh";
}

/** 要求最低 API 版本，不满足返回 false。 */
export function requireApiVersion(min: string, current = apiVersion): boolean {
  const norm = (v: string) =>
    v
      .split(".")
      .map((n) => Number(n.replace(/\D.*$/, "")) || 0)
      .slice(0, 3);
  const a = norm(min);
  const b = norm(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return false;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return true;
  }
  return true;
}

export const apiVersion = "1.9.0";

/** 列出所有已注册的图标 id（Obsidian API）。 */
export function getIconIds(): string[] {
  return [...ICONS.keys()];
}

/** 取图标的 DOM 元素。 */
export function getIcon(iconId: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "obsidian-icon nf-get-icon";
  setIcon(el, iconId);
  return el;
}

/* ---------- 二进制转换 ---------- */

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bytes = base64ToBytes(b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buf));
}

/* ---------- 双链路径 ---------- */

/** 源码里相对当前文件的展示路径。 */
export function getLinkpath(linktext: string, sourcePath: string): string {
  const base = sourcePath.includes("/") ? sourcePath.split("/").slice(0, -1).join("/") : "";
  if (!base) return linktext;
  if (linktext.startsWith("/")) return linktext.slice(1);
  return `${base}/${linktext}`;
}

/* ---------- Frontmatter ---------- */

export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string | null;
  from: number;
  to: number;
  contentStart: number;
}

/** 解析文档开头的 frontmatter，返回其原文与偏移。 */
export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const m = /^(﻿)?---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { exists: false, frontmatter: null, from: 0, to: 0, contentStart: 0 };
  return {
    exists: true,
    frontmatter: m[2],
    from: m.index + (m[1]?.length ?? 0),
    to: m.index + m[0].length,
    contentStart: m.index + m[0].length,
  };
}

/** 按点分路径取 frontmatter 条目（"a.b" 逐层）。 */
export function parseFrontMatterEntry(content: string, path: string): unknown {
  const info = getFrontMatterInfo(content);
  if (!info.exists || !info.frontmatter) return undefined;
  // 延迟加载 YAML 解析（避免每次读文档都付解析代价）
  const { parse } = requireYaml();
  const fm = parse(info.frontmatter) as Record<string, unknown> | null;
  if (!fm) return undefined;
  let cur: unknown = fm;
  for (const seg of path.split(".")) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 取 frontmatter 里的 tags 数组。 */
export function parseFrontMatterTags(content: string): string[] {
  const v = parseFrontMatterEntry(content, "tags");
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return [v];
  return [];
}

/** 取 frontmatter 里的 aliases（别名）数组。
 *  Obsidian 语义：值为数组则逐个收为字符串；单个标量（含字符串/数字）收为单元素数组；
 *  YAML 对象等非字符串值跳过。无 frontmatter 或无 alias 键时返回 null。
 */
export function parseFrontMatterAliases(content: string): string[] | null {
  const info = getFrontMatterInfo(content);
  if (!info.exists || !info.frontmatter) return null;
  const v = parseFrontMatterEntry(content, "alias");
  if (v === undefined) return null;
  if (Array.isArray(v)) {
    const out = v.filter((x) => x != null && typeof x !== "object").map(String);
    return out.length ? out : null;
  }
  if (v == null || typeof v === "object") return null;
  return [String(v)];
}

function requireYaml(): { parse(s: string): unknown } {
  // events.ts 已静态引入 yaml，这里复用同一实现，避免重复打包
  const g = globalThis as unknown as { __nfYaml?: { parse(s: string): unknown } };
  if (!g.__nfYaml) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    g.__nfYaml = { parse: (s: string) => parseYamlFallback(s) };
  }
  return g.__nfYaml;
}

function parseYamlFallback(text: string): unknown {
  // 仅支持 frontmatter 里最常见的 `key: value` 与 `- item` 列表
  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && listKey) {
      const arr = out[listKey];
      if (Array.isArray(arr)) arr.push(stripQuotes(li[1]));
      continue;
    }
    const kv = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (!val) {
      out[key] = [];
      listKey = key;
      continue;
    }
    if (val.startsWith("[") && val.endsWith("]")) {
      out[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
    } else {
      out[key] = stripQuotes(val);
    }
    listKey = null;
  }
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/* ---------- 提示气泡 ---------- */

/** Obsidian 1.7+ 的模块级 API：给元素挂 tooltip（内部走 aria/title）。 */
export function setTooltip(el: HTMLElement, tooltip: string): void {
  if (!el) return;
  el.title = tooltip;
  el.setAttribute("aria-label", tooltip);
}

/* ---------- 搜索辅助 ---------- */

export interface SearchInfo {
  query: string;
  tokens: string[];
  fuzzy: boolean;
}

/** 简单搜索：把查询拆成 token。 */
export function prepareSimpleSearch(query: string): SearchInfo {
  const tokens = query.split(/\s+/).filter(Boolean);
  return { query, tokens, fuzzy: false };
}

/** 模糊搜索：token 内再拆成字符片段，供插件做打分。 */
export function prepareFuzzySearch(query: string): SearchInfo {
  const tokens = query.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  return { query, tokens, fuzzy: true };
}

/* ---------- 枚举 / 常量 ---------- */

/** Obsidian 把工作区分区做成枚举（tab 布局变化后仍被插件引用）。 */
export class WorkspaceSplit {
  static rootSplit = "split";
  static leftSplit = "split-left";
  static rightSplit = "split-right";
}

/** Obsidian 导出的 CM keymap 包装，插件用 Keymap.of([...]) 注册快捷键。 */
export const Keymap = {
  of(bindings: unknown[]): unknown {
    return { __keymap: bindings };
  },
  fromObject(obj: Record<string, () => unknown>): unknown {
    return { __keymap: Object.entries(obj).map(([key, run]) => ({ key, run })) };
  },
};

/* ---------- 编辑器状态字段 ---------- */

/**
 * Obsidian 把编辑器上下文通过 CM6 StateField 暴露给插件
 * （editorInfoField / editorLivePreviewField）。插件的 StateField 通常
 * `editorInfoField.init((_, state) => ({...}))`，缺了它们就无法注册编辑器扩展。
 */
export const editorInfoField = StateField.define<{
  editor: {
    hoverPopover: unknown;
    infoWrappers: { equation: boolean; image: boolean; livePreview: boolean };
    composing: boolean;
    rerender: boolean;
  };
  livePreview: { rendered: boolean; rerender: boolean };
}>({
  create: () => ({
    editor: {
      hoverPopover: null,
      infoWrappers: { equation: false, image: false, livePreview: false },
      composing: false,
      rerender: false,
    },
    livePreview: { rendered: false, rerender: false },
  }),
  update: (v) => v,
});

export const editorLivePreviewField = StateField.define<number>({
  create: () => 0,
  update: (v) => v,
});

/* ---------- CodeMirror 5 兼容命名空间 ---------- */

/**
 * Obsidian 导出 `CodeMirror`（CodeMirror 5 的兼容层），老插件用它做
 * defineMode / defineMIME / registerHelper。缺这个命名空间会在加载期报
 * "Cannot read properties of undefined (reading 'defineMode')"。
 */
const cm5Modes = new Map<string, unknown>();

/** CM5 模式的最小可用实现：token 永远返回 null（不高亮），但语义完整。 */
function defaultCm5Mode() {
  return {
    name: "null",
    startState: () => ({}),
    blankLine: () => undefined,
    token: (_stream: unknown, _state: unknown) => null,
    copyState: (s: unknown) => s,
    lineComment: "#",
    indentOnInput: false,
  };
}

export const CodeMirror = {
  defineMode(name: string, mode: unknown): void {
    cm5Modes.set(name, mode);
  },
  getMode(_options: unknown, _spec: unknown, modeSpec?: unknown, _inner?: boolean): unknown {
    const name =
      typeof modeSpec === "string"
        ? modeSpec
        : (modeSpec as { name?: string; mode?: string } | undefined)?.mode ??
          (modeSpec as { name?: string } | undefined)?.name ??
          "null";
    const factory = cm5Modes.get(name);
    if (typeof factory === "function") {
      try {
        return (factory as (cfg: unknown, spec: unknown) => unknown)(_options, modeSpec);
      } catch {
        return defaultCm5Mode();
      }
    }
    return factory ?? defaultCm5Mode();
  },
  getModeAt(): unknown {
    return defaultCm5Mode();
  },
  /** CM5 的 customOverlayMode：把 overlay 模式包在基础模式上。 */
  customOverlayMode(base: unknown, _overlayFactory?: unknown): unknown {
    const mode = (base ?? {}) as Record<string, unknown>;
    return {
      ...defaultCm5Mode(),
      name: `overlay:${String(mode.name ?? "base")}`,
      token: (stream: unknown, state: unknown) =>
        typeof mode.token === "function" ? mode.token(stream, state) : null,
      startState: () =>
        typeof mode.startState === "function" ? mode.startState() : defaultCm5Mode().startState(),
      copyState: (st: unknown) => st,
      blankLine: () => undefined,
    };
  },
  /** CM5 的 startState(mode) 辅助函数。 */
  startState(mode: unknown): unknown {
    const m = mode as { startState?: () => unknown };
    return typeof m?.startState === "function" ? m.startState() : {};
  },
  defineMIME(): void {},
  /**
   * CM5 的 mode 元数据表：插件会往里 push 自己注册的 mode
   * （code-styler 直接 `window.CodeMirror.modeInfo.push({name, mime, mode, ext})`）。
   * 缺了在 onload 里就抛 "Cannot read properties of undefined (reading 'push')"。
   */
  modeInfo: [] as Array<{ name: string; mime?: string; mode?: unknown; ext?: string[] }>,
  modes: [] as string[],
  mimeModes: {} as Record<string, string>,
  registerHelper(): void {},
  registerGlobalHelper(): void {},
  defineOption(): void {},
  defineExtension(): void {},
  runMode(): string {
    return "";
  },
  // CM5 内置命令：插件会取 CodeMirror.commands.indentAuto 之类
  commands: {
    indentAuto: () => undefined,
    indentMore: () => undefined,
    indentLess: () => undefined,
    newlineAndIndent: () => undefined,
    deleteLine: () => undefined,
    cursorLine: () => false,
    undo: () => undefined,
    redo: () => undefined,
    selectAll: () => undefined,
    toggleComment: () => undefined,
  } as Record<string, unknown>,
  keyMap: {} as Record<string, unknown>,
  Pass: class {
    constructor() {
      /* 占位 */
    }
  },
  Doc: class {
    constructor() {
      /* 占位 */
    }
  },
};

/* ---------- 设置页容器 ---------- */

/**
 * SettingGroup / SettingPage：Obsidian 设置界面的分组容器。
 * 插件常用 `new SettingGroup("名称").setDesc("…").addItem(s => s.setName(…).addToggle(…))`。
 */
export interface SettingGroupOptions {
  title?: string;
  desc?: string;
  heading?: boolean;
}

export class SettingGroup {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  itemsEl: HTMLElement;

  /**
   * Obsidian 的签名是 `new SettingGroup(containerEl, options?)`，选项形如
   * `{ title, desc, heading }`。
   *
   * 早先把第一个参数当"标题字符串"处理，于是插件写
   * `new SettingGroup(this.containerEl)` 时整组被渲染进一个游离 div，
   * 设置页看上去一片空白（iconic 的 display() 就是这么写的）。
   * 现在两种写法都支持：首参是元素就是容器，是字符串就是标题。
   */
  constructor(containerEl?: HTMLElement | string, options?: string | SettingGroupOptions) {
    const isContainer = typeof containerEl === "object" && containerEl !== null;
    const opt: SettingGroupOptions =
      typeof options === "string" ? { title: options } : (options ?? {});
    this.settingEl = document.createElement("div");
    this.settingEl.className = "nf-setting-group";
    if (isContainer) (containerEl as HTMLElement).appendChild(this.settingEl);
    this.nameEl = document.createElement("div");
    this.nameEl.className = "nf-setting-group-name";
    this.nameEl.textContent = isContainer ? (opt.title ?? "") : ((containerEl as string) ?? opt.title ?? "");
    this.descEl = document.createElement("div");
    this.descEl.className = "nf-setting-group-desc";
    this.descEl.style.display = "none";
    this.itemsEl = document.createElement("div");
    this.itemsEl.className = "nf-setting-group-items";
    this.settingEl.append(this.nameEl, this.descEl, this.itemsEl);
    if (opt.desc) {
      this.descEl.textContent = opt.desc;
      this.descEl.style.display = "";
    }
    if (opt.heading) this.settingEl.classList.add("mod-heading");
  }

  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    this.descEl.style.display = desc ? "" : "none";
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.className = `nf-setting-group ${cls}`;
    return this;
  }

  setHeading(): this {
    this.settingEl.classList.add("mod-heading");
    return this;
  }

  setTooltip(t: string): this {
    this.settingEl.title = t;
    return this;
  }

  /** 添加一行设置。cb 收到一个 Setting（语义与 new Setting(el) 一致）。 */
  /**
   * 每行都必须是**真正的 Setting 实例**。
   * 早先这里套了一个只转发 9 个方法的 SettingImpl 壳，插件调 addExtraButton /
   * addColorPicker / addSlider 就报 "… is not a function"（iconic 就这么挂的）。
   */
  addItem(cb: (setting: Setting) => unknown): this {
    const row = document.createElement("div");
    this.itemsEl.appendChild(row);
    cb(new Setting(row));
    return this;
  }

  /** 兼容旧写法：addSetting（Obsidian 里就是 addItem 的别名）。 */
  addSetting(cb: (setting: Setting) => unknown): this {
    return this.addItem(cb);
  }

  addSearch(cb: (c: SearchComponent) => unknown): this {
    const row = document.createElement("div");
    this.itemsEl.appendChild(row);
    cb(new SearchComponent(row));
    return this;
  }

  then(cb: (g: this) => unknown): this {
    cb(this);
    return this;
  }
}

export class SettingPage extends SettingGroup {
  constructor(name?: string) {
    // SettingPage 本身没有容器参数，由宿主在显示时把它挂到对话框里
    super(name);
    this.settingEl.classList.add("nf-setting-page");
  }
}

/* ---------- 渲染子组件 ---------- */

/** Markdown 后处理器里 ctx.addChild(new MarkdownRenderChild(el)) 的参数。 */
export class MarkdownRenderChild extends Component {
  el: HTMLElement;

  constructor(el: HTMLElement) {
    super();
    this.el = el;
  }

  onload(): void {}

  onunload(): void {
    super.onunload();
  }
}

/* ---------- 弹窗补充 ---------- */

/** 带确认按钮的确认弹窗。 */
export class ConfirmationModal extends Modal {
  confirmText: string;
  onConfirm: () => void;

  constructor(app: unknown, confirmText: string, onConfirm: () => void) {
    super(app);
    this.confirmText = confirmText;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    this.setTitle(this.titleEl.textContent || "确认");
    const b = this.addButton();
    b.textContent = "取消";
    b.onclick = () => this.close();
    const ok = this.addButton();
    ok.textContent = this.confirmText;
    ok.className = "mod-cta";
    ok.onclick = () => {
      this.onConfirm();
      this.close();
    };
  }
}

/* ---------- 视图补充 ---------- */

/**
 * 文本文件视图基类（插件用它显示自定义格式的纯文本文件）。
 * 继承 EditableFileView（与 Obsidian 的继承链一致），保存能力直接用基类的。
 */
export abstract class TextFileView extends EditableFileView {
  override getViewType(): string {
    return "text-file-view";
  }

  onSave(data: string): Promise<void> {
    this.data = data;
    return Promise.resolve();
  }

  abstract onload(): void;

  abstract onunload(): void;
}

/* ---------- 编辑器自动补全基类 ---------- */

/**
 * EditorSuggest：编辑器内的补全弹层基类。插件继承它并实现
 * onTrigger / getSuggestions / renderSuggestion / selectSuggestion。
 */
export abstract class EditorSuggest<T> {
  el: HTMLElement | null = null;
  limit = 100;
  scope: Scope;
  app: unknown;

  constructor(app: unknown) {
    this.app = app;
    this.scope = new Scope();
  }

  onTrigger(_cursor: { line: number; ch: number }, _editor: unknown, _file: unknown): boolean | { start: { line: number; ch: number }; end: { line: number; ch: number } } | null {
    return null;
  }

  abstract getSuggestions(context: {
    editor: unknown;
    file: unknown;
    start: { line: number; ch: number };
    end: { line: number; ch: number };
    query: string;
  }): T[] | Promise<T[]>;

  renderSuggestion(_value: T, _el: HTMLElement): void {}

  selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}

  close(): void {
    this.el?.remove();
    this.el = null;
  }

  /** 宿主调用入口：显示弹层并挂到 body。 */
  async open(anchorEl: HTMLElement, context: Parameters<EditorSuggest<T>["getSuggestions"]>[0]): Promise<void> {
    const items = (await this.getSuggestions(context)) ?? [];
    this.close();
    if (!items.length) return;
    const el = document.createElement("div");
    el.className = "nf-suggest-popup";
    Object.assign(el.style, {
      position: "absolute",
      zIndex: "9998",
      background: "var(--background-primary,#fff)",
      border: "1px solid var(--background-modifier-border,#8883)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,.24)",
      maxHeight: "240px",
      overflow: "auto",
      minWidth: "220px",
    } as Partial<CSSStyleDeclaration>);
    for (const item of items.slice(0, this.limit)) {
      const row = document.createElement("div");
      row.className = "nf-suggest-item";
      Object.assign(row.style, { padding: "5px 9px", cursor: "pointer" } as Partial<CSSStyleDeclaration>);
      this.renderSuggestion(item, row);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.selectSuggestion(item, new MouseEvent("mousedown"));
        this.close();
      });
      el.appendChild(row);
    }
    document.body.appendChild(el);
    this.el = el;
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      el.style.left = `${r.left}px`;
      el.style.top = `${r.bottom + 4}px`;
    }
  }
}

/* ---------- 其它 ---------- */

/** Obsidian 用来加载 pdf.js 的入口；noteforge 预览层没有内嵌 pdf.js。 */
export async function loadPdfJs(): Promise<unknown> {
  throw new Error("noteforge 未内嵌 pdf.js（PDF 由系统默认程序打开）");
}

export { escapeHtml, MarkdownView, Workspace };