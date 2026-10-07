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
    // Obsidian 的顺序是先 setState 再 onOpen。少了 setState 调用，
    // FileView 子类（如 quadrant-chart 的图表视图）拿不到 state.file，
    // 视图.file 永远是 null —— 表现是「视图打开了但没有内容」。
    if (state.state !== undefined && typeof view.setState === "function") {
      await view.setState(state.state, this);
    }
    await view.onOpen();
    // Obsidian 在 onOpen 之后才把文件交给 FileView 并回调 onLoadFile —— 内容加载
    // 都挂在这个钩子上（quadrant-chart 的注释明确写了：onOpen 时 this.file 还是 null，
    // 「在 onOpen 里加载图表会静默无效，画布停在默认空图」）。不调它 = 视图打开了但没内容。
    const viewFile = (view as { file?: unknown; onLoadFile?: (f: unknown) => unknown }).file;
    const onLoadFile = (view as { onLoadFile?: (f: unknown) => unknown }).onLoadFile;
    if (viewFile && typeof onLoadFile === "function") {
      await onLoadFile.call(view, viewFile);
    }
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
  /**
   * 插件通过 `registerExtensions(['mdx'], viewType)` 声明「这个扩展名由我的视图接管」。
   * Obsidian 用它决定点开这类文件时走哪个视图；不实现的话宿主会把 .mdx 之类的文件
   * 当普通附件/源码打开，用户看到的是一坨 YAML 而不是图表。
   */
  private extViews = new Map<string, string>();
  activeEditor: EditorLike | null = null;

  private factories = new Map<string, (leaf: WorkspaceLeaf) => View>();
  private leaves = new Map<string, WorkspaceLeaf[]>();
  private revealed: WorkspaceLeaf | null = null;

  host: Host;
  vault: Vault;
  metadataCache: MetadataCache;

  /**
   * 悬停链接的来源登记（Obsidian 1.10+）。
   *
   * 插件往里写自己的来源名与默认修饰键，悬停链接时 Obsidian 才认得
   * 「这个链接的预览由谁负责」。calendar-bases 在 onload 里第一句就是
   * `this.app.workspace.hoverLinkSources.bases = {...}` —— 没有这个对象，
   * 插件会挂在 "Cannot set properties of undefined (setting 'bases')"。
   */
  hoverLinkSources: Record<string, { display: string; defaultMod: boolean }> = {};

  constructor(host: Host, vault: Vault, metadataCache: MetadataCache, hooks: WorkspaceHooks) {
    super();
    this.host = host;
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.hooks = hooks;
    this.containerEl = document.createElement("div");
    this.containerEl.addClass?.("workspace");
    this.activeEditor = hooks.editor();
    // 分区容器：iconic 等插件用 instanceof 判断视图在主区还是浮动窗
    this.rootSplit = new WorkspaceRoot("root");
    this.leftSplit = new WorkspaceRoot("left");
    this.rightSplit = new WorkspaceRoot("right");
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

  /** 登记「扩展名 → 视图类型」（Plugin.registerExtensions 的落点）。 */
  registerExtension(extension: string, viewType: string): void {
    const ext = String(extension).replace(/^\./, "").toLowerCase();
    if (ext) this.extViews.set(ext, viewType);
  }

  /**
   * 撤销扩展名归属（Plugin.unregisterExtensions）。
   *
   * 插件在 onunload 里会调它把自己接管的扩展名还回来 —— 缺了这个方法，
   * 插件卸载时抛 "unregisterExtensions is not a function"（media-extended）。
   */
  unregisterExtension(extension: string): void {
    const ext = String(extension).replace(/^\./, "").toLowerCase();
    if (ext) this.extViews.delete(ext);
  }

  /** 某个扩展名有没有被插件接管；没有则返回 null。 */
  viewTypeForExtension(extension: string): string | null {
    return this.extViews.get(String(extension).replace(/^\./, "").toLowerCase()) ?? null;
  }

  /** 已被插件接管的扩展名列表（宿主打开文件时先问它）。 */
  registeredExtensions(): string[] {
    return [...this.extViews.keys()];
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

/**
 * 文件视图的继承链（Obsidian）：
 *   ItemView → FileView → EditableFileView → TextFileView / ImageView / PDFView …
 *
 * diagrams（drawio-obsidian）这类插件直接 `extends obsidian.EditableFileView`，
 * 少了这一层会在模块顶层就抛 "The superclass is not a constructor"。
 */
export abstract class FileView extends ItemView {
  file: TFile | null = null;
  navigation = false;
  /** 是否允许在视图中直接编辑 */
  allowEdit = true;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = false;
  }

  /** 该视图能处理的文件扩展名（Obsidian 用它做拖放判定） */
  canAcceptExtension(_extension: string): boolean {
    return false;
  }

  getViewData(): Promise<string> {
    return Promise.resolve("");
  }

  setViewData(_data: string, _clear: boolean): void {}

  getState(): Record<string, unknown> {
    return { file: this.file?.path ?? null };
  }

  async setState(state: unknown, _result: unknown): Promise<void> {
    const path = (state as { file?: string } | null)?.file;
    if (path) this.file = new TFile(path);
  }

  requestSave(): void {}

  /**
   * Obsidian 在视图打开后把文件交给这里（内容加载都挂这个钩子）。
   * 默认空实现；插件覆写它来读文件、渲染内容。
   */
  async onLoadFile(_file: TFile): Promise<void> {}

  /** 文件被换掉/重新加载时的回调（Obsidian 语义）。 */
  async onUnloadFile(_file: TFile): Promise<void> {}

  override getDisplayText(): string {
    return this.file?.basename ?? this.getViewType();
  }
}

export abstract class EditableFileView extends FileView {
  /** 视图当前内容；宿主按需读写磁盘 */
  data = "";
  private saveHandler: ((data: string) => Promise<void>) | null = null;

  override getViewData(): Promise<string> {
    return Promise.resolve(this.data);
  }

  override setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (clear) this.contentEl.empty?.();
  }

  clear(): void {
    this.data = "";
    this.contentEl.empty?.();
  }

  /** 宿主注册保存实现（noteforge 由运行时注入：写回 vault 文件） */
  setSaveHandler(fn: (data: string) => Promise<void>): void {
    this.saveHandler = fn;
  }

  override requestSave(): void {
    void this.saveHandler?.(this.data);
  }

  /** 直接改内容并落盘（Obsidian 的 onSave 语义） */
  async save(data: string): Promise<void> {
    this.data = data;
    await this.saveHandler?.(data);
  }
}

/** 图片 / PDF / 音视频视图：多数插件只需要它们能被继承。 */
export class ImageView extends EditableFileView {
  override getViewType(): string {
    return "image";
  }
  override canAcceptExtension(ext: string): boolean {
    return ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"].includes(ext.toLowerCase());
  }
}

export class PDFView extends EditableFileView {
  override getViewType(): string {
    return "pdf";
  }
  override canAcceptExtension(ext: string): boolean {
    return ext.toLowerCase() === "pdf";
  }
}

export class AudioView extends EditableFileView {
  override getViewType(): string {
    return "audio";
  }
}

export class VideoView extends EditableFileView {
  override getViewType(): string {
    return "video";
  }
}

/**
 * 工作区分区的容器类型。iconic 会用 `getRoot() instanceof WorkspaceRoot/WorkspaceFloating`
 * 判断视图处于主区还是浮动窗 —— instanceof 是硬依赖，类必须真实存在。
 */
export class WorkspaceRoot {
  type: string;
  constructor(type = "root") {
    this.type = type;
  }
}

export class WorkspaceFloating {
  type: string;
  constructor(type = "floating") {
    this.type = type;
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
