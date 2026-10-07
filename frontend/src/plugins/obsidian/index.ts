/**
 * Obsidian 兼容模块工厂：拼装出 `require("obsidian")` 能拿到的全部导出。
 *
 * 调用方（应用内加载器 / 兼容性测试 harness）都通过 createObsidianApi() 拿到
 * { module, app, workspace, vault, metadataCache, recorder }，从而保证
 * 「测的就是跑的」——harness 测的对象与应用内加载的模块是同一段代码。
 */

import { createElement, installDomExtensions } from "./dom";
import { createElectronStub } from "../loader";
import {
  Component,
  Events,
  Platform,
  Scope,
  addIcon,
  debounce,
  escapeRegExp,
  getAllTags,
  normalizePath,
  parseLinktext,
  parseYaml,
  resolveSubpath,
  sanitizeHTML,
  sanitizeHTMLToDom,
  setIcon,
  stringifyYaml,
} from "./events";
import { TAbstractFile, TFile, TFolder } from "./items";
import { attachPluginContext, getPluginContext, Plugin, Plugin_2, type Command, type PluginContext } from "./plugin";
import {
  EditorChange,
  EditorPosition,
  EditorRange,
  EditorSelection,
  FileSystemAdapter,
  duration,
  format as padNumber,
  isValid as isValidDate,
  moment,
  request,
  requestUrl,
} from "./request";
import {
  AbstractInputSuggest,
  BaseComponent,
  ButtonComponent,
  DropdownComponent,
  ExtraButtonComponent,
  Menu,
  MenuItem,
  Modal,
  Notice,
  PluginSettingTab,
  SearchComponent,
  Setting,
  SettingTab,
  SliderComponent,
  SuggestModal,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
  ValueComponent,
  FuzzySuggestModal,
} from "./ui";
import {
  ConfirmationModal,
  EditorSuggest,
  Keymap,
  MarkdownRenderChild,
  TextFileView,
  WorkspaceSplit,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  editorInfoField,
  editorLivePreviewField,
  getFrontMatterInfo,
  getIcon,
  getIconIds,
  getLanguage,
  getLinkpath,
  loadPdfJs,
  parseFrontMatterEntry,
  parseFrontMatterTags,
  prepareFuzzySearch,
  prepareSimpleSearch,
  requireApiVersion,
  setTooltip as setTooltipModule,
  SettingGroup,
  SettingPage,
  CodeMirror,
} from "./extra";
import { FileManager, MetadataCache, Vault } from "./vault";
import {
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  View,
  Workspace,
  WorkspaceLeaf,
  fallbackRender,
  type EditorLike,
  type ViewState,
  type WorkspaceHooks,
} from "./workspace";
import { createRecorder, type ApiRecorder, type Host, type PluginManifest } from "./types";

/** Obsidian 的 App：插件唯一接触宿主的入口。 */
export interface ObsidianApp {
  vault: Vault;
  workspace: Workspace;
  metadataCache: Vault["metadataCache"];
  fileManager: FileManager;
  keymap: { pushScope(scope: unknown): void; popScope(scope: unknown): void };
  scope: unknown;
  lastEvent: MouseEvent | null;
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): Promise<void>;
  removeLocalStorage(key: string): void;
  commands: {
    /** Obsidian 的 listCommands() 返回命令数组（不是字典）。 */
    listCommands(): Command[];
    executeCommandById(id: string): void;
    /** id → 命令的索引表（宿主执行命令时用） */
    commands: Record<string, Command>;
    /** Obsidian 有这个方法，插件会用它注销内置命令 */
    removeCommand(id: string): void;
  };
  plugins: { plugins: Record<string, Plugin>; enabledPlugins: Set<string>; getPlugin(id: string): Plugin | null };
  internalPlugins: { plugins: Record<string, Plugin>; enabledPlugins: Set<string>; getPluginById(id: string): Plugin | null };
  setConfig(key: string, value: unknown): void;
  getConfig?(key: string): unknown;
  [k: string]: unknown;
}

/** 宿主内置命令的实现（可选）。 */
export interface CoreCommandHooks {
  saveFile?: () => void;
  toggleMode?: (mode: "source" | "preview" | "live") => void;
  openSettings?: () => void;
}

export interface CreateApiOptions {
  /** vault 显示名（默认取宿主目录名） */
  name?: string;
  workspaceHooks?: Partial<WorkspaceHooks>;
  /** 初始文档（vault 文件系统内容）——内存 host 用 */
  files?: Record<string, string>;
  /** 宿主内置命令的实现 */
  coreHooks?: CoreCommandHooks;
}

export interface ObsidianApi {
  module: Record<string, unknown>;
  app: ObsidianApp;
  workspace: Workspace;
  vault: Vault;
  metadataCache: Vault["metadataCache"];
  fileManager: FileManager;
  registry: PluginRegistry;
  recorder: ApiRecorder;
  /** 卸载全部已加载插件（测试隔离 / 应用重启插件） */
  unloadAll(): Promise<void>;
}

/** 宿主侧插件注册表：跨插件互查（app.plugins.getPlugin）。 */
export class PluginRegistry {
  plugins = new Map<string, Plugin>();
  settingsTabs = new Map<string, unknown[]>();
  editorExtensions: unknown[] = [];
  editorSuggests: unknown[] = [];
  postProcessors = new Map<string, (el: HTMLElement, ctx: { sourcePath: string; addChild(child: Component): void }) => unknown>();
  codeBlockProcessors = new Map<string, (source: string, el: HTMLElement, ctx: unknown) => unknown>();
  editors: PluginContext[] = [];

  add(p: Plugin): void {
    this.plugins.set(p.manifest.id, p);
    this.settingsTabs.set(p.manifest.id, p.getSettingTabs());
  }

  get(id: string): Plugin | null {
    return this.plugins.get(id) ?? null;
  }

  all(): Plugin[] {
    return [...this.plugins.values()];
  }

  /** 卸载全部：先调 onunload，再从注册表移除。 */
  async unloadAll(): Promise<void> {
    for (const p of [...this.plugins.values()].reverse()) {
      try {
        p.onunload();
      } catch (e) {
        console.error(`[obsidian-shim] 卸载 ${p.manifest.id} 出错:`, e);
      }
    }
    this.plugins.clear();
    this.settingsTabs.clear();
    this.editorExtensions = [];
    this.editorSuggests = [];
    this.postProcessors.clear();
    this.codeBlockProcessors.clear();
  }
}

const DEFAULT_HOOKS: WorkspaceHooks = {
  activeFile: () => null,
  openFile: async () => undefined,
  getLeafContainer: () => null,
  editor: () => null,
  editorFile: () => null,
};

/** 创建一整套 Obsidian 兼容环境。 */
export function createObsidianApi(host: Host, opts: CreateApiOptions = {}): ObsidianApi {
  installDomExtensions();
  const coreHooks = opts.coreHooks ?? {};

  const recorder = createRecorder();
  const registry = new PluginRegistry();

  const vault = new Vault(host, opts.name ?? "vault");
  const hooks: WorkspaceHooks = { ...DEFAULT_HOOKS, ...(opts.workspaceHooks ?? {}) };
  const workspace = new Workspace(host, vault, vault.metadataCache, hooks);
  const fileManager = new FileManager({ vault, metadataCache: vault.metadataCache });

  const localStore = new Map<string, unknown>();
  const appScopes: unknown[] = [];

  const app: ObsidianApp = {
    vault,
    workspace,
    metadataCache: vault.metadataCache,
    fileManager,
    keymap: {
      pushScope: (scope: unknown) => appScopes.push(scope),
      popScope: (scope: unknown) => {
        const i = appScopes.indexOf(scope);
        if (i >= 0) appScopes.splice(i, 1);
      },
    },
    // Obsidian 的 App 自带 scope（应用级快捷键作用域）。插件里常见
    // `this.app.scope.register([], "Tab", ...)`，缺了会在 onload 里崩。
    scope: new Scope(),
    lastEvent: null,
    loadLocalStorage: (k) => {
      if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(`nf-plugin-ls:${k}`);
        if (raw !== null) {
          try {
            return JSON.parse(raw);
          } catch {
            return raw;
          }
        }
      }
      return localStore.get(k) ?? null;
    },
    saveLocalStorage: async (k, v) => {
      localStore.set(k, v);
      if (typeof localStorage !== "undefined") localStorage.setItem(`nf-plugin-ls:${k}`, JSON.stringify(v));
    },
    removeLocalStorage: (k) => {
      localStore.delete(k);
      if (typeof localStorage !== "undefined") localStorage.removeItem(`nf-plugin-ls:${k}`);
    },
    commands: buildCommandRegistry(),
    plugins: {
      plugins: proxyPlugins(registry),
      enabledPlugins: new Set<string>(),
      getPlugin: (id) => registry.get(id),
    },
    internalPlugins: {
      plugins: proxyPlugins(registry),
      enabledPlugins: new Set<string>(),
      getPluginById: (id) => registry.get(id),
    },
    setConfig: (k, v) => vault.setConfig(k, v),
    embedRegistry: createEmbedRegistry(),
  };

  // app.dom / app.containerEl：不少插件直接往这些容器里塞 UI（状态栏、右键菜单层）。
  // Obsidian 的 App 上确实有 dom 这一组属性，缺了整个插件会炸在 appendChild 上。
  const mk = (cls: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = cls;
    document.body.appendChild(el);
    return el;
  };
  const domEls = {
    appContainerEl: mk("nf-dom-app-container"),
    containerEl: mk("nf-dom-container"),
    floatingEl: mk("nf-dom-floating"),
    modalContainerEl: mk("nf-dom-modal"),
    statusBarEl: mk("nf-dom-statusbar"),
    titlebarEl: mk("nf-dom-titlebar"),
    workspaceEl: mk("nf-dom-workspace"),
  };
  app.dom = domEls;
  app.containerEl = domEls.appContainerEl;
  app.appContainerEl = domEls.appContainerEl;

  workspace.app = app;

  // 每个 app 共享同一个上下文对象：插件注册 CM 扩展/后处理器都会落到这里
  const ctx: PluginContext = {
    host,
    id: "",
    registry,
    editorExtensions: registry.editorExtensions,
    editorSuggests: registry.editorSuggests,
    postProcessors: registry.postProcessors,
    codeBlockProcessors: registry.codeBlockProcessors,
  };
  attachPluginContext(app, ctx);
  registry.editors.push(ctx);

  const module = buildModule(app, host, recorder);
  installObsidianGlobals(module, app, workspace);
  registerCoreCommands(app, coreHooks);

  return {
    module,
    app,
    workspace,
    vault,
    metadataCache: vault.metadataCache,
    fileManager,
    registry,
    recorder,
    unloadAll: () => registry.unloadAll(),
  };
}

/**
 * Obsidian 的内置命令。插件会按 id 找它们（最常见的是 editor:save-file），
 * 找不到时会在 onload 里抛 —— 所以哪怕行为是空实现也要注册。
 */
function registerCoreCommands(app: ObsidianApp, hooks: CoreCommandHooks): void {
  const reg = app.commands.commands;
  const put = (id: string, name: string, run: () => void) => {
    reg[id] = {
      id,
      name,
      callback: () => {
        try {
          run();
        } catch (e) {
          console.error(`[obsidian-shim] 内置命令 ${id} 执行失败`, e);
        }
      },
    };
  };
  put("editor:save-file", "保存当前文件", () => hooks.saveFile?.());
  put("editor:toggle-source", "切换源码视图", () => hooks.toggleMode?.("source"));
  put("editor:toggle-preview", "切换预览视图", () => hooks.toggleMode?.("preview"));
  put("editor:toggle-live-preview", "切换即输即显", () => hooks.toggleMode?.("live"));
  put("markdown:toggle-preview", "切换预览", () => hooks.toggleMode?.("preview"));
  put("app:open-settings", "打开设置", () => hooks.openSettings?.());
  put("editor:follow-link", "跟随链接", () => undefined);
  put("app:reload", "重载应用", () => undefined);
  put("editor:toggle-vim-mode", "切换 Vim 模式", () => undefined);
}

/**
 * Obsidian 把一批 API 挂成全局（activeDocument / activeWindow / notice / normalizePath …），
 * 插件可以直接用而不 import。缺这些会在插件初始化时抛 ReferenceError。
 */
function installObsidianGlobals(
  module: Record<string, unknown>,
  app: ObsidianApp,
  workspace: Workspace,
): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const keys = [
    "App", "TFile", "TFolder", "TAbstractFile", "Plugin", "PluginSettingTab", "Setting",
    "Notice", "Modal", "SuggestModal", "FuzzySuggestModal", "Menu", "MenuItem", "ItemView",
    "MarkdownView", "MarkdownRenderer", "WorkspaceLeaf", "View", "Component", "Events",
    "Platform", "requestUrl", "request", "moment", "normalizePath", "parseLinktext",
    "getAllTags", "parseYaml", "stringifyYaml", "setIcon", "addIcon", "debounce",
    "sanitizeHTMLToDom", "sanitizeHTML", "escapeRegExp", "htmlToMarkdown", "markdownToHtml",
    "Editor", "FileSystemAdapter", "AbstractInputSuggest", "ButtonComponent", "TextComponent",
    "TextAreaComponent", "ToggleComponent", "DropdownComponent", "SliderComponent",
    "SearchComponent", "ExtraButtonComponent", "Scope", "ValueComponent", "ConfirmationModal",
    "TextFileView", "EditorSuggest", "MarkdownRenderChild", "WorkspaceSplit", "Keymap",
    "SettingGroup", "SettingPage", "CodeMirror", "getIconIds", "getFrontMatterInfo", "parseFrontMatterEntry", "parseFrontMatterTags", "prepareSimpleSearch",
    "prepareFuzzySearch", "requireApiVersion", "base64ToArrayBuffer", "arrayBufferToBase64",
  ];
  // window 与 globalThis 在 webview 里是同一个对象，但 harness（jsdom）里不是：
  // 插件会直接读 window.CodeMirror，因此两边都要挂。
  const win = (globalThis.window ?? undefined) as unknown as Record<string, unknown> | undefined;
  for (const k of keys) {
    if (module[k] !== undefined) {
      g[k] = module[k];
      if (win && win[k] === undefined) win[k] = module[k];
    }
  }
  // electron 全局：pdf-plus 等桌面插件直接读 window.electron.remote.app.getVersion()
  const g2 = globalThis as unknown as { __nfElectron?: Record<string, unknown> };
  if (!g2.__nfElectron) {
    // 延迟 require 循环：loader 不依赖 obsidian 模块，这里静态引入是安全的
    g2.__nfElectron = { ...createElectronStub() };
  }
  if (g.electron === undefined) g.electron = g2.__nfElectron;
  if (win && win.electron === undefined) win.electron = g2.__nfElectron;
  // Obsidian 内部的编辑器适配器全局：插件会往 .commands 上注册快捷命令
  if (g.CodeMirrorAdapter === undefined) {
    g.CodeMirrorAdapter = {
      commands: {} as Record<string, () => void>,
      effects: {} as Record<string, unknown>,
      editor: { destroy: () => undefined, refresh: () => undefined },
      isLegacy: false,
    };
    if (win && win.CodeMirrorAdapter === undefined) win.CodeMirrorAdapter = g.CodeMirrorAdapter;
  }
  g.activeDocument = document;
  g.activeWindow = globalThis.window ?? undefined;
  g.activeEditor = null;
  g.activeView = null;
  g.activeFile = null;
  g.app = app;
  g.workspace = workspace;
  g.getLinkpath = module.getLinkpath ?? ((linkpath: string) => linkpath);
  // Obsidian 把 createEl/createDiv/createSpan 挂在 window 上（独立函数，不是原型方法）
  g.createEl = (tag: string, o?: unknown, cb?: (el: HTMLElement) => void) =>
    createElement(tag, o as never, cb);
  g.createDiv = (o?: unknown, cb?: (el: HTMLElement) => void) => createElement("div", o as never, cb);
  g.createSpan = (o?: unknown, cb?: (el: HTMLElement) => void) => createElement("span", o as never, cb);

  // Obsidian 的 Window 接口：activeWindow.createDiv()/createSpan()/createSvg()
  const winAny = win as unknown as Record<string, unknown> | undefined;
  const wEl = winAny ?? (g as unknown as Record<string, unknown>);
  wEl.createDiv = (o?: unknown, cb?: (el: HTMLElement) => void) => {
    const el = createElement("div", o as never, cb);
    return el;
  };
  wEl.createSpan = (o?: unknown, cb?: (el: HTMLElement) => void) => {
    const el = createElement("span", o as never, cb);
    return el;
  };
  wEl.createSvg = (name?: string, attr?: Record<string, string>) => {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg") as unknown as HTMLElement;
    svg.setAttribute("xmlns", NS);
    // Obsidian 的 createSvg 返回一个带 viewBox 的空 svg，插件靠它按 name 画图
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("data-icon", name ?? "");
    for (const [k, v] of Object.entries(attr ?? {})) svg.setAttribute(k, v);
    return svg;
  };

  // Obsidian 的全局 createFragment()（与 document.createFragment 同义）
  if (typeof g.createFragment !== "function") {
    g.createFragment = (cb?: (frag: DocumentFragment) => void) => {
      const frag = document.createDocumentFragment();
      cb?.(frag);
      return frag;
    };
  }
  g.notice = (msg: string) => new (module.Notice as new (m: string) => unknown)(msg);
  // 部分桌面插件用 window.require 加载内置模块
  if (typeof g.require !== "function") {
    const map: Record<string, Record<string, unknown>> = {
      obsidian: module as Record<string, unknown>,
      electron: (globalThis as { __nfElectron?: Record<string, unknown> }).__nfElectron ?? {},
    };
    g.require = (name: string) => map[name] ?? ({} as Record<string, unknown>);
    if (win && typeof win.require !== "function") {
      win.require = g.require as (name: string) => unknown;
    }
  }
  g.requestUrl = module.requestUrl;
  g.normalizePath = module.normalizePath;
  g.debounce = module.debounce;
  g.moment = module.moment;
}

/**
 * shim 实际导出的符号名（测试与文档用，避免「文档写了但没实现」）。
 */
export let OBSIDIAN_EXPORT_NAMES: string[] = [];

/**
 * app.embedRegistry：把「按扩展名渲染嵌入块」交给宿主。
 * Obsidian 的 API 是 `app.embedRegistry.embedByExtension.md(el, source, component)`
 * 这种按扩展名取构造器的方式，插件（kanban 等）直接这么用。
 */
function createEmbedRegistry() {
  const byExt: Record<string, (el: HTMLElement) => unknown> = {};
  const byMime: Record<string, (el: HTMLElement) => unknown> = {};

  /** 内嵌块的公共形状：load() 触发渲染，editable 控制是否可编辑。 */
  const makeEmbed = (el: HTMLElement, render: () => void | Promise<void>) => {
    let editable = false;
    return {
      el,
      containerEl: el,
      get editable() {
        return editable;
      },
      set editable(v: boolean) {
        editable = v;
      },
      setEditable(v: boolean) {
        editable = v;
      },
      // kanban 这类插件会把内嵌块在「编辑态/阅读态」之间切换
      showEditor: () => {
        editable = true;
      },
      hideEditor: () => {
        editable = false;
      },
      load() {
        void render();
      },
      onload() {
        /* 由 load 驱动 */
      },
      destroy() {
        el.replaceChildren();
      },
    };
  };

  for (const ext of ["md", "markdown"]) {
    byExt[ext] = (el) =>
      makeEmbed(el, async () => {
        // markdown 内嵌：直接显示原文文本。预览级渲染由宿主的视图决定。
        const text = el.dataset.src ?? el.textContent ?? "";
        el.textContent = text;
      });
  }
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]) {
    byExt[ext] = (el) =>
      makeEmbed(el, () => {
        const src = el.dataset.src ?? el.getAttribute("src") ?? "";
        if (!src) return;
        const img = document.createElement("img");
        img.src = src;
        img.style.maxWidth = "100%";
        el.replaceChildren(img);
      });
  }
  for (const ext of ["mp3", "wav", "ogg", "m4a", "mp4", "webm"]) {
    byExt[ext] = (el) =>
      makeEmbed(el, () => {
        const src = el.dataset.src ?? el.getAttribute("src") ?? "";
        if (!src) return;
        const media = document.createElement(ext.startsWith("m4a") || ext.startsWith("mp") ? "audio" : ext.startsWith("mp4") || ext.startsWith("webm") ? "video" : "audio");
        media.src = src;
        el.replaceChildren(media);
      });
  }

  return {
    embedByExtension: byExt,
    getEmbedForExtension: (ext: string) => byExt[ext.toLowerCase().replace(/^\./, "")],
    registerExtension: (ext: string, builder: (el: HTMLElement) => unknown) => {
      byExt[ext.toLowerCase().replace(/^\./, "")] = builder;
    },
    registerExtensionForMime: (mime: string, builder: (el: HTMLElement) => unknown) => {
      byMime[mime] = builder;
    },
  };
}

/** app.commands：宿主命令面板直接读这份表，执行走插件自己的 callback。 */
function buildCommandRegistry() {
  const commands: Record<string, Command> = {};
  return {
    commands,
    // Obsidian 的 listCommands() 返回**数组**（插件会直接 .filter/.map），
    // 早先返回对象，obsidian-linter 这类插件会拿到 undefined.length 而崩。
    listCommands: () => Object.values(commands),
    removeCommand: (id: string) => {
      delete commands[id];
    },
    executeCommandById: (id: string) => {
      const c = commands[id];
      if (!c) {
        console.warn(`[obsidian-shim] 命令不存在: ${id}`);
        return;
      }
      if (c.checkCallback) {
        // checkCallback 返回 false 表示当前不可用（check 阶段）
        if (c.checkCallback(false) === false) return;
      }
      c.callback?.();
    },
  };
}

function proxyPlugins(registry: PluginRegistry): Record<string, Plugin> {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => registry.get(prop) ?? undefined,
      has: (_t, prop: string) => registry.plugins.has(prop),
      ownKeys: () => [...registry.plugins.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  ) as Record<string, Plugin>;
}

function buildModule(app: ObsidianApp, host: Host, recorder: ApiRecorder): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    // 基础类型
    App: app,
    TAbstractFile,
    TFile,
    TFolder,
    Vault,
    MetadataCache,
    FileManager,
    FileSystemAdapter,
    Plugin,
    Plugin_2,
    PluginSettingTab,
    PluginManifest: {} as PluginManifest,
    PluginCache: class {},
    Editor: class {},
    EditorPosition,
    EditorSelection,
    EditorChange,
    EditorRange,
    Component,
    Events,

    // 视图/工作区
    ItemView,
    View,
    MarkdownView,
    FileView: MarkdownView,
    EmptyView: class {},
    WorkspaceLeaf,
    Workspace,
    MarkdownRenderer,

    // UI
    Scope,
    Notice,
    Modal,
    SuggestModal,
    FuzzySuggestModal,
    AbstractInputSuggest,
    Menu,
    MenuItem,
    Setting,
    SettingTab,
    ButtonComponent,
    ExtraButtonComponent,
    TextComponent,
    TextAreaComponent,
    ToggleComponent,
    DropdownComponent,
    SliderComponent,
    SearchComponent,
    BaseComponent,

    // 函数
    addIcon,
    setIcon,
    debounce,
    normalizePath,
    escapeRegExp,
    getAllTags,
    parseLinktext,
    resolveSubpath,
    sanitizeHTML,
    sanitizeHTMLToDom,
    parseYaml,
    stringifyYaml,
    requestUrl,
    request,
    moment,
    duration,
    format: padNumber,
    isValid: isValidDate,
    htmlToMarkdown: async (html: string) => html,
    markdownToHtml: async (md: string, _path?: string, _c?: unknown) =>
      host.renderMarkdown ? host.renderMarkdown(md, "") : fallbackRender(md),
    Platform,
    apiVersion: "1.9.0",
    loadMermaid: async () => undefined,
    loadMathJax: async () => undefined,

    // 样本静态分析得出的第二批必需 API（见 extra.ts）
    getLanguage,
    getIcon,
    getIconIds,
    requireApiVersion,
    getLinkpath,
    base64ToArrayBuffer,
    arrayBufferToBase64,
    getFrontMatterInfo,
    parseFrontMatterEntry,
    parseFrontMatterTags,
    prepareSimpleSearch,
    prepareFuzzySearch,
    WorkspaceSplit,
    Keymap,
    editorInfoField,
    editorLivePreviewField,
    MarkdownRenderChild,
    ConfirmationModal,
    TextFileView,
    EditorSuggest,
    loadPdfJs,
    ValueComponent,
    SettingGroup,
    SettingPage,
    CodeMirror,
    // 新版 Obsidian 把 setTooltip 提到模块级（与 Element.setText 同风格）
    setTooltip: setTooltipModule,

    // 常量/类型占位
    HoverPopover: class {},
    MarkdownSubView: class {},
  };

  OBSIDIAN_EXPORT_NAMES = Object.keys(raw);

  // 记录访问与抛错：兼容性报告的数据来源
  return new Proxy(raw, {
    get(target, prop) {
      if (typeof prop !== "string") return Reflect.get(target, prop);
      if (!(prop in target)) {
        // __esModule 是 esbuild/rollup 的 interop 探测位，不算「插件需要的 API」
        if (prop !== "__esModule") recorder.recordUnsupported(prop);
        return undefined;
      }
      recorder.recordAccess(prop);
      const value = target[prop];
      if (typeof value !== "function") return value;
      return new Proxy(value as (...a: unknown[]) => unknown, {
        apply(fn, thisArg, args) {
          recorder.recordCall(prop);
          try {
            return Reflect.apply(fn, thisArg, args);
          } catch (err) {
            recorder.recordError(prop, err);
            throw err;
          }
        },
      });
    },
    has(target, prop) {
      return typeof prop === "string" ? prop in target : Reflect.has(target, prop);
    },
  });
}

export {
  Component,
  Events,
  Scope,
  Platform,
  TAbstractFile,
  TFile,
  TFolder,
  Plugin,
  PluginSettingTab,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Modal,
  SuggestModal,
  FuzzySuggestModal,
  Menu,
  MenuItem,
  Setting,
  ButtonComponent,
  TextComponent,
  TextAreaComponent,
  ToggleComponent,
  DropdownComponent,
  SliderComponent,
  SearchComponent,
  ExtraButtonComponent,
  requestUrl,
  request,
  moment,
  addIcon,
  setIcon,
  normalizePath,
  escapeRegExp,
  getAllTags,
  parseLinktext,
  debounce,
  sanitizeHTMLToDom,
  FileSystemAdapter,
  FileManager,
  Vault,
  Workspace,
  WorkspaceLeaf,
  View,
  AbstractInputSuggest,
  getPluginContext,
  getLanguage,
  getIcon,
  getIconIds,
  requireApiVersion,
  getLinkpath,
  base64ToArrayBuffer,
  arrayBufferToBase64,
  getFrontMatterInfo,
  parseFrontMatterEntry,
  parseFrontMatterTags,
  prepareSimpleSearch,
  prepareFuzzySearch,
  WorkspaceSplit,
  Keymap,
  editorInfoField,
  editorLivePreviewField,
  MarkdownRenderChild,
  ConfirmationModal,
  TextFileView,
  EditorSuggest,
  loadPdfJs,
  ValueComponent,
};
export type { Host, PluginManifest, EditorLike, ViewState, WorkspaceHooks, Command, ApiRecorder };
export { createMemoryHost, MemoryFs, createRecorder } from "./types";
export { fallbackRender } from "./workspace";