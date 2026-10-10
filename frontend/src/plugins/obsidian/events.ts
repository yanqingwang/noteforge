/**
 * 事件总线、组件生命周期与通用工具函数。
 *
 * Obsidian 的 `app.workspace.on(...)` / `vault.on(...)` 都走同一个 Events 实例，
 * 插件 `registerEvent` 拿到的 EventRef 在插件卸载时自动解绑 —— 这套语义必须一致，
 * 否则插件卸载后回调仍触发会引发难查的重复执行。
 */

import { parse as parseYamlImpl, stringify as stringifyYamlImpl } from "yaml";
import { getHostPlatform } from "../loader";
import type { EventRef } from "./types";

let refSeq = 0;

type Handler = (...args: unknown[]) => void;

/** Obsidian Events：按事件名分发，offref 由具体事件源提供（DOM 事件等）。 */
export class Events {
  private handlers = new Map<string, Set<Handler>>();
  private offs = new Map<string, (ref: EventRef) => void>();

  /** 由事件源注入：把 EventRef 的解绑动作委托给它（DOM 事件需要 removeEventListener）。 */
  setOffref(name: string, off: (ref: EventRef) => void): void {
    this.offs.set(name, off);
  }

  on(name: string, cb: Handler): EventRef {
    if (typeof cb !== "function") throw new TypeError(`on("${name}") 需要函数回调`);
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(cb);
    return { id: `ref-${++refSeq}`, name, callback: cb, offref: this.offs.get(name) };
  }

  off(name: string, cb: Handler): void {
    this.handlers.get(name)?.delete(cb);
  }

  offref(ref: EventRef): void {
    this.handlers.get(ref.name)?.delete(ref.callback);
    ref.offref?.(ref);
  }

  trigger(name: string, ...args: unknown[]): void {
    const set = this.handlers.get(name);
    if (!set?.size) return;
    for (const cb of [...set]) {
      try {
        cb(...args);
      } catch (e) {
        // 一个坏回调不能拖垮整条事件链（Obsidian 同样是隔离处理）
        console.error(`[obsidian-shim] 事件 "${name}" 的回调抛错：`, e);
      }
    }
  }

  /** 内部：注册的处理器数量（诊断用） */
  count(name: string): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}

/** 生命周期组件：onload/onunload + 子组件 + 事件/定时器登记。 */
export class Component {
  _loaded = false;
  _children: Component[] = [];
  _events: EventRef[] = [];
  _intervals: number[] = [];
  _domEvents: Array<() => void> = [];

  onload(): void {
    this._loaded = true;
  }

  onunload(): void {
    this._loaded = false;
    for (const c of this._children) c.onunload();
    this._children = [];
    for (const ref of this._events) ref.offref?.(ref);
    this._events = [];
    for (const i of this._intervals) clearInterval(i);
    this._intervals = [];
    for (const off of this._domEvents) off();
    this._domEvents = [];
  }

  addChild<T extends Component>(c: T): T {
    this._children.push(c);
    if (this._loaded) c.onload();
    return c;
  }

  removeChild<T extends Component>(c: T): void {
    const i = this._children.indexOf(c);
    if (i >= 0) this._children.splice(i, 1);
    c.onunload();
  }

  register(cb: () => unknown): void {
    // Obsidian 的 register 用于「插件生命周期内执行一次」的清理登记
    this._domEvents.push(() => {
      void cb();
    });
  }

  registerEvent(ref: EventRef | null | undefined): void {
    if (ref) this._events.push(ref);
  }

  registerDomEvent(el: EventTarget, type: string, cb: EventListener): void {
    el.addEventListener(type, cb);
    this._domEvents.push(() => el.removeEventListener(type, cb));
  }

  registerInterval(id: number): number {
    this._intervals.push(id);
    return id;
  }
}

/* ---------- 工具函数（Obsidian 插件普遍依赖） ---------- */

/** 路径规范化：统一为 vault 内相对路径、反斜杠转正斜杠、去重复分隔符。 */
export function normalizePath(p: string): string {
  return p
    .replace(/([\\/])+/g, "/")
    .replace(/(^\/+|\/+$)/g, "")
    .replace(/ | /g, " ")
    .normalize("NFC");
}

/**
 * debounce：lodash 语义（leading 关闭、trailing 开启）。
 * resetTimer=false 时，窗口内的后续调用只更新参数、不重置定时器 ——
 * 否则连续三次调用会触发三次（早先的实现就是这样，插件里到处是 debounce 搜索框）。
 */
export function debounce<T extends (...args: never[]) => unknown>(fn: T, timeout = 0, resetTimer = false): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  const wrapped = (...args: Parameters<T>) => {
    lastArgs = args;
    if (timer) {
      if (!resetTimer) return; // 合并进已在等待的那次触发
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn(...a);
    }, timeout);
  };
  (wrapped as unknown as { cancel(): void }).cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return wrapped as T & { cancel(): void };
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 提取标签：Obsidian 的 CachedMetadata 已把行内标签解析进 cache.tags，
 * 这里只需合并 frontmatter.tags 与 cache.tags。
 */
export function getAllTags(cache: CachedMetadataLike | null): string[] | null {
  if (!cache) return null;
  const out: string[] = [];
  const fm = cache.frontmatter;
  if (fm && typeof fm === "object" && !Array.isArray(fm)) {
    const tags = (fm as Record<string, unknown>).tags;
    if (Array.isArray(tags)) out.push(...tags.map(String));
    else if (typeof tags === "string") out.push(tags);
  }
  if (Array.isArray(cache.tags)) out.push(...cache.tags.map(String));
  return out.length ? out : null;
}

/** shim 不实现 Obsidian 完整的 CachedMetadata，这里只声明插件真正会碰的字段。 */
export interface CachedMetadataLike {
  frontmatter?: unknown;
  tags?: unknown[];
  headings?: unknown[];
  links?: unknown[];
  embeds?: unknown[];
  [k: string]: unknown;
}

export interface Linktext {
  path: string;
  subpath: string;
  alias: string;
  display?: string;
}

/**
 * Obsidian 的双链语法：`path#subpath|alias`。
 * 注意拆分顺序：先按 `|` 取别名，剩下的再按 `#` 分路径与锚点
 * （早先写成「先 # 再 |」，会把 `#标题` 误当成别名，插件解析标题就废了）。
 */
export function parseLinktext(linktext: string): Linktext {
  const [target, alias] = splitOnce(linktext, "|");
  const [path, subpath] = splitOnce(target, "#");
  return {
    path: path || "",
    subpath: subpath ? `#${subpath}` : "",
    alias: alias || "",
  };
}

function splitOnce(s: string, sep: string): [string, string] | [string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

export function resolveSubpath(_cache: unknown, subpath: string): unknown {
  // Heading/block 跳转：不做完整解析，返回命中的原始信息即可满足大多数插件
  return { subpath, exists: true };
}

/* ---------- YAML ---------- */

export function parseYaml(text: string): unknown {
  try {
    return parseYamlImpl(text);
  } catch {
    return null;
  }
}

export function stringifyYaml(value: unknown): string {
  try {
    return stringifyYamlImpl(value);
  } catch {
    return "";
  }
}

/**
 * Scope：按「键 + 处理函数」登记，冲突时抛出并提示。
 * 插件的键盘作用域（尤其 EditorSuggest 子类）会调 scope.register(...)，
 * 把它实现成 null 会直接让插件在 onload 里崩。
 */
export class Scope {
  private counts = new Map<string, number>();
  private entries: Array<{ keys: string[]; handler: (...a: unknown[]) => unknown }> = [];

  register(...args: unknown[]): (...a: unknown[]) => unknown {
    const handler = args.pop();
    if (typeof handler !== "function") throw new TypeError("scope.register 需要处理函数");
    const keys = args.flat().map(String);
    for (const k of keys) {
      if (this.counts.has(k)) {
        throw new Error(`键 "${k}" 已注册（重复注册会互相覆盖）`);
      }
    }
    for (const k of keys) this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    this.entries.push({ keys, handler: handler as (...a: unknown[]) => unknown });
    return handler as (...a: unknown[]) => unknown;
  }

  unregister(handler: (...a: unknown[]) => unknown): void {
    const i = this.entries.findIndex((e) => e.handler === handler);
    if (i === -1) return;
    for (const k of this.entries[i].keys) {
      const n = (this.counts.get(k) ?? 1) - 1;
      if (n <= 0) this.counts.delete(k);
      else this.counts.set(k, n);
    }
    this.entries.splice(i, 1);
  }

  unregisterAll(): void {
    this.counts.clear();
    this.entries = [];
  }
}

/* ---------- Platform ---------- */

export const Platform = {
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  // 用 getter：宿主平台由 setHostPlatform() 注入，模块求值时未必已就绪
  get isMacOS() { return getHostPlatform().os === "darwin"; },
  get isWin() { return getHostPlatform().os === "win32"; },
  get isLinux() { return getHostPlatform().os === "linux"; },
  isSafari: false,
  isPhone: false,
  isTablet: false,
};

/* ---------- setIcon / addIcon ---------- */

import { ICONS } from "./icon-registry";

/** 注册图标（内联 SVG path，Lucide 风格）。插件用 addIcon 自带图标。 */
export function addIcon(id: string, svg: string): void {
  ICONS.set(id, svg);
}

export function setIcon(el: HTMLElement, icon: string): void {
  const svg = ICONS.get(icon);
  if (svg) {
    el.innerHTML = svg;
    el.addClass?.("obsidian-icon");
    return;
  }
  // 没有内置图标时退化成首字母方块，保证按钮仍有可点区域与可访问名
  el.textContent = "";
  el.setAttribute("aria-label", icon);
  el.innerHTML = `<span class="nf-icon-fallback" aria-hidden="true">${escapeHtml(icon.slice(0, 1).toUpperCase())}</span>`;
  el.addClass?.("nf-icon-fallback-wrap");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** Obsidian 允许扩展 HTML 字符串；shim 走 DOMParser + 惰性脚本处理。 */
export function sanitizeHTMLToDom(html: string): Promise<DocumentFragment> {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const bad of doc.body.querySelectorAll("script, iframe[src*='javascript:'], object, embed")) bad.remove();
  const frag = document.createDocumentFragment();
  while (doc.body.firstChild) frag.appendChild(doc.body.firstChild);
  return Promise.resolve(frag);
}

export function sanitizeHTML(html: string): string {
  return html;
}