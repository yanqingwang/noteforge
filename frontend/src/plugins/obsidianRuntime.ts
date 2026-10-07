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
import { createObsidianApi, type ObsidianApi, type PluginRegistry } from "./obsidian/index";
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

  list(): PluginSummary[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): PluginSummary | undefined {
    return this.plugins.get(id);
  }

  /** 宿主命令（CommandPalette 用），id 形如 `vault-agent:open-chat`。 */
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
    return out;
  }

  /** 插件注册的设置页（设置对话框用）。 */
  settingTabsOf(id: string): Array<{ name: string; el: HTMLElement; pluginId: string }> {
    const api = this.api;
    if (!api) return [];
    const plugin = api.registry.get(id);
    if (!plugin) return [];
    const tabs = plugin.getSettingTabs() as Array<{ containerEl?: HTMLElement; display?: () => void }>;
    const out = [];
    for (const tab of tabs) {
      const el = tab.containerEl;
      if (!el) continue;
      el.replaceChildren();
      try {
        tab.display?.();
      } catch (e) {
        const pre = document.createElement("pre");
        pre.textContent = `设置页渲染失败：${e instanceof Error ? e.message : String(e)}`;
        pre.style.color = "#c00";
        el.appendChild(pre);
      }
      out.push({ name: `${plugin.manifest.name} 设置`, el, pluginId: id });
    }
    return out;
  }

  private registerContainer(type: string, el: HTMLElement | null): HTMLElement | null {
    if (el) this.containers.set(type, el);
    return this.containers.get(type) ?? null;
  }

  /** 打开插件视图（宿主把视图 DOM 挂进容器）。 */
  async openView(type: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    const el = await this.opts?.ensureViewContainer(type);
    if (!el) {
      console.warn(`[plugin] 视图 ${type} 没有可用容器`);
      return;
    }
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
      const view = factory(leaf);
      view.app = api.app;
      leaf.view = view;
      await view.onOpen();
      el.replaceChildren(view.contentElHost);
      api.workspace.revealLeaf(leaf);
    } catch (e) {
      el.textContent = `视图打开失败：${e instanceof Error ? e.message : String(e)}`;
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
          getLeafContainer: (type) => this.registerContainer(type, null),
          editor: () => createEditorAdapter((editorBridge.view as never) ?? null),
          editorFile: () => null,
        },
      });
    } else {
      // 视图仓库跨 vault 复用：容器表也要跟着清
      this.containers.clear();
    }
    const api = this.api;
    // vault 查询方法是同步的（Obsidian 语义），索引必须先就绪，
    // 否则插件 onload 里的 getMarkdownFiles() 会拿到空数组还不报错 —— 最难查的一类问题。
    await api.vault.ensure();

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
    api.registry.add(instance as never);
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
    this.containers.clear();
  }
}

/** node 内建模块的浏览器垫片（与 harness 共用同一份实现，避免行为分叉）。 */
function nodeStubs(): Record<string, Record<string, unknown>> {
  const electron = createElectronStub();
  return { ...withNodePrefixAliases(createNodeBuiltins()), electron, "node:electron": electron };
}

export const obsidianRuntime = new ObsidianRuntime();
export type { PluginRegistry };