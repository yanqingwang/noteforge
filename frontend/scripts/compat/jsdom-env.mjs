/**
 * harness 的 jsdom 环境引导。
 *
 * 单独成模块的原因：调试单个插件的临时脚本也要用同一份环境。曾经两边各写一份，
 * 结果 harness 补了 fetch 家族、调试脚本没补，测出来的结论是错的
 * —— 「加了 fetch 修复后插件还是崩」就是这么来的。
 */
import { JSDOM } from "jsdom";

export function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  // 全量拷贝 jsdom 的全局：白名单方式会漏掉 HTMLCollection / DOMRect 这类
  // 浏览器里天然存在的构造器，导致插件在 harness 里莫名报错（假阳性）。
  // 已有 undefined 守卫，所以不会覆盖 Node 自己的 setTimeout/process 等。
  for (const k of Object.getOwnPropertyNames(w)) {
    if (k === "window" || k === "self" || k === "globalThis" || k === "top" || k === "parent") continue;
    if (globalThis[k] === undefined) {
      try {
        globalThis[k] = w[k];
      } catch {
        /* 只读全局，忽略 */
      }
    }
  }
  // indexedDB：omisearch 这类插件要建索引。Node/jsdom 没有，给一个最小空实现 ——
  // 属于 harness 环境缺口（真机 webview 有），不算插件兼容问题。
  if (globalThis.indexedDB === undefined) {
    globalThis.indexedDB = {
      open: () => ({
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        result: {
          objectStoreNames: { contains: () => false },
          createObjectStore: () => ({ createIndex: () => ({}), index: () => ({}) }),
          transaction: () => ({ objectStore: () => ({ get: () => ({}), put: () => ({}), delete: () => ({}) }) }),
        },
      }),
      deleteDatabase: () => ({}),
      // omnisearch 会调 indexedDB.databases() 列出已有库
      databases: async () => [],
    };
  }
  // matchMedia：colored-text 等插件读 prefers-color-scheme。jsdom 不实现，按暗色回答。
  if (typeof w.matchMedia !== "function") {
    w.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    });
    globalThis.matchMedia = w.matchMedia;
  }
  if (globalThis.IDBKeyRange === undefined) {
    globalThis.IDBKeyRange = { bound: () => ({}), lowerBound: () => ({}), upperBound: () => ({}), only: () => ({}) };
  }
  // fetch 家族挂到 window 上：内置 SDK 的插件（Azure SDK → remotely-save 等）会做
  //   var g = window; g.fetch && (t.default = g.fetch.bind(g)); t.Headers = g.Headers;
  // jsdom 的 window 没有 fetch → t 变成 undefined → "setting 'Headers'" 直接崩。
  // 真机（WebKitGTK）是有 fetch 的，所以这是 harness 环境缺口，不是兼容缺口。
  for (const k of ["fetch", "Headers", "Request", "Response", "FormData", "Blob", "AbortController", "ReadableStream"]) {
    if (w[k] === undefined && globalThis[k] !== undefined) {
      try {
        w[k] = globalThis[k];
      } catch {
        /* 只读就跳过 */
      }
    }
  }
  if (typeof w.self === "undefined") w.self = w;

  // 前面挂在 globalThis 上的垫片要同步到 window：插件在 webview 里是当 window 全局用的，
  // 只挂 globalThis 会让 window.fetch 有了、window.indexedDB 还是 undefined。
  for (const k of ["indexedDB", "IDBKeyRange", "trustedTypes", "matchMedia"]) {
    if (w[k] === undefined && globalThis[k] !== undefined) {
      try {
        w[k] = globalThis[k];
      } catch {
        /* 只读就跳过 */
      }
    }
  }

  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.requestAnimationFrame = w.requestAnimationFrame?.bind(w) ?? ((cb) => setTimeout(() => cb(Date.now()), 16));
  globalThis.cancelAnimationFrame = w.cancelAnimationFrame?.bind(w) ?? clearTimeout;
  globalThis.getComputedStyle = w.getComputedStyle?.bind(w) ?? (() => ({ getPropertyValue: () => "" }));
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.scrollTo ??= () => undefined;
  // Node 里没有 self / XMLSerializer / Image，jsdom 的 window 上有
  globalThis.self ??= globalThis;
  globalThis.XMLSerializer ??= w.XMLSerializer ?? class {
    serializeToString() {
      return "";
    }
  };
  globalThis.Image ??= w.Image ?? class {};
  globalThis.XPathResult ??= w.XPathResult ?? { ANY_TYPE: 0 };
  globalThis.DOMParser ??= w.DOMParser;
  // jsdom 没有 Worker。真机 webview 有，这里给一个不做事但可构造的桩，
  // 避免「环境缺 API」被误记成插件不兼容。
  globalThis.Worker ??= class WorkerStub {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  };
  globalThis.Blob ??= class BlobStub {
    constructor(parts = []) {
      this.parts = parts;
      this.size = parts.join("").length;
    }
    text() {
      return Promise.resolve(this.parts.join(""));
    }
  };
  globalThis.URL.createObjectURL ??= () => "blob:noteforge-compat/0";
  globalThis.URL.revokeObjectURL ??= () => undefined;
  globalThis.alert ??= () => undefined;
  globalThis.confirm ??= () => true;
  // jsdom 没有 localStorage 之外的隔离，插件常用它存状态
  if (!globalThis.localStorage) {
    const m = new Map();
    globalThis.localStorage = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
  }
  return dom;
}
