/**
 * Plugin 基类与插件侧注册 API。
 *
 * 关键设计：宿主上下文（host / 数据目录）挂在 app 对象上，由 shim 工厂注入。
 * 这样插件自己写的 `class X extends Plugin { constructor(app, manifest) { super(app, manifest) } }`
 * 与 Obsidian 完全一致，不需要为 noteforge 改任何一行插件代码。
 */

import { Component, Events, Platform, addIcon, debounce, setIcon } from "./events";
import type { TAbstractFile, TFile } from "./items";
import type { PluginManifest } from "./types";
import type { View, WorkspaceLeaf } from "./workspace";

export interface Command {
  id: string;
  name: string;
  icon?: string;
  mobileOnly?: boolean;
  repeatable?: boolean;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: unknown, ctx: unknown) => boolean | void;
  editorCheckCallback?: (checking: boolean, editor: unknown, ctx: unknown) => boolean | void;
  hotkeys?: unknown[];
}

export interface PluginContext {
  host: import("./types").Host;
  /** 宿主插件注册表（命令/设置页/视图的汇总） */
  registry?: import("./index").PluginRegistry;
  /** 插件注册的编辑器补全器 */
  editorSuggests?: unknown[];
  /** 插件 id（数据目录 .obsidian/plugins/<id>/data.json） */
  id: string;
  /** 宿主提供的 CodeMirror 扩展收集器 */
  editorExtensions?: unknown[];
  /** Markdown 后处理器收集器 */
  postProcessors?: Map<string, (el: HTMLElement, ctx: { sourcePath: string; addChild(child: Component): void }) => unknown>;
  codeBlockProcessors?: Map<string, (source: string, el: HTMLElement, ctx: unknown) => unknown>;
}

const CTX = Symbol.for("noteforge.obsidian.ctx");

/** 由 shim 工厂在创建 app 时调用，把上下文挂到 app 上。 */
export function attachPluginContext(app: object, ctx: PluginContext): void {
  Object.defineProperty(app, CTX, { value: ctx, enumerable: false, configurable: true });
}

export function getPluginContext(app: unknown): PluginContext | undefined {
  if (!app || typeof app !== "object") return undefined;
  return (app as Record<symbol, unknown>)[CTX] as PluginContext | undefined;
}

/** Plugin 只需要 app 的少数能力，这里用结构类型避免与 index.ts 循环依赖。 */
export type ObsidianAppLike = object;

export abstract class Plugin extends Component {
  manifest: PluginManifest;
  private ctx: PluginContext | undefined;
  private commands: Command[] = [];
  private settingTabs: unknown[] = [];
  private ribbonEls: HTMLElement[] = [];
  private statusBarEls: HTMLElement[] = [];
  private disposers: Array<() => void> = [];
  private dataCache: unknown = null;

  app: ObsidianAppLike;

  constructor(app: ObsidianAppLike, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this.ctx = getPluginContext(app);
  }

  get _ctx(): PluginContext {
    if (!this.ctx) {
      throw new Error(`插件 ${this.manifest.id} 未绑定宿主上下文（应由 shim 工厂创建）`);
    }
    return this.ctx;
  }

  /* ---------- 生命周期 ---------- */

  onload(): void {}

  onunload(): void {
    for (const d of this.disposers) {
      try {
        d();
      } catch (e) {
        console.error(`[obsidian-shim] ${this.manifest.id} 清理失败:`, e);
      }
    }
    this.disposers = [];
    for (const el of this.ribbonEls) el.remove();
    this.ribbonEls = [];
    for (const el of this.statusBarEls) el.remove();
    this.statusBarEls = [];
    this.commands = [];
  }

  /* ---------- 工作区 ---------- */

  private ws(): Record<string, unknown> | undefined {
    return (this.app as unknown as { workspace?: Record<string, unknown> })?.workspace;
  }

  registerView(type: string, factory: (leaf: never) => unknown): void {
    (this.ws()?.registerView as ((t: string, f: unknown) => void) | undefined)?.(type, factory);
  }

  registerEphemeralView(type: string, factory: (leaf: never) => unknown): void {
    this.registerView(type, factory);
  }

  getLeavesOfType(type: string): unknown[] {
    const f = this.ws()?.getLeavesOfType as ((t: string) => unknown[]) | undefined;
    return f ? f.call(this.ws(), type) : [];
  }

  getLeaf(...args: unknown[]): unknown {
    const f = this.ws()?.getLeaf as ((...a: unknown[]) => unknown) | undefined;
    return f?.call(this.ws(), ...args);
  }

  getRightLeaf(split?: boolean): unknown {
    const f = this.ws()?.getRightLeaf as ((s?: boolean) => unknown) | undefined;
    return f?.call(this.ws(), split);
  }

  getActiveViewOfType<T>(type: string): T | null {
    const f = this.ws()?.getActiveViewOfType as ((t: string) => T | null) | undefined;
    return f ? f.call(this.ws(), type) : null;
  }

  revealLeaf(leaf: unknown): void {
    (this.ws()?.revealLeaf as ((l: unknown) => void) | undefined)?.call(this.ws(), leaf);
  }

  detachLeavesOfType(type: string): void {
    (this.ws()?.detachLeavesOfType as ((t: string) => void) | undefined)?.call(this.ws(), type);
  }

  setActiveLeaf(leaf: unknown, params?: unknown): void {
    (this.ws()?.setActiveLeaf as ((l: unknown, p?: unknown) => void) | undefined)?.call(this.ws(), leaf, params);
  }

  /* ---------- 命令 ---------- */

  addCommand(command: Command): Command {
    const full: Command = { ...command, id: `${this.manifest.id}:${command.id}` };
    this.commands.push(full);
    // 同步到 app.commands，宿主（命令面板）直接枚举这份注册表
    const reg = (this.app as unknown as { commands?: { commands: Record<string, Command> } })?.commands;
    if (reg) reg.commands[full.id] = full;
    return full;
  }

  removeCommand(id: string): void {
    const full = `${this.manifest.id}:${id}`;
    this.commands = this.commands.filter((c) => c.id !== full);
    const reg = (this.app as unknown as { commands?: { commands: Record<string, Command> } })?.commands;
    if (reg) delete reg.commands[full];
  }

  /** 供宿主读取（命令面板用）。 */
  getCommands(): Command[] {
    return [...this.commands];
  }

  /* ---------- UI 部件 ---------- */

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement("a");
    el.addClass?.("clickable-icon nf-plugin-ribbon-icon");
    el.setAttribute("aria-label", title);
    el.title = title;
    setIcon(el, icon);
    el.addEventListener("click", callback as EventListener);
    const host = (this.app as unknown as { workspace?: { containerEl?: HTMLElement } })?.workspace?.containerEl;
    host?.appendChild(el);
    this.ribbonEls.push(el);
    return el;
  }

  addStatusBarItem(): HTMLElement {
    const el = document.createElement("div");
    el.addClass?.("statusbar-item");
    const host =
      (this.app as unknown as { workspace?: { containerEl?: HTMLElement } })?.workspace?.containerEl ?? null;
    host?.appendChild(el);
    this.statusBarEls.push(el);
    return el;
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
    // 直接写 registry：插件可能在 onload 之后才注册设置页，宿主要能实时看到
    this.ctx?.registry?.settingsTabs.get(this.manifest.id)?.push(tab);
  }

  getSettingTabs(): unknown[] {
    return [...this.settingTabs];
  }

  /* ---------- 注册 ---------- */

  registerEvent(ref: unknown): void {
    super.registerEvent(ref as never);
    this.disposers.push(() => (ref as { offref?: (r: unknown) => void })?.offref?.(ref));
  }

  registerDomEvent(el: EventTarget, type: string, cb: EventListener, options?: AddEventListenerOptions): void {
    el.addEventListener(type, cb, options);
    const off = () => el.removeEventListener(type, cb, options);
    this._domEvents.push(off);
    this.disposers.push(off);
  }

  registerInterval(id: number): number {
    this._intervals.push(id);
    const off = () => clearInterval(id);
    this.disposers.push(off);
    return id;
  }

  register(cb: () => unknown): void {
    const off = () => {
      void cb();
    };
    this.disposers.push(off);
  }

  registerEditorExtension(ext: unknown): void {
    this._ctx.editorExtensions?.push(ext);
    this.disposers.push(() => {
      const arr = this._ctx.editorExtensions;
      if (!arr) return;
      const i = arr.indexOf(ext);
      if (i >= 0) arr.splice(i, 1);
    });
  }

  registerExtensions(exts: unknown[], viewType: string): void {
    for (const e of exts) this.registerEditorExtension(e);
    void viewType;
  }

  registerMarkdownPostProcessor(
    processor: (el: HTMLElement, ctx: { sourcePath: string; frontmatter?: unknown; addChild(child: Component): void }) => unknown,
    sortOrder = 0,
  ): unknown {
    const key = `${this.manifest.id}:pp:${sortOrder}`;
    this._ctx.postProcessors?.set(key, processor as never);
    return { key };
  }

  registerMarkdownCodeBlockProcessor(
    language: string,
    processor: (source: string, el: HTMLElement, ctx: unknown) => unknown,
    sortOrder = 0,
  ): unknown {
    const key = `${this.manifest.id}:cb:${sortOrder}:${language}`;
    this._ctx.codeBlockProcessors?.set(key, processor as never);
    return { key };
  }

  registerHoverLinkSource(_id: string, _info: unknown): void {}

  /** 注册编辑器补全器（EditorSuggest 子类）。 */
  registerEditorSuggest(suggestor: unknown): void {
    const arr = this.ctx?.editorSuggests;
    if (arr) {
      arr.push(suggestor);
      this.disposers.push(() => {
        const i = arr.indexOf(suggestor);
        if (i >= 0) arr.splice(i, 1);
      });
    }
  }

  /** 注册代码块预览（MarkdownCodeBlockProcessor 的旧名）。 */
  registerMarkdownPostProcessors(list: Array<(el: HTMLElement, ctx: unknown) => unknown>): void {
    list.forEach((fn, i) => this.registerMarkdownPostProcessor(fn as never, i));
  }

  registerObsidianProtocolHandler(_action: string, _handler: unknown): void {}

  onExternalSettingsChange(): void {}

  /* ---------- 数据 ---------- */

  private dataPath(): string {
    return `.obsidian/plugins/${this.manifest.id}/data.json`;
  }

  async loadData(): Promise<unknown> {
    try {
      const raw = await this._ctx.host.fs.read(this.dataPath());
      this.dataCache = JSON.parse(raw);
    } catch {
      this.dataCache = null;
    }
    return this.dataCache;
  }

  async saveData(data: unknown): Promise<void> {
    this.dataCache = data;
    const dir = `.obsidian/plugins/${this.manifest.id}`;
    try {
      await this._ctx.host.fs.mkdir(dir);
    } catch {
      /* 目录已存在 */
    }
    await this._ctx.host.fs.write(this.dataPath(), JSON.stringify(data, null, 2));
  }

  /** Obsidian 里这两个类型是 Plugin 的类型别名 */
  onloadAsync?: never;
}

/** Obsidian 1.5+ 的 Plugin_2（旧名兼容） */
export class Plugin_2 extends Plugin {}

export type { TAbstractFile, TFile, View, WorkspaceLeaf, Events, Platform, addIcon, debounce };
