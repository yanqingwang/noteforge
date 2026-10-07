/**
 * 应用侧插件运行时：扫描 `<vault>/.obsidian/plugins/*`、加载启用的插件、
 * 把它们的命令/视图/设置页交给 UI。
 *
 * 与 Obsidian 一致的取舍：
 * - 插件代码在同一个 webview 里执行（拿到完整 app/vault/CM API）
 * - 插件设置与数据存在 Obsidian 的约定位置，两边共享同一个 vault 互不影响
 */

import { invoke } from "@tauri-apps/api/core";
import { createCmModules } from "./obsidian/cm-modules";
import { renderSettingTab } from "./obsidian/settingDefs";
import { createObsidianApi, type ObsidianApi, type PluginRegistry } from "./obsidian/index";
import { IndexStore } from "./obsidian/bases/index-store";
import { createTauriHost, createEditorAdapter } from "./obsidian/host-tauri";
import { createElectronStub, createNodeBuiltins, evaluatePlugin, withNodePrefixAliases } from "./loader";
import { editorBridge } from "../editor/bridge";

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  enabled: boolean;
  loaded: boolean;
  error: string | null;
  commands: string[];
  views: string[];
  hasSettings: boolean;
}

export interface RuntimeOptions {
  vaultPath: () => string;
  activeFile: () => string | null;
  openFile: (path: string) => Promise<void>;
  /** 宿主内置命令：保存 / 切视图模式 / 打开设置 */
  saveFile?: () => void;
  /** 打开某个插件自己的设置页（UI 层提供模态框） */
  openPluginSettings?: (pluginId: string) => void;
  toggleMode?: (mode: "source" | "preview" | "live") => void;
  openSettings?: () => void;
  /** 打开某个插件视图（UI 层负责把容器交进来） */
  ensureViewContainer: (type: string) => Promise<HTMLElement | null>;
}

class ObsidianRuntime {
  private api: ObsidianApi | null = null;
  private plugins = new Map<string, PluginSummary>();
  private containers = new Map<string, HTMLElement>();
  private styleEls: HTMLElement[] = [];
  private opts: RuntimeOptions | null = null;
  private loading: Promise<void> | null = null;
  private listChange: (() => void) | null = null;
  /** Bases 与 metadataCache 共用的元数据索引（frontmatter / 标签 / 链接） */
  private index = new IndexStore((cmd, args) => invoke(cmd, args));

  /** UI 订阅插件列表变化 */
  subscribe(fn: () => void): () => void {
    this.listChange = fn;
    return () => {
      if (this.listChange === fn) this.listChange = null;
    };
  }

  private notify(): void {
    this.listChange?.();
  }

  getApi(): ObsidianApi | null {
    return this.api;
  }

  /** 元数据索引（Bases 查询引擎与插件的 metadataCache 都吃它）。 */
  indexStore(): IndexStore {
    return this.index;
  }

  /** 索引构建耗时（ms），UI 可以显示「已索引 N 个文件，用时 Xms」。 */
  private indexMs = 0;
  indexStats(): { files: number; ms: number } {
    return { files: this.index.paths().length, ms: this.indexMs };
  }

  list(): PluginSummary[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): PluginSummary | undefined {
    return this.plugins.get(id);
  }

  /**
   * 宿主命令（CommandPalette 用），id 形如 `vault-agent:open-chat`。
   * 另附每个「有设置页」的插件一条打开设置的命令 —— 设置入口不能只藏在面板里，
   * 命令面板是最快的路径（也是能被自动化验证的路径）。
   */
  commands(): Array<{ id: string; name: string; run: () => void }> {
    const api = this.api;
    if (!api) return [];
    const out: Array<{ id: string; name: string; run: () => void }> = [];
    const registry = api.app.commands.commands;
    for (const cmd of Object.values(registry)) {
      if (!cmd.callback) continue;
      out.push({
        id: cmd.id,
        name: `[插件] ${cmd.name ?? cmd.id}`,
        run: () => {
          void cmd.callback?.();
        },
      });
    }
    const openSettings = this.opts?.openPluginSettings;
    if (openSettings) {
      for (const p of this.list()) {
        if (!p.enabled || !p.hasSettings) continue;
        out.push({
          id: `plugin-settings:${p.id}`,
          // 带插件 id 是为了能只用 ASCII 过滤（命令面板搜索）
          name: `[插件] ${p.name} 设置 (${p.id})`,
          run: () => openSettings(p.id),
        });
      }
    }
    return out;
  }

  /** 插件注册的设置页（设置对话框用）。 */
  settingTabsOf(id: string): Array<{ name: string; el: HTMLElement; pluginId: string }> {
    const api = this.api;
    if (!api) return [];
    const plugin = api.registry.get(id);
    if (!plugin) return [];
    const tabs = plugin.getSettingTabs() as Array<{
      containerEl?: HTMLElement;
      contentEl?: HTMLElement;
      display?: () => void;
    }>;
    const out = [];
    for (const tab of tabs) {
      const el = tab.containerEl;
      if (!el) continue;
      // 只清内容区，不能清 containerEl：
      // contentEl 是 containerEl 的子元素（Obsidian 语义），清 containerEl 会把它整个摘下来，
      // 插件随后往这个游离节点里画界面 —— 对话框里就一片空白。
      const body = tab.contentEl ?? el;
      body.replaceChildren();
      if (body !== el && !el.contains(body)) el.appendChild(body);
      // 声明式（1.13）与命令式两条路都在这里，兼容测试 harness 用的是同一个函数。
      const rows = renderSettingTab(tab, body);
      // 判空要看整个 containerEl：插件可能画在 containerEl，也可能画在 contentEl
      const rendered =
        el.childElementCount > (body === el ? 0 : 1) || body.childElementCount > 0;
      if (rows === 0 && !rendered) {
        // 静默空白也要让用户看见，否则会误判成「插件没有设置项」
        const hint = document.createElement("div");
        hint.textContent = "（插件设置页没有渲染出任何配置项）";
        hint.style.cssText = "color:#888;font-size:12px;padding:8px 0";
        body.appendChild(hint);
      }
      out.push({ name: `${plugin.manifest.name} 设置`, el, pluginId: id });
    }
    return out;
  }

  private registerContainer(type: string, el: HTMLElement | null): HTMLElement | null {
    if (el) this.containers.set(type, el);
    return this.containers.get(type) ?? null;
  }

  /** 最近一次「打开文件」通知到的路径（插件视图打开的文件也要算当前文件）。 */
  private activePath: string | null = null;

  /** 视图自己的标题（getDisplayText），停靠面板优先用它。 */
  private viewTitles = new Map<string, string>();

  /** app.getActiveFile() 的兜底：宿主活动文件为空时用这个（插件视图打开的场景）。 */
  activeFileFallback(): string | null {
    return this.activePath;
  }
  private dock: HTMLElement | null = null;
  private dockBody: HTMLElement | null = null;
  private dockTitle: HTMLElement | null = null;
  private viewChange: ((type: string | null) => void) | null = null;

  /** 订阅「当前打开的插件视图」（侧栏面板用它显示状态）。 */
  onViewChange(fn: (type: string | null) => void): () => void {
    this.viewChange = fn;
    return () => {
      if (this.viewChange === fn) this.viewChange = null;
    };
  }

  /**
   * 停靠面板：noteforge 没有 Obsidian 的右侧栏，插件视图统一挂在右侧浮层里。
   * 由运行时自己创建 DOM —— 不依赖 React 是否正好渲染了那个 tab，
   * 之前就是因为容器由侧栏渲染，命令面板里打开视图时拿不到容器。
   */
  private ensureDock(type: string): HTMLElement {
    if (!this.dock || !this.dockBody) {
      const dock = document.createElement("div");
      dock.className = "nf-plugin-dock";
      Object.assign(dock.style, {
        position: "fixed",
        top: "46px",
        right: "0",
        bottom: "22px",
        width: "380px",
        maxWidth: "46vw",
        background: "var(--background-primary, #fff)",
        borderLeft: "1px solid var(--background-modifier-border, #ddd)",
        boxShadow: "-6px 0 24px rgba(0,0,0,.14)",
        zIndex: "9000",
        display: "flex",
        flexDirection: "column",
      } as Partial<CSSStyleDeclaration>);
      const bar = document.createElement("div");
      Object.assign(bar.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 10px",
        borderBottom: "1px solid var(--background-modifier-border, #ddd)",
        font: "12px sans-serif",
      } as Partial<CSSStyleDeclaration>);
      const title = document.createElement("span");
      title.style.flex = "1";
      const close = document.createElement("button");
      close.textContent = "✕";
      close.title = "关闭";
      Object.assign(close.style, { border: "none", background: "transparent", cursor: "pointer", fontSize: "13px", color: "inherit" } as Partial<CSSStyleDeclaration>);
      close.addEventListener("click", () => this.closeView());
      bar.append(title, close);
      const body = document.createElement("div");
      body.style.flex = "1";
      body.style.overflow = "auto";
      body.style.padding = "8px";
      dock.append(bar, body);
      document.body.appendChild(dock);
      this.dock = dock;
      this.dockBody = body;
      this.dockTitle = title;
    }
    if (this.dockTitle) this.dockTitle.textContent = viewTitle(type);
    return this.dockBody;
  }

  closeView(): void {
    const api = this.api;
    const type = this.currentView;
    if (api && type) {
      const leaf = api.workspace.getMostRecentLeaf();
      if (leaf?.view) leaf.view.onunload?.();
    }
    this.dock?.remove();
    this.dock = null;
    this.dockBody = null;
    this.dockTitle = null;
    this.currentView = null;
    this.viewChange?.(null);
  }

  private currentView: string | null = null;

  /**
   * 给某个视图类型返回真实 DOM 容器（同步）。
   * 插件常自己走 `getRightLeaf().setViewState({type})` 这条路（不经过 openView），
   * 所以 WorkspaceLeaf 必须能从宿主这里拿到已挂载的容器，否则视图渲染在游离节点上、
   * 屏幕上什么都看不到。
   */
  containerFor(type: string): HTMLElement {
    const existing = this.containers.get(type);
    if (existing?.isConnected) return existing;
    const body = this.ensureDock(type);
    const el = document.createElement("div");
    el.className = "nf-plugin-view";
    el.dataset.pluginView = type;
    body.replaceChildren(el);
    this.containers.set(type, el);
    return el;
  }

  /**
   * 某个扩展名是否被插件接管（Plugin.registerExtensions）。
   * 宿主打开文件前要先问它，否则 .mdx 这类自定义格式会被当附件/源码打开。
   */
  /** 已被插件接管的扩展名（宿主用它决定文件树/切换器里显示哪些文件）。 */
  registeredExtensions(): string[] {
    return this.api?.workspace.registeredExtensions() ?? [];
  }

  viewTypeForExtension(ext: string): string | null {
    return this.api?.workspace.viewTypeForExtension(ext) ?? null;
  }

  /**
   * 打开一个文件并让插件知道（Obsidian 的 file-open 事件）。
   *
   * 不少插件靠这个事件接管文件打开流程 —— quadrant-chart 就在里面把 .mdx
   * 转成图表视图。宿主不触发，插件的自动打开逻辑就完全不生效。
   */
  notifyFileOpen(path: string): void {
    const api = this.api;
    if (!api) return;
    const file = api.vault.getAbstractFileByPath?.(path);
    if (!file) return;
    this.activePath = path;
    try {
      api.workspace.trigger("file-open", file);
    } catch (e) {
      console.error("[plugin] file-open 监听器抛错", e);
    }
  }

  /** 打开插件视图（把视图 DOM 挂进停靠面板）。state 会传给视图的 setState。 */
  async openView(type: string, state?: Record<string, unknown>): Promise<void> {
    const api = this.api;
    if (!api) return;
    // 宿主若提供了容器（未来做真正的侧栏视图时）优先用它，否则用停靠面板
    const hostContainer = await this.opts?.ensureViewContainer?.(type);
    const el = hostContainer ?? this.ensureDock(type);
    this.registerContainer(type, el);
    const leaf = api.workspace.getLeaf(true);
    leaf.type = type;
    leaf.containerEl = el;
    const factory = api.workspace.getViewFactory(type);
    if (!factory) {
      console.warn(`[plugin] 视图 ${type} 未注册`);
      return;
    }
    try {
      if (state) {
        // 带 state 时走 Obsidian 的正规路径：setViewState 会 setState → onOpen，
        // FileView 子类靠这一步把 state.file 解析成 this.file。
        await leaf.setViewState({ type, active: true, state });
        const v = leaf.view as { app?: unknown; contentElHost?: HTMLElement } | null;
        if (v) {
          v.app = api.app;
          if (v.contentElHost) el.replaceChildren(v.contentElHost);
        }
      } else {
      const view = factory(leaf);
      view.app = api.app;
      leaf.view = view;
      await view.onOpen();
      el.replaceChildren(view.contentElHost);
      }
      api.workspace.revealLeaf(leaf);
      this.currentView = type;
      // 标题用视图自己的 displayText（如「象限图示例」），比"插件视图 · chart"有信息量
      try {
        const label = leaf.getDisplayText?.();
        if (label && label !== type) this.viewTitles.set(type, label);
      } catch {
        /* 视图没实现 getDisplayText 就用兜底标题 */
      }
      if (this.dockTitle) this.dockTitle.textContent = this.viewTitles.get(type) ?? viewTitle(type);
      this.viewChange?.(type);
    } catch (e) {
      el.replaceChildren();
      const pre = document.createElement("pre");
      pre.textContent = `视图打开失败：${e instanceof Error ? e.message : String(e)}`;
      pre.style.color = "#c33";
      pre.style.whiteSpace = "pre-wrap";
      el.appendChild(pre);
      console.error("[plugin] 视图打开失败", e);
    }
  }

  /** 重新扫描并加载（安装/启用/禁用后调用）。 */
  async reload(): Promise<void> {
    if (this.loading) await this.loading;
    this.loading = this.doReload();
    await this.loading;
    this.loading = null;
  }

  private async doReload(): Promise<void> {
    const opts = this.opts;
    if (!opts) return;
    const vaultRoot = opts.vaultPath();

    // 卸载旧插件（含它们的样式）
    await this.api?.unloadAll();
    for (const el of this.styleEls) el.remove();
    this.styleEls = [];
    this.plugins.clear();

    const cm = createCmModules();
    if (!this.api) {
      const host = createTauriHost({
        vaultPath: opts.vaultPath,
        activeFile: opts.activeFile,
        openFile: opts.openFile,
        container: (t) => this.registerContainer(t, null),
      });
      const name = vaultRoot.split("/").filter(Boolean).pop() ?? "vault";
      this.api = createObsidianApi(host, {
        name,
        coreHooks: {
          saveFile: opts.saveFile,
          toggleMode: opts.toggleMode,
          openSettings: opts.openSettings,
        },
        workspaceHooks: {
          activeFile: opts.activeFile,
          openFile: opts.openFile,
          // 插件自己 setViewState 时，WorkspaceLeaf 会来这里要已挂载的容器
          getLeafContainer: (type) => this.containers.get(type)?.isConnected ? this.containers.get(type)! : null,
          editor: () => createEditorAdapter((editorBridge.view as never) ?? null),
          editorFile: () => null,
        },
      });
    } else {
      // 视图仓库跨 vault 复用：容器表要跟着清（停靠面板下次打开时重建）
      this.containers.clear();
      this.dock?.remove();
      this.dock = null;
      this.dockBody = null;
      this.dockTitle = null;
    }
    const api = this.api;
    // vault 查询方法是同步的（Obsidian 语义），索引必须先就绪，
    // 否则插件 onload 里的 getMarkdownFiles() 会拿到空数组还不报错 —— 最难查的一类问题。
    await api.vault.ensure();
    await this.buildIndex(api, vaultRoot);

    let installed: Array<{
      id: string;
      name: string;
      version: string;
      author: string;
      description: string;
      enabled: boolean;
      has_main: boolean;
      bytes: number;
    }> = [];
    try {
      installed = await invoke("list_plugins", { vaultRoot });
    } catch (e) {
      console.warn("[plugin] list_plugins 失败", e);
    }

    const requireMap: Record<string, Record<string, unknown>> = {
      obsidian: api.module,
      electron: {},
      ...cm,
      ...nodeStubs(),
    };

    for (const meta of installed) {
      const summary: PluginSummary = {
        id: meta.id,
        name: meta.name,
        version: meta.version,
        author: meta.author,
        description: meta.description,
        enabled: meta.enabled,
        loaded: false,
        error: null,
        commands: [],
        views: [],
        hasSettings: false,
      };
      this.plugins.set(meta.id, summary);
      if (!meta.enabled) continue;
      if (!meta.has_main) {
        summary.error = "缺少 main.js（安装不完整）";
        continue;
      }
      try {
        summary.loaded = await this.loadOne(meta.id, api, requireMap);
        const plugin = api.registry.get(meta.id);
        if (plugin) {
          summary.commands = plugin.getCommands().map((c) => c.name ?? c.id);
          summary.views = api.workspace.registeredViewTypes();
          summary.hasSettings = plugin.getSettingTabs().length > 0;
        }
      } catch (e) {
        summary.error = e instanceof Error ? e.message : String(e);
      }
    }
    this.notify();
  }

  /**
   * 建元数据索引并灌进 metadataCache。
   *
   * 时机很关键：必须在插件 onload 之前完成 —— 插件常在 onload 里读
   * `metadataCache.getFileCache(f)` / frontmatter，索引没就绪时那些调用
   * 返回 null 而且**不报错**，是最难查的一类问题。
   */
  private async buildIndex(api: ObsidianApi, vaultRoot: string): Promise<void> {
    const paths = api.vault.getFiles().map((f) => f.path);
    const res = await this.index.load(paths, vaultRoot);
    this.indexMs = res.ms;
    if (!res.ok) {
      console.warn("[index] 索引构建失败（Bases 会退化为无属性视图）", res.error);
      return;
    }
    for (const p of paths) {
      const entry = this.index.toCacheEntry(p);
      if (entry) api.metadataCache.setCache(p, entry);
    }
    const issues = this.index.getFrontmatterIssues();
    if (issues.length) {
      console.warn(`[index] ${issues.length} 个文件的 frontmatter 解析失败`, issues.slice(0, 5));
    }
  }

  private async loadOne(id: string, api: ObsidianApi, requireMap: Record<string, Record<string, unknown>>) {
    const dir = `.obsidian/plugins/${id}`;
    const [manifestText, mainCode] = await Promise.all([
      invoke<string>("read_file", { path: `${dir}/manifest.json` }),
      invoke<string>("read_file", { path: `${dir}/main.js` }),
    ]);
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;

    // styles.css 是插件自己的样式（Obsidian 也是直接注入）
    try {
      const css = await invoke<string>("read_file", { path: `${dir}/styles.css` });
      const style = document.createElement("style");
      style.dataset.noteforgePlugin = id;
      style.textContent = css;
      document.head.appendChild(style);
      this.styleEls.push(style);
    } catch {
      /* 没有 styles.css 是正常的 */
    }

    const ev = evaluatePlugin(mainCode, { filename: `${dir}/main.js`, requireMap });
    if (ev.error) throw new Error(`加载失败：${ev.error.message}`);
    const PluginClass = ev.defaultExport as (new (app: unknown, manifest: unknown) => { onload?(): void }) | undefined;
    if (typeof PluginClass !== "function") throw new Error("main.js 没有导出插件类");
    const instance = new PluginClass(api.app, manifest);
    // 用目录名登记：Obsidian 的插件 id 就是目录名，manifest.id 未必一致
    api.registry.add(instance as never, id);
    await instance.onload?.();
    return true;
  }

  /** 首次初始化（打开 vault 时调用）。 */
  async init(opts: RuntimeOptions): Promise<void> {
    this.opts = opts;
    await this.reload();
  }

  dispose(): void {
    void this.api?.unloadAll();
    for (const el of this.styleEls) el.remove();
    this.styleEls = [];
    this.plugins.clear();
    this.api = null;
    this.index = new IndexStore((cmd, args) => invoke(cmd, args));
    this.containers.clear();
    this.dock?.remove();
    this.dock = null;
    this.dockBody = null;
    this.dockTitle = null;
    this.currentView = null;
  }
}

/** node 内建模块的浏览器垫片（与 harness 共用同一份实现，避免行为分叉）。 */
function nodeStubs(): Record<string, Record<string, unknown>> {
  const electron = createElectronStub();
  return { ...withNodePrefixAliases(createNodeBuiltins()), electron, "node:electron": electron };
}

function viewTitle(type: string): string {
  const tail = type.includes("-") ? type.split("-").pop() : type;
  return `插件视图 · ${tail}`;
}

export const obsidianRuntime = new ObsidianRuntime();
export type { PluginRegistry };