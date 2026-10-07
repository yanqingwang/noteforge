/**
 * Obsidian 的 DOM 扩展方法。
 *
 * Obsidian 启动时会给 HTMLElement/Element 原型挂一批便捷方法（createEl、
 * createDiv、empty、setText、addClass、onClickEvent…），插件几乎无条件地依赖它们。
 * 不补这一层，插件在第一次 DOM 操作时就抛 TypeError，而报错信息往往是
 * "xxx.createEl is not a function"，很难让人联想到是宿主缺 API。
 */

export interface CreateElOptions {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  placeholder?: string;
  href?: string;
  prepend?: boolean;
}

/** 把 createEl 系列挂到原型上。重复调用安全。 */
export function installDomExtensions(): void {
  const proto = globalThis.HTMLElement?.prototype;
  // 不依赖全局 Document 是否存在：从已知的 HTMLElement 反查 ownerDocument
  const docCtor = globalThis.Document ?? (proto?.ownerDocument as Document | undefined)?.constructor;
  const docProto = (docCtor as { prototype?: Document } | undefined)?.prototype;
  if (!proto || !docProto) return;
  const flag = "__nfObsidianDom";
  if ((proto as unknown as Record<string, unknown>)[flag]) return;
  Object.defineProperty(proto, flag, { value: true, enumerable: false });

  // Obsidian 把这些方法挂在 Node.prototype 上（createEl/empty/setText 对
  // DocumentFragment、Text 同样有效）。只挂 HTMLElement 会让插件在
  // fragment.createDiv() 这类调用上炸。
  const nodeProto = globalThis.Node?.prototype;
  for (const target of [proto, nodeProto, docProto] as unknown as Array<Record<string, unknown>>) {
    if (!target) continue;
    const P = target as unknown as HTMLElement;

    P.createEl = function (this: HTMLElement, tag: string, o?: CreateElOptions | string, cb?: (el: HTMLElement) => void) {
      const opts: CreateElOptions = typeof o === "string" ? { cls: o } : (o ?? {});
      const el = globalThis.document.createElement(tag);
      applyCreateOpts(el, opts);
      cb?.(el);
      if (opts.parent) opts.parent.appendChild(el);
      else if (opts.prepend) this.prepend(el);
      else this.appendChild(el);
      return el;
    };

    P.createDiv = function (this: HTMLElement, o?: CreateElOptions | string, cb?: (el: HTMLElement) => void) {
      return (this as unknown as HTMLElement).createEl("div", o, cb);
    };
    P.createSpan = function (this: HTMLElement, o?: CreateElOptions | string, cb?: (el: HTMLElement) => void) {
      return (this as unknown as HTMLElement).createEl("span", o, cb);
    };

    P.empty = function (this: HTMLElement) {
      while (this.firstChild) this.removeChild(this.firstChild);
    };
    P.detach = function (this: HTMLElement) {
      this.parentNode?.removeChild(this);
    };
    P.setText = function (this: HTMLElement, t: string | DocumentFragment | null) {
      this.textContent = "";
      if (t === null || t === undefined) return this;
      if (typeof t === "string") this.textContent = t;
      else this.appendChild(t);
      return this;
    };
    P.appendText = function (this: HTMLElement, t: string) {
      this.appendChild(globalThis.document.createTextNode(t));
    };

    P.addClass = function (this: HTMLElement, ...classes: string[]) {
      this.classList.add(...classes.flatMap((c) => c.split(/\s+/)).filter(Boolean));
    };
    P.addClasses = function (this: HTMLElement, classes: string) {
      this.classList.add(...classes.split(/\s+/).filter(Boolean));
    };
    P.removeClass = function (this: HTMLElement, ...classes: string[]) {
      this.classList.remove(...classes.flatMap((c) => c.split(/\s+/)).filter(Boolean));
    };
    P.removeClasses = function (this: HTMLElement, classes: string) {
      this.classList.remove(...classes.split(/\s+/).filter(Boolean));
    };
    P.toggleClass = function (this: HTMLElement, classes: string | string[], value: boolean) {
      for (const c of (Array.isArray(classes) ? classes : [classes]).flatMap((x) => x.split(/\s+/)).filter(Boolean)) {
        this.classList.toggle(c, value);
      }
    };
    P.hasClass = function (this: HTMLElement, cls: string) {
      return this.classList.contains(cls);
    };
    P.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
      Object.assign(this.style, styles);
    };
    // Obsidian 里的 setCssProps（自定义属性形式），插件用它批量设样式
    P.setCssProps = function (this: HTMLElement, styles: Record<string, string>) {
      for (const [k, v] of Object.entries(styles ?? {})) {
        this.style.setProperty(k.startsWith("--") ? k : `--${k}`, v);
      }
    };

    P.onClickEvent = function (this: HTMLElement, cb: (ev: MouseEvent) => unknown, options?: AddEventListenerOptions) {
      this.addEventListener("click", cb as EventListener, options);
    };
    // Obsidian 的属性/事件/类型辅助
    P.setAttr = function (this: HTMLElement, name: string, value: string | number | boolean | null) {
      if (value === null || value === false) this.removeAttribute(name);
      else this.setAttribute(name, String(value));
    };
    P.getAttr = function (this: HTMLElement, name: string): string | null {
      return this.getAttribute(name);
    };
    P.toggleAttr = function (this: HTMLElement, name: string, value: boolean) {
      if (value) this.setAttribute(name, "");
      else this.removeAttribute(name);
    };
    P.instanceOf = function (this: HTMLElement, cls: string): boolean {
      return this.classList.contains(cls) || (this.parentElement?.instanceOf(cls) ?? false);
    };
    P.isShown = function (this: HTMLElement): boolean {
      return this.style.display !== "none" && !this.hasAttribute("hidden");
    };
    // Obsidian 的 el.on(type, cb) —— 与 onClickEvent 同族但支持任意事件
    P.on = function (this: HTMLElement, type: string, cb: EventListener, options?: AddEventListenerOptions) {
      this.addEventListener(type, cb, options);
    };
    P.off = function (this: HTMLElement, type: string, cb: EventListener, options?: EventListenerOptions) {
      this.removeEventListener(type, cb, options);
    };
    P.show = function (this: HTMLElement) {
      this.style.removeProperty("display");
    };
    P.hide = function (this: HTMLElement) {
      this.style.setProperty("display", "none");
    };
    P.setDisabled = function (this: HTMLElement, disabled: boolean) {
      if (disabled) this.setAttribute("disabled", "true");
      else this.removeAttribute("disabled");
    };
  }

  // Obsidian 的 String.prototype.contains
  const strProto = globalThis.String?.prototype as unknown as Record<string, unknown>;
  if (strProto && !strProto.contains) {
    Object.defineProperty(strProto, "contains", {
      value: function (this: string, needle: string) {
        return this.includes(needle);
      },
      enumerable: false,
    });
  }

  // Obsidian 的 createFragment()
  const doc = globalThis.document as unknown as Record<string, unknown>;
  if (doc && !doc.createFragment) {
    doc.createFragment = (cb?: (frag: DocumentFragment) => void) => {
      const frag = globalThis.document.createDocumentFragment();
      cb?.(frag);
      return frag;
    };
  }
}

/**
 * 创建元素的公共实现。原型方法与全局 createEl()（Obsidian 把 createEl/createDiv/
 * createSpan 挂在 window 上）共用它，避免两套语义。
 */
export function createElement(
  tag: string,
  o?: CreateElOptions | string,
  cb?: (el: HTMLElement) => void,
): HTMLElement {
  const opts: CreateElOptions = typeof o === "string" ? { cls: o } : (o ?? {});
  const el = globalThis.document.createElement(tag);
  applyCreateOpts(el, opts);
  cb?.(el);
  if (opts.parent) opts.parent.appendChild(el);
  else if (opts.prepend && el.parentNode) el.parentNode.insertBefore(el, el.parentNode.firstChild);
  return el;
}

function applyCreateOpts(el: HTMLElement, o: CreateElOptions): void {
  if (o.cls) {
    const list = Array.isArray(o.cls) ? o.cls : o.cls.split(/\s+/);
    el.classList.add(...list.filter(Boolean));
  }
  if (o.text !== undefined) {
    if (typeof o.text === "string") el.textContent = o.text;
    else el.appendChild(o.text);
  }
  if (o.attr) {
    for (const [k, v] of Object.entries(o.attr)) {
      if (v === null || v === false) continue;
      el.setAttribute(k, String(v));
    }
  }
  if (o.title !== undefined) el.title = o.title;
  if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
  if (o.type !== undefined) el.setAttribute("type", o.type);
  if (o.placeholder !== undefined) el.setAttribute("placeholder", o.placeholder);
  if (o.href !== undefined) el.setAttribute("href", o.href);
}

declare global {
  interface HTMLElement {
    createEl(tag: string, o?: CreateElOptions | string, cb?: (el: HTMLElement) => void): HTMLElement;
    createDiv(o?: CreateElOptions | string, cb?: (el: HTMLElement) => void): HTMLElement;
    createSpan(o?: CreateElOptions | string, cb?: (el: HTMLElement) => void): HTMLElement;
    empty(): void;
    detach(): void;
    setText(t: string | DocumentFragment | null): HTMLElement;
    appendText(t: string): void;
    addClass(...classes: string[]): void;
    addClasses(classes: string): void;
    removeClass(...classes: string[]): void;
    removeClasses(classes: string): void;
    toggleClass(classes: string | string[], value: boolean): void;
    hasClass(cls: string): boolean;
    setCssStyles(styles: Partial<CSSStyleDeclaration>): void;
    setCssProps(styles: Record<string, string>): void;
    onClickEvent(cb: (ev: MouseEvent) => unknown, options?: AddEventListenerOptions): void;
    setAttr(name: string, value: string | number | boolean | null): void;
    getAttr(name: string): string | null;
    toggleAttr(name: string, value: boolean): void;
    instanceOf(cls: string): boolean;
    isShown(): boolean;
    on(type: string, cb: EventListener, options?: AddEventListenerOptions): void;
    off(type: string, cb: EventListener, options?: EventListenerOptions): void;
    show(): void;
    hide(): void;
    setDisabled(disabled: boolean): void;
  }
  interface Document {
    createFragment(cb?: (frag: DocumentFragment) => void): DocumentFragment;
  }
  interface String {
    contains(needle: string): boolean;
  }
}