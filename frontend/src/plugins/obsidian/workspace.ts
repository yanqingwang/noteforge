/**
 * Workspace / View / ItemView / MarkdownView / MarkdownRenderer。
 *
 * 插件视图（ItemView）需要一个 DOM 挂载点。宿主通过 WorkspaceHooks 注入：
 * 应用内由 noteforge 的侧栏提供容器，测试/harness 用离屏容器。
 */

import { Component, Events, Scope, setIcon } from "./events";
import { TAbstractFile, TFile } from "./items";
import type { EventRef, Host } from "./types";
import type { MetadataCache, Vault } from "./vault";

/** 插件能看到的编辑器最小接口（Obsidian 的 Editor 是 CM6 之上的包装）。 */
export interface EditorLike {
  getValue(): string;
  setValue(v: string): void;
  getLine(n: number): string;
  lineCount(): number;
  getSelection(): string;
  replaceSelection(v: string): void;
  replaceRange(replace: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void;
  getCursor(string?: "from" | "to" | "head" | "anchor"): { line: number; ch: number };
  setCursor(pos: { line: number; ch: number } | { line: number; ch: number }[]): void;
  getScrollInfo(): { top: number; left: number };
  scrollTo(x: number | null, y: number | null): void;
  focus(): void;
  hasFocus(): boolean;
  getDoc?(): unknown;
  /** CM6 句柄（noteforge 注入，插件可用 cm6 扩展 API） */
  cm6?(): unknown;
  refresh?(): void;
}

export interface WorkspaceHooks {
  activeFile(): string | null;
  openFile(path: string, newLeaf?: boolean): Promise<void>;
  /** 取得某个 view type 的挂载容器；返回 null 表示该视图没有宿主位置。 */
  getLeafContainer(type: string): HTMLElement | null;
  /** 宿主当前是否提供 MarkdownView（源码编辑器） */
  editor(): EditorLike | null;
  editorFile(): TFile | null;
  /** 触发宿主刷新编辑器（插件改了活动文件后用） */
  refreshEditor?(): void;
  /** MarkdownView.showSearch() 的宿主实现 */
  onSearchRequest?(replace?: boolean): void;
}

export interface ViewState {
  type: string;
  state?: unknown;
  active?: boolean;
  pinned?: boolean;
  group?: unknown;
}

export abstract class View extends Component {
  app: unknown;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  icon = "";
  navigation = false;
  scope = new Scope();

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    // Obsidian 在视图构造时就给好 app —— 插件的构造器里普遍直接用 this.app
    // （calendar 就因此在 harness 里报 "reading 'workspace'"）。
    this.app = leaf.workspace.app ?? null;
    this.containerEl = document.createElement("div");
    this.containerEl.addClass?.("view");
    this.contentEl = this.containerEl;
  }

  getViewType(): string {
    return "view";
  }

  getDisplayText(): string {
    return this.getViewType();
  }

  getIcon(): string {
    return this.icon;
  }

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: unknown): Promise<void> {}

  onOpen(): Promise<void> {
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    return Promise.resolve();
  }

  getEphemeralState(): Record<string, unknown> {
    return {};
  }

  setEphemeralState(_s: unknown): void {}

  /** 宿主侧用于挂载的容器（ItemView 会覆写为 contentEl）。 */
  get contentElHost(): HTMLElement {
    return this.containerEl;
  }
}

export abstract class ItemView extends View {
  contentEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl = document.createElement("div");
    this.contentEl.addClass?.("view-content");
    this.containerEl.appendChild(this.contentEl);
    this.navigation = false;
  }

  /** ItemView 的语义：叶子容器即内容容器（Obsidian 里两者同一元素）。 */
  get contentElHost(): HTMLElement {
    return this.contentEl;
  }

  addAction(icon: string, title: string, cb: (evt: MouseEvent) => unknown): HTMLElement {
    const btn = document.createElement("a");
    btn.addClass?.("clickable-icon");
    btn.setAttribute("aria-label", title);
    btn.title = title;
    setIcon(btn, icon);
    btn.onClickEvent?.(cb as EventListener);
    return btn;
  }
}

export class WorkspaceLeaf {
  view: View | null = null;
  containerEl: HTMLElement;
  private state: ViewState | null = null;

  workspace: Workspace;
  type: string;

  constructor(workspace: Workspace, type: string, containerEl?: HTMLElement) {
    this.workspace = workspace;
    this.type = type;
    this.containerEl = containerEl ?? document.createElement("div");
  }

  getViewState(): ViewState {
    return this.state ?? { type: this.type };
  }

  async setViewState(state: ViewState, _ctx?: unknown): Promise<void> {
    this.state = state;
    this.type = state.type;
    const factory = this.workspace.getViewFactory(state.type);
    if (!factory) return;
    // 视图类型此时才确定，向宿主要一个已挂载的容器：
    // 插件通常自己走 getRightLeaf().setViewState()，容器必须来自宿主才有意义。
    const hostEl = this.workspace.hooks.getLeafContainer(this.type);
    if (hostEl && hostEl !== this.containerEl) {
      this.containerEl = hostEl;
      hostEl.replaceChildren();
    }
    const view = factory(this);
    this.view = view;
    await view.onOpen();
    if (this.containerEl && !view.containerEl.isConnected) {
      this.containerEl.appendChild(view.containerEl);
    }
  }

  getDisplayText(): string {
    return this.view?.getDisplayText() ?? this.type;
  }

  async openFile(file: TFile, state?: unknown): Promise<void> {
    await this.workspace.hooks.openFile(file.path);
    if (state) await this.view?.setState(state, this);
  }

  detach(): void {
    this.view?.onunload();
    this.view = null;
    this.workspace.dropLeaf(this);
  }

  setEphemeralState(_s: unknown): void {}
}

export class Workspace extends Events {
  /** 宿主 app（视图构造器要用） */
  app: unknown = null;
  hooks: WorkspaceHooks;
  containerEl: HTMLElement;
  leftSplit: unknown;
  rightSplit: unknown;
  rootSplit: unknown;
  activeEditor: EditorLike | null = null;

  private factories = new Map<string, (leaf: WorkspaceLeaf) => View>();
  private leaves = new Map<string, WorkspaceLeaf[]>();
  private revealed: WorkspaceLeaf | null = null;

  host: Host;
  vault: Vault;
  metadataCache: MetadataCache;

  constructor(host: Host, vault: Vault, metadataCache: MetadataCache, hooks: WorkspaceHooks) {
    super();
    this.host = host;
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.hooks = hooks;
    this.containerEl = document.createElement("div");
    this.containerEl.addClass?.("workspace");
    this.activeEditor = hooks.editor();
  }

  /** MarkdownRenderer 需要拿到宿主才能渲染 markdown。 */
  getHost(): Host {
    return this.host;
  }

  getViewFactory(type: string): ((leaf: WorkspaceLeaf) => View) | undefined {
    return this.factories.get(type);
  }

  /** 已注册的视图类型（宿主用它决定给哪些视图准备容器）。 */
  registeredViewTypes(): string[] {
    return [...this.factories.keys()];
  }

  /** 宿主/插件注册视图工厂（插件的 registerView 会走到这里）。 */
  registerView(type: string, factory: (leaf: WorkspaceLeaf) => View): void {
    this.factories.set(type, factory);
  }

  unregisterView(type: string): void {
    this.factories.delete(type);
    for (const leaf of this.leaves.get(type) ?? []) {
      leaf.view?.onunload();
      leaf.view = null;
    }
    this.leaves.delete(type);
  }

  /** 供 Plugin.registerView 使用。 */
  registerViewEager(type: string): void {
    this.factories.set(type, () => {
      throw new Error(`视图 ${type} 未注册工厂`);
    });
  }

  private makeLeaf(type: string, container?: HTMLElement): WorkspaceLeaf {
    const hostEl = this.hooks.getLeafContainer(type);
    const leaf = new WorkspaceLeaf(this, type, container ?? hostEl ?? undefined);
    const arr = this.leaves.get(type) ?? [];
    arr.push(leaf);
    this.leaves.set(type, arr);
    this.trigger("leaf-change" as never, leaf as never);
    return leaf;
  }

  dropLeaf(leaf: WorkspaceLeaf): void {
    const arr = this.leaves.get(leaf.type);
    if (!arr) return;
    const i = arr.indexOf(leaf);
    if (i >= 0) arr.splice(i, 1);
    this.trigger("leaf-change" as never, leaf as never);
  }

  getLeaf(newLeaf?: boolean | "split" | "tab"): WorkspaceLeaf {
    const last = this.getMostRecentLeaf();
    if (last && !newLeaf) return last;
    return this.makeLeaf("empty");
  }

  getRightLeaf(_split: boolean): WorkspaceLeaf {
    const leaf = this.makeLeaf("empty");
    this.revealLeaf(leaf);
    return leaf;
  }

  getLeftLeaf(_split: boolean): WorkspaceLeaf {
    const leaf = this.makeLeaf("empty");
    this.revealLeaf(leaf);
    return leaf;
  }

  async getLeafById(_id: string): Promise<WorkspaceLeaf | null> {
    return this.getMostRecentLeaf();
  }

  getMostRecentLeaf(): WorkspaceLeaf | null {
    return this.revealed ?? null;
  }

  getActiveViewOfType<T extends View>(type: string): T | null {
    const leaf = this.revealed;
    if (!leaf || leaf.type !== type) return null;
    return leaf.view as T | null;
  }

  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return [...(this.leaves.get(type) ?? [])];
  }

  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    for (const arr of this.leaves.values()) for (const leaf of [...arr]) cb(leaf);
  }

  iterateRootLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    this.iterateAllLeaves(cb);
  }

  revealLeaf(leaf: WorkspaceLeaf): void {
    this.revealed = leaf;
    // 把视图 DOM 放进宿主容器
    const host = this.hooks.getLeafContainer(leaf.type);
    if (host && leaf.view) {
      if (leaf.view.containerEl.parentNode !== host) {
        host.appendChild(leaf.view.containerEl);
      }
    }
    this.trigger("active-leaf-change" as never, leaf as never);
  }

  setActiveLeaf(leaf: WorkspaceLeaf, _params?: unknown): void {
    this.revealLeaf(leaf);
  }

  detachLeavesOfType(type: string): void {
    for (const leaf of this.getLeavesOfType(type)) leaf.detach();
  }

  getActiveFile(): TFile | null {
    const p = this.hooks.activeFile();
    return p ? (new TFile(p)) : null;
  }

  getActiveView(): View | null {
    return this.revealed?.view ?? null;
  }

  getLastOpenFiles(): string[] {
    return this.hooks.activeFile() ? [this.hooks.activeFile() as string] : [];
  }

  async openLinkText(linktext: string, sourcePath: string, _newLeaf?: boolean): Promise<void> {
    const dest = await this.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    if (dest) await this.hooks.openFile(dest.path);
  }

  openFile(file: TFile): Promise<void> {
    return this.hooks.openFile(file.path);
  }

  onLayoutReady(cb: () => unknown): void {
    void cb();
  }

  /** 宿主通知：活动文件变化。 */
  notifyActiveFileChanged(): void {
    this.activeEditor = this.hooks.editor();
    const f = this.getActiveFile();
    this.trigger("file-open" as never, f as never);
    this.trigger("active-leaf-change" as never, this.revealed as never);
  }

  /** 宿主通知：编辑器内容被保存。 */
  notifyEditorChanged(): void {
    this.trigger("editor-change" as never, this.activeEditor as never);
  }

  async setActiveView(_leaf: unknown, _state: unknown): Promise<void> {}

  /* ---- 布局 / 选项：Obsidian 里有但 shim 用不到语义的方法，给出最小可用行为 ---- */

  updateOptions(): void {
    // 编辑器选项（拼写检查、自动配对等）——noteforge 由自己的设置控制，这里只发事件
    this.trigger("options-change" as never);
  }

  requestSaveFrontMatter(): void {}

  splitActiveLeaf(): WorkspaceLeaf {
    return this.getLeaf(true);
  }

  getRootSplit(): WorkspaceLeaf {
    return this.getLeaf();
  }

  setRootSplit(_leaf: WorkspaceLeaf): void {}

  setLeftSplit(_split: string): void {}

  setRightSplit(_split: string): void {}

  createLeafInParent(_leaf: WorkspaceLeaf, _e?: unknown): WorkspaceLeaf {
    return this.getLeaf(true);
  }

  getGroupLeaves(group: string): WorkspaceLeaf[] {
    return this.getLeavesOfType(group);
  }

  duplicateLeaf(_leaf: WorkspaceLeaf): WorkspaceLeaf {
    return this.getLeaf(true);
  }

  pinLeaf(_leaf: WorkspaceLeaf): void {}

  unpinLeaf(_leaf: WorkspaceLeaf): void {}

  setPinned(_leaf: WorkspaceLeaf, _pinned: boolean): void {}

  centerLeaf(_leaf: WorkspaceLeaf): void {
    this.revealLeaf(_leaf);
  }

  /** hover 预览来源（full-calendar 等在 onload 里注册） */
  registerHoverLinkSource(_id: string, _info: unknown): void {}

  /** 旧名兼容 */
  registerDomEvent(): void {}

  onActiveLeafChange(cb: () => void): EventRef {
    return this.on("active-leaf-change" as never, cb as (...args: unknown[]) => void);
  }

  onLayoutChange(cb: () => void): EventRef {
    return this.on("layout-change" as never, cb as (...args: unknown[]) => void);
  }

}

/** MarkdownView：把宿主编辑器包装成 Obsidian 的 Editor 视图。 */
export class MarkdownView extends ItemView {
  file: TFile | null = null;
  editor: EditorLike;
  currentMode = "source";
  previewMode = "source";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = true;
    this.editor = {
      getValue: () => "",
      setValue: () => undefined,
      getLine: () => "",
      lineCount: () => 0,
      getSelection: () => "",
      replaceSelection: () => undefined,
      replaceRange: () => undefined,
      getCursor: () => ({ line: 0, ch: 0 }),
      setCursor: () => undefined,
      getScrollInfo: () => ({ top: 0, left: 0 }),
      scrollTo: () => undefined,
      focus: () => undefined,
      hasFocus: () => false,
    };
  }

  override getViewType(): string {
    return "markdown";
  }

  override getDisplayText(): string {
    return this.file?.basename ?? "未命名";
  }

  override async onOpen(): Promise<void> {
    const hookEditor = this.leaf.workspace.hooks.editor();
    if (hookEditor) this.editor = hookEditor;
    const p = this.leaf.workspace.hooks.activeFile();
    if (p) this.file = new TFile(p);
  }

  getMode(): "source" | "preview" {
    return this.currentMode === "preview" ? "preview" : "source";
  }

  showSearch(replace?: boolean): void {
    this.leaf.workspace.hooks.onSearchRequest?.(replace);
  }
}

/** MarkdownRenderer：markdown → HTML。渲染实现由宿主注入（应用内走 comrak）。 */
export const MarkdownRenderer = {
  async render(
    app: unknown,
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    _component: unknown,
  ): Promise<void> {
    const ws = (app as { workspace?: Workspace }).workspace;
    const host = ws?.getHost?.();
    let html: string;
    if (host?.renderMarkdown) {
      html = await host.renderMarkdown(markdown, sourcePath);
    } else {
      html = fallbackRender(markdown);
    }
    el.innerHTML = html;
  },
  async renderMarkdown(
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    component: unknown,
  ): Promise<void> {
    await MarkdownRenderer.render(null, markdown, el, sourcePath, component);
  },
};

/** 无渲染宿主时的兜底（harness/单测）：够用的极简 markdown。 */
export function fallbackRender(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, "");
    if (/^```/.test(line)) {
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`);
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(esc(li[1]))}</li>`);
      continue;
    }
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (!line.trim()) continue;
    out.push(`<p>${inline(esc(line))}</p>`);
  }
  if (inList) out.push("</ul>");
  if (inCode) out.push("</code></pre>");
  return out.join("");
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1");
}

export type { TAbstractFile };
