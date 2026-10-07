/**
 * 插件 UI 组件：Notice / Modal / SuggestModal / Menu / Setting 组件族。
 *
 * Setting 组件族是插件设置页的通用骨架（Obsidian 内核提供），插件自己不再实现。
 * 语义要点：SettingBuilder.add* 返回 Setting，链式调用 setName/setDesc/onChange，
 * 且 add* 的顺序决定渲染顺序 —— 大量插件依赖这一点。
 */

import { Component, debounce, escapeHtml, Platform, setIcon } from "./events";

/* ---------- Notice ---------- */

const NOTICE_CSS = `
.nf-notice-container{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:9999;pointer-events:none}
.nf-notice{background:var(--background-secondary,#333);color:var(--text-normal,#eee);padding:8px 12px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.28);font-size:13px;max-width:360px;pointer-events:auto}
`;

function noticeRoot(): HTMLElement {
  const id = "nf-notice-root";
  let root = document.getElementById(id);
  if (!root) {
    const style = document.createElement("style");
    style.textContent = NOTICE_CSS;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = id;
    root.className = "nf-notice-container";
    document.body.appendChild(root);
  }
  return root;
}

export class Notice {
  noticeEl: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  message: string | DocumentFragment;
  timeout?: number;

  constructor(message: string | DocumentFragment, timeout?: number) {
    this.message = message;
    this.timeout = timeout;
    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "nf-notice";
    if (typeof message === "string") this.noticeEl.textContent = message;
    else this.noticeEl.appendChild(message);
    noticeRoot().appendChild(this.noticeEl);
    if (timeout !== 0) {
      const ms = timeout ?? (typeof message === "string" && message.length > 200 ? 10000 : 4000);
      this.timer = setTimeout(() => this.hide(), ms);
    }
  }

  setMessage(message: string | DocumentFragment): this {
    if (typeof message === "string") this.noticeEl.textContent = message;
    else {
      this.noticeEl.textContent = "";
      this.noticeEl.appendChild(message);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), 4000);
    return this;
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.noticeEl.remove();
  }
}

/* ---------- Modal ---------- */

const MODAL_CSS = `
.nf-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:10000}
.nf-modal{background:var(--background-primary,#fff);border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.35);min-width:320px;max-width:min(90vw,640px);max-height:85vh;display:flex;flex-direction:column}
.nf-modal-title{font-size:15px;font-weight:600;padding:12px 16px;border-bottom:1px solid var(--background-modifier-border,#8883)}
.nf-modal-close{position:absolute;top:8px;right:10px;cursor:pointer;color:var(--text-muted,#888);font-size:16px;line-height:1;background:none;border:none}
.nf-modal-content{padding:12px 16px;overflow:auto}
.nf-modal-buttons{display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--background-modifier-border,#8883)}
.nf-modal button{font:inherit;padding:5px 14px;border-radius:6px;border:1px solid var(--background-modifier-border,#8883);background:var(--background-secondary,#eee);color:inherit;cursor:pointer}
.nf-modal button.mod-cta{background:var(--interactive-accent,#4a7dd6);border-color:transparent;color:#fff}
`;

function ensureModalCss(): void {
  if (document.getElementById("nf-modal-css")) return;
  const style = document.createElement("style");
  style.id = "nf-modal-css";
  style.textContent = MODAL_CSS;
  document.head.appendChild(style);
}

export abstract class Modal {
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  buttonEl: HTMLElement;
  scope: unknown = null;
  shouldRestoreSelection = false;
  app: unknown;

  constructor(app: unknown) {
    this.app = app;
    ensureModalCss();
    this.containerEl = document.createElement("div");
    this.containerEl.className = "nf-modal-backdrop";
    this.modalEl = document.createElement("div");
    this.modalEl.className = "nf-modal";
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
    this.titleEl = document.createElement("div");
    this.titleEl.className = "nf-modal-title";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "nf-modal-content";
    this.buttonEl = document.createElement("div");
    this.buttonEl.className = "nf-modal-buttons";
    const close = document.createElement("button");
    close.className = "nf-modal-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.onClickEvent?.(() => this.close());
    this.modalEl.append(close, this.titleEl, this.contentEl, this.buttonEl);
    this.containerEl.appendChild(this.modalEl);
    this.containerEl.addEventListener("mousedown", (e) => {
      if (e.target === this.containerEl) this.close();
    });
  }

  open(): void {
    document.body.appendChild(this.containerEl);
    this.onOpen();
    const first = this.contentEl.querySelector<HTMLElement>("input,textarea,button");
    first?.focus();
  }

  close(): void {
    this.contentEl.empty?.();
    this.containerEl.remove();
    this.onClose();
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  onOpen(): void {}
  onClose(): void {}

  /** 三个常用按钮：确定性操作（OK）用 mod-cta。 */
  addButton(cb?: (evt: MouseEvent) => unknown): HTMLButtonElement {
    let btn: HTMLButtonElement | undefined;
    try {
      btn = this.buttonEl.createEl?.("button", { text: "" }) as HTMLButtonElement | undefined;
    } catch {
      btn = undefined;
    }
    if (!btn) {
      btn = document.createElement("button");
      this.buttonEl.appendChild(btn);
    }
    if (cb) btn.onClickEvent?.(cb as EventListener);
    return btn;
  }
}

export class SuggestModal<T> extends Modal {
  inputEl: HTMLInputElement;
  resultContainerEl: HTMLElement;
  suggestApp: unknown;
  private emptyStateEl: HTMLElement | null = null;
  limit = 50;

  constructor(app: unknown) {
    super(app);
    this.suggestApp = app;
    this.titleEl.style.display = "none";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "nf-suggest-input";
    input.style.width = "100%";
    input.style.padding = "8px 10px";
    input.style.font = "inherit";
    input.style.boxSizing = "border-box";
    input.addEventListener("input", () => {
      this.onInputChanged();
    });
    this.resultContainerEl = document.createElement("div");
    this.resultContainerEl.className = "nf-suggest-results";
    this.resultContainerEl.style.maxHeight = "50vh";
    this.resultContainerEl.style.overflow = "auto";
    this.contentEl.append(input, this.resultContainerEl);
    this.inputEl = input;
  }

  setPlaceholder(text: string): void {
    this.inputEl.placeholder = text;
  }

  setInstructions(_instructions: unknown[]): void {}

  onNoSuggestion(): void {
    if (!this.emptyStateEl) {
      this.emptyStateEl = document.createElement("div");
      this.emptyStateEl.className = "nf-suggest-empty";
      this.emptyStateEl.style.opacity = "0.6";
      this.emptyStateEl.style.padding = "10px 2px";
    }
    this.resultContainerEl.replaceChildren(this.emptyStateEl);
  }

  renderSuggestion(_match: { query: string }, _el: HTMLElement): void {}

  selectSuggestion(_value: T, _evt: unknown): void {}

  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }

  onChooseSuggestion(_item: T, _evt: unknown): void {}

  private onInputChanged(): void {
    const query = this.inputEl.value;
    const results = this.getSuggestions(query) ?? [];
    void Promise.resolve(results).then((items) => {
      if (query !== this.inputEl.value) return; // 输入又变了，丢弃这次结果
      this.resultContainerEl.replaceChildren();
      const list = items.slice(0, this.limit);
      if (!list.length) {
        this.onNoSuggestion();
        return;
      }
      for (const item of list) {
        const row = document.createElement("div");
        row.className = "nf-suggest-item";
        row.style.padding = "6px 8px";
        row.style.cursor = "pointer";
        row.style.borderRadius = "4px";
        this.renderSuggestion({ query }, row);
        row.addEventListener("click", () => {
          const evt = new MouseEvent("click");
          this.selectSuggestion(item, evt);
          this.onChooseSuggestion(item, evt);
          this.close();
        });
        this.resultContainerEl.appendChild(row);
      }
    });
  }
}

export class FuzzySuggestModal<T> extends SuggestModal<T> {
  renderSuggestion(match: { query: string }, el: HTMLElement): void {
    el.textContent = typeof this.getItemText === "function" ? String(this.getItemText(match as unknown as T)) : "";
  }

  getItemText(_item: T): string {
    return "";
  }

  getItemDescription(_item: T): string {
    return "";
  }

  onChooseItem(_item: T, _evt: unknown): void {}
}

const SUGGEST_CSS = `
.nf-input-suggest{position:fixed;z-index:10002;min-width:220px;max-height:260px;overflow:auto;background:var(--background-primary,#fff);
border:1px solid var(--background-modifier-border,#8883);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.24);padding:4px;display:none}
.nf-input-suggest.is-open{display:block}
.nf-input-suggest-item{padding:5px 9px;border-radius:4px;cursor:pointer}
.nf-input-suggest-item.is-selected{background:var(--background-modifier-hover,#0001)}
.nf-input-suggest-msg{padding:6px 9px;opacity:.65;font-size:12px}
`;

/**
 * 输入框补全基类（编辑器外也能用，如命令行面板）。
 * 插件普遍在构造函数里往 messageEl / containerEl 上挂 DOM，
 * 所以这里必须真的建出这套结构，不能只当类型占位。
 */
export abstract class AbstractInputSuggest<T> {
  limit = 100;
  app: unknown;
  inputEl: HTMLInputElement;
  containerEl: HTMLElement;
  messageEl: HTMLElement;
  suggestionItems: T[] = [];
  currentSuggestionIndex = 0;

  constructor(app: unknown, inputEl: HTMLInputElement) {
    if (!document.getElementById("nf-input-suggest-css")) {
      const style = document.createElement("style");
      style.id = "nf-input-suggest-css";
      style.textContent = SUGGEST_CSS;
      document.head.appendChild(style);
    }
    this.app = app;
    this.inputEl = inputEl;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "nf-input-suggest";
    this.messageEl = document.createElement("div");
    this.messageEl.className = "nf-input-suggest-msg";
    this.containerEl.appendChild(this.messageEl);
    document.body.appendChild(this.containerEl);
    inputEl.addEventListener("input", () => this.setValue(inputEl.value));
    inputEl.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  /** 设置查询值并刷新列表（Obsidian 的标准入口）。 */
  setValue(value: string): void {
    this.inputEl.value = value;
    const result = this.getSuggestions(value);
    void Promise.resolve(result).then((items) => this.renderList(items ?? [], value));
  }

  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }

  renderSuggestion(_value: T, _el: HTMLElement): void {}

  selectSuggestion(_value: T, _evt: unknown): void {}

  onChooseSuggestion(_item: T, _evt: unknown): void {}

  onNoSuggestion(): void {
    this.messageEl.textContent = "没有匹配项";
    this.messageEl.style.display = "";
  }

  open(): void {
    this.containerEl.classList.add("is-open");
    const r = this.inputEl.getBoundingClientRect();
    this.containerEl.style.left = `${r.left}px`;
    this.containerEl.style.top = `${r.bottom + 2}px`;
  }

  close(): void {
    this.containerEl.classList.remove("is-open");
    this.suggestionItems = [];
  }

  private renderList(items: T[], query: string): void {
    this.suggestionItems = items.slice(0, this.limit);
    this.containerEl.replaceChildren();
    if (!this.suggestionItems.length) {
      this.onNoSuggestion();
      return;
    }
    this.messageEl.style.display = "none";
    this.suggestionItems.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = `nf-input-suggest-item${i === this.currentSuggestionIndex ? " is-selected" : ""}`;
      this.renderSuggestion(item, row);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.selectSuggestion(item, e);
        this.onChooseSuggestion(item, e);
        this.close();
      });
      this.containerEl.appendChild(row);
    });
    void query;
    this.open();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      this.close();
      return;
    }
    if (!this.suggestionItems.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      this.currentSuggestionIndex =
        (this.currentSuggestionIndex + delta + this.suggestionItems.length) % this.suggestionItems.length;
      this.renderList(this.suggestionItems, this.inputEl.value);
      return;
    }
    if (e.key === "Enter") {
      const item = this.suggestionItems[this.currentSuggestionIndex];
      if (item !== undefined) {
        e.preventDefault();
        this.selectSuggestion(item, e);
        this.onChooseSuggestion(item, e);
        this.close();
      }
    }
  }
}

/* ---------- Menu ---------- */

export class MenuItem {
  el: HTMLElement | null = null;
  disabled = false;
  title = "";
  icon = "";
  callback?: (evt: Event) => unknown;

  constructor(callback?: (evt: Event) => unknown) {
    this.callback = callback;
  }

  setTitle(t: string): this {
    this.title = t;
    if (this.el) this.el.textContent = t;
    return this;
  }

  setIcon(i: string): this {
    this.icon = i;
    if (this.el) setIcon(this.el, i);
    return this;
  }

  setDisabled(d: boolean): this {
    this.disabled = d;
    if (this.el) this.el.toggleAttribute?.("aria-disabled", d);
    return this;
  }

  setIsLabel(_isLabel: boolean): this {
    return this;
  }

  setSection(_s: string): this {
    return this;
  }

  onClick(cb: (evt: Event) => unknown): this {
    this.callback = cb;
    return this;
  }
}

export class Menu {
  items: MenuItem[] = [];
  private el: HTMLElement | null = null;
  menuApp: unknown;

  constructor(app?: unknown) {
    this.menuApp = app;
  }

  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): this {
    return this;
  }

  showAtMouseEvent(_evt: MouseEvent): this {
    this.showAtPosition(0, 0);
    return this;
  }

  showAtPosition(x: number, y: number): this {
    this.close();
    const el = document.createElement("div");
    el.className = "nf-menu";
    el.setAttribute("role", "menu");
    Object.assign(el.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      minWidth: "180px",
      background: "var(--background-primary,#fff)",
      border: "1px solid var(--background-modifier-border,#8883)",
      borderRadius: "6px",
      boxShadow: "0 8px 28px rgba(0,0,0,.28)",
      padding: "4px",
      zIndex: "10001",
    } as Partial<CSSStyleDeclaration>);
    for (const item of this.items) {
      const row = document.createElement("div");
      row.className = "nf-menu-item";
      row.textContent = item.title;
      row.setAttribute("role", "menuitem");
      Object.assign(row.style, { padding: "5px 10px", cursor: item.disabled ? "default" : "pointer", opacity: item.disabled ? "0.5" : "1" } as Partial<CSSStyleDeclaration>);
      if (!item.disabled) {
        row.addEventListener("click", (e) => {
          item.callback?.(e);
          this.close();
        });
      }
      el.appendChild(row);
    }
    document.body.appendChild(el);
    this.el = el;
    return this;
  }

  hide(): this {
    this.close();
    return this;
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }
}

/* ---------- 悬浮提示 ---------- */

/**
 * displayTooltip(el, content, opts?)：在元素旁显示一段提示。
 * 插件的 ExtraButtonComponent.displayTooltip() 会转调它，所以必须是模块级导出。
 */
export function displayTooltip(el: HTMLElement, content: string | HTMLElement, opts?: { placement?: string }): void {
  if (!el) return;
  const host = el.parentElement ?? el;
  let tip = host.querySelector<HTMLElement>(":scope > .nf-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "nf-tooltip";
    Object.assign(tip.style, {
      position: "absolute",
      zIndex: "10003",
      padding: "4px 8px",
      borderRadius: "4px",
      background: "var(--background-modifier-message, #333)",
      color: "var(--text-on-accent, #fff)",
      font: "12px sans-serif",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    } as Partial<CSSStyleDeclaration>);
    host.appendChild(tip);
  }
  if (typeof content === "string") tip.textContent = content;
  else tip.replaceChildren(content);
  const r = el.getBoundingClientRect();
  tip.style.left = `${r.left}px`;
  tip.style.top = `${opts?.placement === "bottom" ? r.bottom + 4 : r.top - 26}px`;
}

export function hideTooltip(el: HTMLElement): void {
  (el.parentElement ?? el).querySelector(":scope > .nf-tooltip")?.remove();
}

/* ---------- Setting 组件族 ---------- */

export abstract class BaseComponent {
  disabled = false;
  containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
  }

  then(cb: (c: this) => unknown): this {
    cb(this);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    // 必须真正禁用底层控件：只置一个 flag 的话输入框照样能打字，
    // 用户和插件都会以为这一行是锁定的（声明式设置里的 disabled 行就是这么来的）。
    const self = this as unknown as { inputEl?: HTMLInputElement; buttonEl?: HTMLButtonElement };
    const el = self.inputEl ?? self.buttonEl;
    if (el) el.disabled = disabled;
    if (disabled) this.containerEl?.setAttribute("aria-disabled", "true");
    else this.containerEl?.removeAttribute("aria-disabled");
    return this;
  }

  /** Obsidian 里所有设置组件都继承 onClick（很多插件直接 new ButtonComponent().onClick()）。 */
  onClick(cb: (evt: MouseEvent) => unknown): this {
    this.containerEl.addEventListener("click", cb as EventListener);
    return this;
  }

  onBlur(cb: () => unknown): this {
    this.containerEl.addEventListener("blur", cb as EventListener);
    return this;
  }

  /** 新版 Obsidian 的所有设置组件都有 setTooltip。 */
  setTooltip(tooltip: string): this {
    this.containerEl.title = tooltip;
    return this;
  }

  /** 兼容插件自定义的 tooltip 组件用法。 */
  setTooltipComponent(): this {
    return this;
  }
}

export class ValueComponent<T> extends BaseComponent {
  protected value: T;
  protected changeHandler: (v: T) => unknown = () => undefined;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.value = this.getInitialValue() as T;
  }

  getInitialValue(): T {
    return "" as unknown as T;
  }

  getValue(): T {
    return this.value;
  }

  setValue(v: T): this {
    this.value = v;
    return this;
  }

  onChange(cb: (v: T) => unknown): this {
    this.changeHandler = cb;
    return this;
  }

  /** 由宿主的 input 元素回填。 */
  protected commit(v: T): void {
    this.value = v;
    this.changeHandler(v);
  }
}

export class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.style.width = "100%";
    this.inputEl.style.font = "inherit";
    this.inputEl.style.padding = "4px 8px";
    this.inputEl.style.boxSizing = "border-box";
    this.inputEl.addEventListener("input", () => this.commit(this.inputEl.value));
    this.inputEl.value = this.value;
    containerEl.appendChild(this.inputEl);
  }

  getInitialValue(): string {
    return "";
  }

  setValue(v: string): this {
    this.value = v;
    this.inputEl.value = v;
    return this;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
}

export class TextAreaComponent extends ValueComponent<string> {
  inputEl: HTMLTextAreaElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.inputEl = document.createElement("textarea");
    this.inputEl.style.width = "100%";
    this.inputEl.style.minHeight = "80px";
    this.inputEl.style.font = "inherit";
    this.inputEl.addEventListener("input", () => this.commit(this.inputEl.value));
    containerEl.appendChild(this.inputEl);
  }

  getInitialValue(): string {
    return "";
  }

  setValue(v: string): this {
    this.value = v;
    this.inputEl.value = v;
    return this;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.toggleEl = document.createElement("input");
    this.toggleEl.type = "checkbox";
    this.toggleEl.addEventListener("change", () => this.commit(this.toggleEl.checked));
    containerEl.appendChild(this.toggleEl);
  }

  getInitialValue(): boolean {
    return false;
  }

  getValue(): boolean {
    return this.toggleEl.checked;
  }

  setValue(v: boolean): this {
    this.value = v;
    this.toggleEl.checked = v;
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.selectEl = document.createElement("select");
    this.selectEl.style.font = "inherit";
    this.selectEl.addEventListener("change", () => this.commit(this.selectEl.value));
    containerEl.appendChild(this.selectEl);
  }

  getInitialValue(): string {
    return "";
  }

  getValue(): string {
    return this.selectEl.value;
  }

  setValue(v: string): this {
    this.value = v;
    this.selectEl.value = v;
    return this;
  }

  addOption(value: string, label: string): this {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    this.selectEl.appendChild(opt);
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [v, l] of Object.entries(options)) this.addOption(v, l);
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  sliderEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.sliderEl = document.createElement("input");
    this.sliderEl.type = "range";
    this.sliderEl.style.width = "140px";
    this.sliderEl.addEventListener("input", () => this.commit(Number(this.sliderEl.value)));
    containerEl.appendChild(this.sliderEl);
  }

  getInitialValue(): number {
    return 0;
  }

  getValue(): number {
    return Number(this.sliderEl.value);
  }

  setValue(v: number): this {
    this.value = v;
    this.sliderEl.value = String(v);
    return this;
  }

  setLimits(min: number, max: number, step: number | "any"): this {
    this.sliderEl.min = String(min);
    this.sliderEl.max = String(max);
    this.sliderEl.step = String(step);
    return this;
  }

  setDynamicTooltip(): this {
    this.sliderEl.title = this.sliderEl.value;
    this.sliderEl.addEventListener("input", () => {
      this.sliderEl.title = this.sliderEl.value;
    });
    return this;
  }
}

export class SearchComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.inputEl = document.createElement("input");
    this.inputEl.type = "search";
    this.inputEl.style.width = "100%";
    this.inputEl.style.font = "inherit";
    this.inputEl.addEventListener("input", () => this.commit(this.inputEl.value));
    containerEl.appendChild(this.inputEl);
  }

  getInitialValue(): string {
    return "";
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setValue(v: string): this {
    this.value = v;
    this.inputEl.value = v;
    return this;
  }

  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
}

/**
 * 取色器组件（Setting.addColorPicker 的实现类型）。
 * 插件会 `class X extends obsidian.ColorComponent`，所以必须导出真实的类。
 * 交互上给一个原生 <input type=color> + 十六进制文本框，够用且不引第三方依赖。
 */
export class ColorComponent extends ValueComponent<string> {
  swatchEl: HTMLInputElement;
  textEl: HTMLInputElement;
  private rgbValue: { r: number; g: number; b: number } | null = null;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "6px";
    row.style.alignItems = "center";

    this.swatchEl = document.createElement("input");
    this.swatchEl.type = "color";
    this.swatchEl.style.width = "34px";
    this.swatchEl.style.height = "26px";
    this.swatchEl.style.padding = "0";
    this.swatchEl.addEventListener("input", () => {
      this.textEl.value = this.swatchEl.value;
      this.commit(this.swatchEl.value);
    });

    this.textEl = document.createElement("input");
    this.textEl.type = "text";
    this.textEl.style.width = "110px";
    this.textEl.style.font = "inherit";
    this.textEl.placeholder = "#RRGGBB";
    this.textEl.addEventListener("input", () => {
      const v = this.textEl.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) this.swatchEl.value = v;
      this.commit(v);
    });

    row.append(this.swatchEl, this.textEl);
    containerEl.appendChild(row);
  }

  getInitialValue(): string {
    return "#000000";
  }

  getValue(): string {
    return this.textEl.value.trim();
  }

  override setValue(v: string): this {
    this.value = v;
    this.textEl.value = v;
    if (/^#[0-9a-f]{6}$/i.test(v)) this.swatchEl.value = v;
    return this;
  }

  /** RGB 接口（Obsidian 的 ColorComponent 有这组方法） */
  getValueRgb(): { r: number; g: number; b: number } | null {
    return this.rgbValue;
  }

  setValueRgb(rgb: { r: number; g: number; b: number } | null): this {
    this.rgbValue = rgb;
    if (rgb) this.setValue(rgbToHex(rgb.r, rgb.g, rgb.b));
    return this;
  }

  getValueHsl(): { h: number; s: number; l: number } | null {
    return this.rgbValue ? rgbToHsl(this.rgbValue.r, this.rgbValue.g, this.rgbValue.b) : null;
  }

  setValueHsl(hsl: { h: number; s: number; l: number } | null): this {
    if (!hsl) return this;
    const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
    return this.setValueRgb(rgb);
  }

  /** 与 ColorComponent 交互的方法（如显示/隐藏自定义面板） */
  showColorPicker(): void {
    this.swatchEl.click();
  }

  hideColorPicker(): void {}
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = Math.max(0, Math.min(100, s)) / 100;
  const ll = Math.max(0, Math.min(100, l)) / 100;
  if (ss === 0) {
    const v = Math.round(ll * 255);
    return { r: v, g: v, b: v };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(hue(hh + 1 / 3) * 255),
    g: Math.round(hue(hh) * 255),
    b: Math.round(hue(hh - 1 / 3) * 255),
  };
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  isDisabled = false;

  constructor(containerEl: HTMLElement, cb?: (evt: MouseEvent) => unknown) {
    super(containerEl);
    this.buttonEl = document.createElement("button");
    this.buttonEl.style.font = "inherit";
    this.buttonEl.style.padding = "4px 12px";
    this.buttonEl.style.cursor = "pointer";
    if (cb) this.buttonEl.addEventListener("click", cb as EventListener);
    containerEl.appendChild(this.buttonEl);
  }

  setButtonText(t: string): this {
    this.buttonEl.textContent = t;
    return this;
  }

  setIcon(i: string): this {
    setIcon(this.buttonEl, i);
    return this;
  }

  setClass(cls: string): this {
    this.buttonEl.className = cls;
    return this;
  }

  setTooltip(t: string): this {
    this.buttonEl.title = t;
    return this;
  }

  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }

  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.isDisabled = disabled;
    this.buttonEl.disabled = disabled;
    return this;
  }

  override onClick(cb: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", cb as EventListener);
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.extraSettingsEl = document.createElement("button");
    (this.extraSettingsEl as HTMLButtonElement).type = "button";
    this.extraSettingsEl.className = "nf-extra-button";
    this.extraSettingsEl.setAttribute("aria-label", "更多");
    this.extraSettingsEl.textContent = "⋯";
    containerEl.appendChild(this.extraSettingsEl);
  }

  setTooltip(t: string): this {
    this.extraSettingsEl.title = t;
    return this;
  }

  setIcon(i: string): this {
    setIcon(this.extraSettingsEl, i);
    return this;
  }

  override onClick(cb: (evt: MouseEvent) => unknown): this {
    this.extraSettingsEl.addEventListener("click", cb as EventListener);
    return this;
  }
}

const SETTING_CSS = `
.nf-setting-item{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--background-modifier-border,#8882)}
.nf-setting-item.mod-heading{border:none;padding-top:18px}
.nf-setting-item.mod-heading .nf-setting-item-info{display:block}
.nf-setting-item-info{flex:1;min-width:0}
.nf-setting-item-name{font-size:13px;font-weight:500}
.nf-setting-item-desc{font-size:12px;color:var(--text-muted,#888);margin-top:2px}
.nf-setting-item-control{display:flex;align-items:center;gap:8px;max-width:340px;flex:1}
.nf-setting-item-control > div{flex:1}
`;

function ensureSettingCss(): void {
  if (document.getElementById("nf-setting-css")) return;
  const style = document.createElement("style");
  style.id = "nf-setting-css";
  style.textContent = SETTING_CSS;
  document.head.appendChild(style);
}

/**
 * SettingBuilder：一行设置 = 名称/描述 + 控件。
 * 插件设置页几乎全部由它构成，因此语义要准（顺序、类名、controlEl 结构）。
 */
/** 1.13.1：显示当前值的只读组件（导航行用）。 */
export class DisplayValueComponent extends BaseComponent {
  valueEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.valueEl = document.createElement("span");
    this.valueEl.className = "nf-display-value";
    containerEl.appendChild(this.valueEl);
  }

  setValue(value: string): this {
    this.valueEl.textContent = value;
    return this;
  }

  getValue(): string {
    return this.valueEl.textContent ?? "";
  }

  /** 1.13.1 允许调用方高亮该值（例如标红需要关注的配置）。 */
  setWarning(warning: boolean): this {
    this.valueEl.classList.toggle("is-warning", warning);
    return this;
  }
}

/** 1.13：进度条组件（设置页里表示任务进度）。 */
export class ProgressBarComponent extends ValueComponent<number> {
  barEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.barEl = document.createElement("div");
    this.barEl.className = "nf-progress-bar";
    containerEl.appendChild(this.barEl);
  }

  getInitialValue(): number {
    return 0;
  }

  getValue(): number {
    return Number(this.barEl.dataset.value ?? 0);
  }

  override setValue(v: number): this {
    this.value = v;
    this.barEl.dataset.value = String(v);
    this.barEl.style.width = `${Math.max(0, Math.min(100, v))}%`;
    return this;
  }

  setLimits(_min: number, _max: number): this {
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  /** 校验错误信息元素（1.13 新增，setErrorMessage 时才创建）。 */
  errorEl: HTMLElement | null = null;
  components: BaseComponent[] = [];

  constructor(containerEl: HTMLElement) {
    ensureSettingCss();
    this.settingEl = document.createElement("div");
    this.settingEl.className = "nf-setting-item";
    this.infoEl = document.createElement("div");
    this.infoEl.className = "nf-setting-item-info";
    this.nameEl = document.createElement("div");
    this.nameEl.className = "nf-setting-item-name";
    this.descEl = document.createElement("div");
    this.descEl.className = "nf-setting-item-desc";
    this.controlEl = document.createElement("div");
    this.controlEl.className = "nf-setting-item-control";
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.appendChild(this.settingEl);
  }

  setName(name: string | DocumentFragment): this {
    if (typeof name === "string") this.nameEl.textContent = name;
    else this.nameEl.replaceChildren(name);
    return this;
  }

  setDesc(desc: string | DocumentFragment): this {
    this.descEl.style.display = desc ? "" : "none";
    if (typeof desc === "string") this.descEl.textContent = desc;
    else this.descEl.replaceChildren(desc);
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.className = `nf-setting-item ${cls}`;
    return this;
  }

  setTooltip(t: string): this {
    this.settingEl.title = t;
    return this;
  }

  setHeading(): this {
    this.settingEl.classList.add("mod-heading");
    this.controlEl.style.display = "none";
    return this;
  }

  /** Obsidian 1.5+ 的 Setting.setVisibility：按条件显示/隐藏整行。 */
  setVisibility(visible: boolean): this {
    this.settingEl.style.display = visible ? "" : "none";
    return this;
  }

  setDisabled(disabled: boolean): this {
    for (const c of this.components) c.setDisabled(disabled);
    if (disabled) this.settingEl.setAttribute("aria-disabled", "true");
    return this;
  }

  addText(cb: (c: TextComponent) => unknown): this {
    const c = new TextComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addTextArea(cb: (c: TextAreaComponent) => unknown): this {
    const c = new TextAreaComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addToggle(cb: (c: ToggleComponent) => unknown): this {
    const c = new ToggleComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addDropdown(cb: (c: DropdownComponent) => unknown): this {
    const c = new DropdownComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addSlider(cb: (c: SliderComponent) => unknown): this {
    const c = new SliderComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addSearch(cb: (c: SearchComponent) => unknown): this {
    const c = new SearchComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addButton(cb: (c: ButtonComponent) => unknown): this {
    const c = new ButtonComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addExtraButton(cb: (c: ExtraButtonComponent) => unknown): this {
    const c = new ExtraButtonComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addButtonForCommand(_cmd: unknown, cb: (c: ButtonComponent) => unknown): this {
    const c = new ButtonComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  addMomentFormat(cb: (c: unknown) => unknown): this {
    const c = new TextComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  /**
   * 1.13 新增：把任意组件塞进行里。
   * 插件用它挂自定义控件（SecretComponent、自己的 Widget 等），
   * 没有这个方法时插件会在渲染设置页时直接抛错。
   */
  addComponent<T>(cb: (el: HTMLElement) => T): this {
    const holder = document.createElement("div");
    holder.className = "nf-setting-item-component";
    this.controlEl.appendChild(holder);
    const c = cb(holder);
    if (c && typeof c === "object") {
      this.components.push(c as unknown as BaseComponent);
      // 组件实现了 load() 就让它自己初始化（Obsidian 的 Component 语义）
      const loadable = c as { load?: () => void };
      loadable.load?.();
    }
    return this;
  }

  /** 1.13 新增：行下方的校验错误信息（空串/null 清除，并去掉 is-invalid）。 */
  setErrorMessage(message: string | null): this {
    if (message) {
      if (!this.errorEl) {
        this.errorEl = document.createElement("div");
        this.errorEl.className = "nf-setting-item-error";
        this.settingEl.appendChild(this.errorEl);
      }
      this.errorEl.textContent = message;
      this.errorEl.style.display = "";
      this.settingEl.classList.add("is-invalid");
    } else {
      // 清除时要把文本也清掉：只藏起来的话，textContent 里还留着旧错误，
      // 插件与测试都会以为错误没消（Obsidian 传 null 是真的清空）。
      if (this.errorEl) {
        this.errorEl.textContent = "";
        this.errorEl.style.display = "none";
      }
      this.settingEl.classList.remove("is-invalid");
    }
    return this;
  }

  /** 1.13.1 新增：在行上显示当前值（可打开子页的导航行用）。 */
  addDisplayValue(cb: (component: DisplayValueComponent) => unknown): this {
    const holder = document.createElement("div");
    holder.className = "nf-setting-item-display-value";
    this.controlEl.appendChild(holder);
    cb(new DisplayValueComponent(holder));
    return this;
  }

  /** 1.13 新增：进度条。 */
  addProgressBar(cb?: (c: ProgressBarComponent) => unknown): this {
    const c = new ProgressBarComponent(this.controlEl);
    this.components.push(c);
    cb?.(c);
    return this;
  }

  addColorPicker(cb: (c: ColorComponent) => unknown): this {
    const c = new ColorComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }

  then(cb: (s: Setting) => unknown): this {
    cb(this);
    return this;
  }
}

/**
 * 1.13 的密钥组件：值不进 data.json，只在 SecretStorage 里存一个 id。
 *
 * noteforge 没有系统钥匙串，用 localStorage 存明文（与插件自己的旧版迁移路径一致，
 * 插件读 app.secretStorage.getSecret 就能取回）。插件只依赖「存进去再读出来」这一层语义。
 */
export class SecretComponent extends BaseComponent {
  inputEl: HTMLInputElement;
  private secretId: string | null = null;
  private changeCb: ((id: string | null) => unknown) | null = null;

  constructor(app: unknown, containerEl: HTMLElement) {
    super(containerEl);
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "6px";
    this.inputEl = document.createElement("input");
    this.inputEl.type = "password";
    this.inputEl.style.flex = "1";
    this.inputEl.style.font = "inherit";
    this.inputEl.placeholder = "应用密码";
    const save = document.createElement("button");
    save.textContent = "保存";
    save.addEventListener("click", () => this.commit());
    this.inputEl.addEventListener("change", () => this.commit());
    row.append(this.inputEl, save);
    containerEl.appendChild(row);
    this.storage = (app as { secretStorage?: SecretStorage }).secretStorage ?? null;
  }

  private storage: SecretStorage | null = null;

  /** 绑到已有的密钥 id 上（插件传的是 data.json 里存的 id）。 */
  setValue(secretId: string | null): this {
    this.secretId = secretId ?? null;
    const stored = secretId ? this.storage?.getSecret(secretId) : null;
    this.inputEl.value = stored ?? "";
    return this;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  onChange(cb: (id: string | null) => unknown): this {
    this.changeCb = cb;
    return this;
  }

  private commit(): void {
    if (!this.storage) return;
    const value = this.inputEl.value;
    const id = this.secretId ?? `nf-secret-${Date.now().toString(36)}`;
    if (value) this.storage.setSecret(id, value);
    else this.storage.deleteSecret(id);
    this.secretId = id;
    this.changeCb?.(id);
  }
}

/** 1.13 的密钥存储（app.secretStorage）。 */
export interface SecretStorage {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
  deleteSecret(id: string): void;
  hasSecret(id: string): boolean;
  listSecrets(): string[];
}

/**
 * 让标签页容器的 `empty()` / `replaceChildren()` 不摘掉内容区。
 *
 * Obsidian 的语义是「清空后 contentEl 仍然可用」——它是宿主准备好的内容区，
 * 插件清完容器继续往 contentEl 里画是常规写法（calendar、quickadd 都这么干）。
 * 照搬 DOM 语义会把 contentEl 整个从文档里摘掉，插件随后往游离节点里画界面，
 * 结果就是设置页空白且不报错。
 */
function protectContentEl(containerEl: HTMLElement, contentEl: HTMLElement): void {
  const proto = Object.getPrototypeOf(containerEl) as HTMLElement & {
    empty?: () => void;
    replaceChildren?: (...nodes: Node[]) => void;
  };
  const origEmpty = proto.empty;
  const origReplace = proto.replaceChildren;
  const restore = (): void => {
    if (!containerEl.contains(contentEl)) containerEl.appendChild(contentEl);
  };
  Object.defineProperty(containerEl, "empty", {
    configurable: true,
    value: () => {
      origEmpty?.call(containerEl);
      restore();
      contentEl.replaceChildren();
      return containerEl;
    },
  });
  Object.defineProperty(containerEl, "replaceChildren", {
    configurable: true,
    value: (...nodes: Node[]) => {
      origReplace?.apply(containerEl, nodes);
      restore();
      return containerEl;
    },
  });
}

export abstract class PluginSettingTab {
  /** 整个标签页容器（宿主用它做切页动画/滚动定位）。 */
  containerEl: HTMLElement;
  /**
   * 插件真正往里写内容的元素（Obsidian 语义：containerEl 的子元素）。
   *
   * 这一条不能少：绝大多数插件的 display() 第一句就是
   * `this.contentEl.empty()` 然后 `new Setting(this.contentEl)`。
   * 只给 containerEl 时，插件要么抛 "Cannot read properties of undefined"，
   * 要么（在没做保护的插件里）渲染到别处 —— 结果就是设置页一片空白。
   */
  contentEl: HTMLElement;
  app: unknown;
  plugin: { manifest: { id: string; name: string } };

  constructor(app: unknown, plugin: { manifest: { id: string; name: string } }) {
    this.app = app;
    this.plugin = plugin;
    ensureSettingCss();
    this.containerEl = document.createElement("div");
    this.containerEl.className = "nf-setting-tab";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "nf-setting-tab-content";
    this.containerEl.appendChild(this.contentEl);
    protectContentEl(this.containerEl, this.contentEl);
  }

  abstract display(): void;

  /**
   * 1.13 的声明式设置定义。插件可以不写 display()，改用它把配置项交给宿主渲染。
   * 返回空数组时宿主才退回 display()（与 Obsidian 的判定顺序一致）。
   */
  getSettingDefinitions?(): unknown[];

  /** 1.13：按 key 读/写设置值（宿主渲染控件时调用）。 */
  getControlValue?(key: string): unknown;
  setControlValue?(key: string, value: unknown): void | Promise<void>;

  /**
   * 1.13：重新评估 visible/disabled 等谓词并重画。
   * 插件在改完自己的状态后调它，设置页才会刷新。
   *
   * 默认实现走宿主注入的重绘函数（settingDefs.renderSettingTab 延迟注入，
   * 避免 ui.ts → settingDefs.ts → ui.ts 的循环依赖）。
   */
  update(): void {
    const redraw = (this as unknown as { __redraw?: () => void }).__redraw;
    redraw?.();
  }

  hide(): void {
    this.contentEl.replaceChildren();
  }
}

export abstract class SettingTab extends PluginSettingTab {}

export { Platform, debounce, Component, escapeHtml };
