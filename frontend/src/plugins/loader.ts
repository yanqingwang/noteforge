/**
 * Obsidian 插件的 CommonJS 加载器。
 *
 * Obsidian 插件由 esbuild 打成 `format: "cjs"` + `external: ["obsidian","electron",
 * "@codemirror/*","@lezer/*", ...node 内建]`，产物里就是 `require("obsidian")`。
 * 浏览器里要执行它，只能自己拼一个 module/require 作用域（等价于 Electron 的
 * sandboxed require）。这是兼容 Obsidian 插件的必经一步，不是可选项。
 */

import { base64ToBytes, bytesToBase64 } from "./obsidian/types";

export interface RequireEntry {
  [exportName: string]: unknown;
}
export interface EvaluateOptions {
  filename: string;
  /** 模块名 → 导出表 */
  requireMap: Record<string, RequireEntry>;
  /** 记录每个被 require 的模块名（诊断用） */
  onRequire?: (name: string) => void;
}

export interface EvaluateResult {
  exports: Record<string, unknown>;
  /** 插件的默认导出（Obsidian 要求导出类） */
  defaultExport: unknown;
  /** 被 require 但没有提供实现的模块名 */
  unresolved: string[];
  /** require 的完整依赖图（模块名 → 实际提供方） */
  required: Array<{ name: string; provided: boolean }>;
  error?: { message: string; stack?: string; phase: "evaluate" };
}

/** 宿主真实平台信息。应用启动后用 `setHostPlatform()` 注入（来自 Rust `host_os`）。 */
export interface HostPlatform {
  /** Node 风格：win32 / linux / darwin */
  os: string;
  arch: string;
  homedir: string;
}

// 模块求值时先估一个默认：真 Node（harness）能拿到真实值；webview 里没有 process，先按 linux，
// 之后由应用调用 setHostPlatform() 覆盖。
let hostPlatform: HostPlatform = (() => {
  const p = (globalThis as unknown as { process?: { platform?: string; arch?: string; env?: Record<string, string | undefined>; versions?: { node?: string } } }).process;
  const real = !!p && !!p.versions?.node && typeof p.platform === "string";
  const os = real ? p!.platform! : "linux";
  const arch = real ? (p!.arch ?? "x64") : "x64";
  const env = p?.env ?? {};
  const homedir = os === "win32" ? (env.USERPROFILE ?? "C:\\Users\\Default") : (env.HOME ?? "/home/user");
  return { os, arch, homedir };
})();

export function setHostPlatform(p: Partial<HostPlatform>): void {
  hostPlatform = { ...hostPlatform, ...p };
}

export function getHostPlatform(): HostPlatform {
  return hostPlatform;
}

/** 提供全局 shim：插件常假定 node 环境（process/global/Buffer）。 */
export function installNodeGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.global) g.global = g;
  if (!g.process) {
    g.process = {
      env: { NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1" },
      // 用 getter：setHostPlatform() 之后立刻生效，避免读到过期的硬编码值
      get platform() { return hostPlatform.os; },
      get arch() { return hostPlatform.arch; },
      version: "v22.0.0",
      versions: { node: "22.0.0", electron: "0.0.0" },
      argv: [],
      cwd: () => (hostPlatform.os === "win32" ? "C:\\" : "/"),
      nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
    };
  }
  if (!g.Buffer) {
    // 极小 Buffer 垫片：插件多只用 concat/utf8/base64 转换，完整 polyfill 不必要
    const B = {
      from(s: string, enc?: string): Uint8Array {
        return enc === "base64" ? base64ToBytes(s) : new TextEncoder().encode(s);
      },
      isBuffer(x: unknown): boolean {
        return x instanceof Uint8Array;
      },
      alloc(n: number): Uint8Array {
        return new Uint8Array(n);
      },
      concat(list: Uint8Array[]): Uint8Array {
        const total = list.reduce((a, b) => a + b.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const b of list) {
          out.set(b, o);
          o += b.length;
        }
        return out;
      },
      toString(b: Uint8Array, enc?: string): string {
        return enc === "base64" ? bytesToBase64(b) : new TextDecoder().decode(b);
      },
    };
    g.Buffer = B;
  }
  // 非跨源隔离环境（Tauri webview 默认没有 COOP/COEP）里没有 SharedArrayBuffer。
  // 不少打包进插件的库会在**模块顶层无守卫地** `new Int32Array(new SharedArrayBuffer(4))`
  // 当 4 字节暂存/同步量用（Copilot 就这样），一句就整包加载失败。
  // 用 ArrayBuffer 顶替：满足特性探测与「当缓冲用」的场景（Atomics 的非 wait/notify 操作
  // 在普通 ArrayBuffer 上也合法）；真·跨线程共享仍然不可用——那种插件本来就跑不起来。
  if (!g.SharedArrayBuffer && typeof ArrayBuffer !== "undefined") {
    g.SharedArrayBuffer = ArrayBuffer;
  }
}

/** 把插件 main.js 当 CJS 执行一遍。 */
export function evaluatePlugin(code: string, opts: EvaluateOptions): EvaluateResult {
  installNodeGlobals();
  // window.require 与插件内的 require 用同一张表（否则插件拿到的模块集合不一样）
  installWindowRequire(opts.requireMap);

  const required: Array<{ name: string; provided: boolean }> = [];
  const unresolved: string[] = [];

  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  const dirname = opts.filename.replace(/\/[^/]*$/, "");

  const requireFn = (name: string): RequireEntry => {
    required.push({ name, provided: Object.prototype.hasOwnProperty.call(opts.requireMap, name) });
    if (!opts.requireMap[name]) {
      unresolved.push(name);
      // 返回可抛错的空壳，让插件在真正用到时才报错，错误信息更接近真实场景
      const stub = new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "__esModule") return true;
            throw new Error(`noteforge 未提供模块 "${name}" 的导出 "${String(prop)}"`);
          },
        },
      );
      return stub as RequireEntry;
    }
    opts.onRequire?.(name);
    return opts.requireMap[name];
  };
  (requireFn as unknown as { resolve?: unknown }).resolve = (name: string) => name;

  let result: EvaluateResult = { exports: moduleObj.exports, defaultExport: undefined, unresolved, required };

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
      "require",
      "module",
      "exports",
      "__filename",
      "__dirname",
      `${code}\n//# sourceURL=nf-plugin://${opts.filename}`,
    ) as (
      r: unknown,
      m: unknown,
      e: unknown,
      f: string,
      d: string,
    ) => void;
    factory(requireFn, moduleObj, moduleObj.exports, opts.filename, dirname);
  } catch (err) {
    result = {
      exports: moduleObj.exports,
      defaultExport: undefined,
      unresolved,
      required,
      error: {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        phase: "evaluate",
      },
    };
    return result;
  }

  const exports = moduleObj.exports;
  const def = (exports as { default?: unknown }).default;
  result.exports = exports;
  result.defaultExport = def ?? exports;
  return result;
}

/** node 内建模块的最小桩：够插件在浏览器里跑常见路径。 */
/** 受限的 git 执行钩子：应用里接 `invoke("run_git")`；harness 无宿主时保持不支持。 */
export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type GitRunner = (args: string[]) => Promise<GitResult>;

let runGitImpl: GitRunner | null = null;
export function setRunGit(fn: GitRunner | null): void {
  runGitImpl = fn;
}

const CHILD_UNSUPPORTED = "noteforge 沙箱不支持 child_process（仅允许执行 git）";

/**
 * `child_process` 的最小实现：只允许跑 `git`（走宿主注入的 runGit），其余一律报不支持。
 * 目的：让 `vault-force-sync` 这类用 `execFile("git", …)` 的插件能在沙箱里工作。
 */
function createChildProcess(): RequireEntry {
  const noopChild = () => ({ on(): unknown { return this; }, kill(): void {}, pid: 0, stdout: null, stderr: null });
  const finish = (cb: unknown, run: () => Promise<GitResult>): void => {
    void run().then(
      (r) => {
        if (typeof cb === "function") {
          cb(
            r.status === 0 ? null : Object.assign(new Error(`git exited with code ${r.status}`), { code: r.status }),
            r.stdout,
            r.stderr,
          );
        }
      },
      (e: unknown) => {
        if (typeof cb === "function") cb(e instanceof Error ? e : new Error(String(e)), "", String((e as Error)?.message ?? e));
      },
    );
  };
  const execFile = (file: unknown, argsOrOpts?: unknown, optsOrCb?: unknown, maybeCb?: unknown) => {
    const args = Array.isArray(argsOrOpts) ? (argsOrOpts as unknown[]).map(String) : [];
    const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
    const exe = String(file ?? "").replace(/\.exe$/i, "").split(/[\\/]/).pop();
    if (exe !== "git" || !runGitImpl) throw new Error(CHILD_UNSUPPORTED);
    finish(cb, () => runGitImpl!(args));
    return noopChild();
  };
  const exec = (cmd: unknown, optsOrCb?: unknown, maybeCb?: unknown) => {
    const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
    const m = String(cmd ?? "").trim().match(/^git\b([\s\S]*)$/);
    if (!m || !runGitImpl) throw new Error(CHILD_UNSUPPORTED);
    const args = (m[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((s) => s.replace(/^["']|["']$/g, ""));
    finish(cb, () => runGitImpl!(args));
    return noopChild();
  };
  const mod: Record<string, unknown> = { execFile, exec, __esModule: false };
  return new Proxy(mod, {
    get(t, p) {
      const key = p as string;
      if (key in t) return t[key];
      if (key === "__esModule") return false;
      // spawn / fork / execSync 等一律不支持（调用时抛，保持访问不炸）
      return () => {
        throw new Error(CHILD_UNSUPPORTED);
      };
    },
  }) as RequireEntry;
}

export function createNodeBuiltins(): Record<string, RequireEntry> {
  const pathImpl = {
    join: (...p: string[]) => p.filter(Boolean).join("/").replace(/\/+/g, "/"),
    resolve: (...p: string[]) => p.filter(Boolean).join("/"),
    basename: (p: string, ext?: string) => {
      const b = p.split("/").pop() ?? p;
      return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
    },
    dirname: (p: string) => p.replace(/\/[^/]*$/, ""),
    extname: (p: string) => {
      const b = p.split("/").pop() ?? p;
      const i = b.lastIndexOf(".");
      return i > 0 ? b.slice(i) : "";
    },
    relative: (_from: string, to: string) => to.replace(/^.*?\/(?=[^/]+\/?$)/, ""),
    isAbsolute: (p: string) => p.startsWith("/"),
    normalize: (p: string) => p.replace(/\/+/g, "/"),
    sep: "/",
    posix: { sep: "/" },
  };
  const urlImpl = {
    fileURLToPath: (u: string | URL) => decodeURIComponent(String(u).replace(/^file:\/\//, "")),
    pathToFileURL: (p: string) => new URL(`file://${p.startsWith("/") ? p : `/${p}`}`),
    parse: (s: string) => new URL(s),
  };
  const eventsImpl = createEventsModule();
  const utilImpl = {
    format: (f: string, ...a: unknown[]) => f.replace(/%s/g, () => String(a.shift())),
    inspect: (v: unknown) => JSON.stringify(v),
    promisify: <T>(fn: T) => fn,
    // Node 的 util.deprecate：包一层，首次调用时打一次弃用警告。
    // 内置 debug 包的 destroy() 会用（`require("util").deprecate(...)`），
    // 缺了它插件在模块求值阶段就抛 "di.deprecate is not a function"
    //（consistent-attachments-and-links 就是这么挂的）。
    deprecate: (fn: (...a: unknown[]) => unknown, msg: string) => {
      let warned = false;
      return (...a: unknown[]) => {
        if (!warned) {
          warned = true;
          console.warn(`[弃用] ${msg}`);
        }
        return fn(...a);
      };
    },
    types: {
      isDate: (v: unknown) => v instanceof Date,
      isRegExp: (v: unknown) => v instanceof RegExp,
      isPromise: (v: unknown) => typeof (v as { then?: unknown })?.then === "function",
    },
    inherits: (ctor: unknown, superCtor: unknown) => {
      const ctorProto = (ctor as { prototype: object }).prototype;
      const superProto = (superCtor as { prototype: object }).prototype;
      Object.setPrototypeOf(ctorProto, superProto);
      Object.assign(ctor as object, superCtor as object);
    },
  };
  const tty = { isatty: () => false };
  return {
    path: pathImpl,
    url: urlImpl,
    events: eventsImpl,
    util: utilImpl,
    os: {
      platform: () => hostPlatform.os,
      arch: () => hostPlatform.arch,
      homedir: () => hostPlatform.homedir,
      tmpdir: () =>
        hostPlatform.os === "win32"
          ? ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TEMP ?? "C:\\Temp")
          : "/tmp",
      get EOL() {
        return hostPlatform.os === "win32" ? "\r\n" : "\n";
      },
    },
    // fs 整体禁用（插件应走 app.vault），但**属性访问不能抛错**：
    // obsidian-git 在模块顶层就取 `require("fs/promises")`，抛错会让它整包加载失败
    // （表现为 “Class extends value undefined”，根因完全看不出来）。
    // 所以：访问返回「调用即 reject」的函数，interop 位返回良性值。
    fs: disabledNodeModule("fs", "请用 app.vault 的读写 API"),
    "fs/promises": disabledNodeModule("fs/promises", "请用 app.vault 的读写 API"),
    "node:fs": disabledNodeModule("node:fs", "请用 app.vault 的读写 API"),
    "node:fs/promises": disabledNodeModule("node:fs/promises", "请用 app.vault 的读写 API"),
    child_process: createChildProcess(),
    crypto: {
      randomUUID: () => crypto.randomUUID(),
      getRandomValues: <T extends ArrayBufferView | null>(a: T): T => {
        (globalThis.crypto.getRandomValues as (x: ArrayBufferView) => ArrayBufferView)(
          a as unknown as ArrayBufferView,
        );
        return a;
      },
    },
    // async_hooks：Copilot 用 AsyncLocalStorage 做请求上下文传递
    async_hooks: {
      AsyncLocalStorage: class {
        private store: unknown;
        getStore(): unknown { return this.store; }
        run<T>(store: unknown, cb: (...a: unknown[]) => T, ...args: unknown[]): T {
          const prev = this.store;
          this.store = store;
          try {
            return cb(...args);
          } finally {
            this.store = prev;
          }
        }
        enterWith(store: unknown): void { this.store = store; }
        exit<T>(cb: (...a: unknown[]) => T, ...args: unknown[]): T { return cb(...args); }
        disable(): void { this.store = undefined; }
      },
      createHook: () => ({ enable(): void {}, disable(): void {} }),
      AsyncResource: class { constructor(..._a: unknown[]) {} },
      __esModule: false,
    },
    // 插件会 `require("process")`（Copilot 就取 process.cwd）——转出全局 shim
    process: ((): RequireEntry => {
      const g = globalThis as unknown as { process?: Record<string, unknown> };
      const p = g.process ?? (g.process = {});
      if (typeof p.cwd !== "function") p.cwd = () => (hostPlatform.os === "win32" ? "C:\\" : "/");
      if (!p.env) p.env = {};
      return p as RequireEntry;
    })(),
    tty,
    // zlib：插件用 brotli/gzip 解压内嵌资源，给出 Node 同名函数的薄实现
    zlib: {
      brotliDecompressSync: (b: Uint8Array) => new Uint8Array(b),
      brotliCompressSync: (b: Uint8Array) => new Uint8Array(b),
      gunzipSync: (b: Uint8Array) => new Uint8Array(b),
      gzipSync: (b: Uint8Array) => new Uint8Array(b),
      inflateSync: (b: Uint8Array) => new Uint8Array(b),
      deflateSync: (b: Uint8Array) => new Uint8Array(b),
      __esModule: false,
    },
    stream: {},
    buffer: {},
    timers: { setTimeout, setInterval, clearTimeout, clearInterval },
    console: console as unknown as RequireEntry,
    // xhr 同步封装：浏览器里同步 XHR 早已禁用，用 fetch 近似（返回对象而非抛错）
    xmlhttprequest: {
      XMLHttpRequest: class {
        status = 0;
        readyState = 0;
        onreadystatechange: (() => void) | null = null;
        open(_m: string, _url: string, _async = true): void {
          /* 记录请求目标即可，实际请求交给宿主网络栈 */
        }
        setRequestHeader(): void {}
        send(): void {
          this.readyState = 4;
          this.status = 599;
          this.onreadystatechange?.();
        }
        abort(): void {}
      },
      __esModule: false,
    },
  };
}

/** 禁用的 node 模块：属性访问不抛错，调用即 reject（错误信息指向 vault API）。 */
/**
 * 同步版 fs API：调用即抛会让插件整包加载失败（症状是"某个方法是 undefined"，
 * 根因完全看不出来），但这些 API 的返回值本来就只是"有没有/多大"这类良性值。
 * 插件在 onload 里问一句 existsSync 就崩太不值当 —— 给良性默认值，
 * 真要读写时它自然会去用 app.vault，失败会给出明确提示。
 */
const FS_SYNC_DEFAULTS: Record<string, unknown> = {
  existsSync: false,
  readFileSync: "",
  writeFileSync: undefined,
  appendFileSync: undefined,
  mkdirSync: undefined,
  unlinkSync: undefined,
  rmSync: undefined,
  readdirSync: [] as string[],
  statSync: { isFile: () => false, isDirectory: () => false, size: 0, mtimeMs: 0 },
  lstatSync: { isFile: () => false, isDirectory: () => false, size: 0, mtimeMs: 0 },
  realpathSync: "",
};

function disabledNodeModule(name: string, hint: string): RequireEntry {
  const reject = (fn: string) => () => {
    throw new Error(`noteforge 沙箱不支持 ${name}.${fn}（${hint}）`);
  };
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "__esModule") return false;
        if (prop === "default") return undefined;
        // 同步 API 返回良性默认值（见 FS_SYNC_DEFAULTS 的说明）
        if (prop in FS_SYNC_DEFAULTS) {
          const v = FS_SYNC_DEFAULTS[prop];
          return typeof v === "function" ? v : () => v;
        }
        return reject(String(prop));
      },
      has: () => true,
    },
  ) as RequireEntry;
}

function createEventsModule(): RequireEntry {
  class EventEmitter {
    private handlers = new Map<string, Set<(...a: unknown[]) => void>>();
    on(ev: string, cb: (...a: unknown[]) => void): this {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)?.add(cb);
      return this;
    }
    once(ev: string, cb: (...a: unknown[]) => void): this {
      const wrapper = (...a: unknown[]) => {
        this.off(ev, wrapper);
        cb(...a);
      };
      return this.on(ev, wrapper);
    }
    off(ev: string, cb: (...a: unknown[]) => void): this {
      this.handlers.get(ev)?.delete(cb);
      return this;
    }
    removeListener(ev: string, cb: (...a: unknown[]) => void): this {
      return this.off(ev, cb);
    }
    emit(ev: string, ...a: unknown[]): boolean {
      const set = this.handlers.get(ev);
      if (!set) return false;
      for (const cb of [...set]) cb(...a);
      return true;
    }
    removeAllListeners(ev?: string): this {
      if (ev) this.handlers.delete(ev);
      else this.handlers.clear();
      return this;
    }
    setMaxListeners(): this {
      return this;
    }
  }
  // Node 在 EventEmitter 类上还有静态成员；Copilot 会读取/打补丁 `EventEmitter.setMaxListeners`，
  // 缺了它就报 "Cannot read properties of undefined (reading 'Symbol(...setMaxListeners-shim)')"。
  const EE = EventEmitter as unknown as Record<string, unknown>;
  const oncePromise = (emitter: { once?: (ev: string, cb: (...a: unknown[]) => void) => unknown }, ev: string) =>
    new Promise<unknown[]>((resolve) => emitter.once?.(ev, (...a: unknown[]) => resolve(a)));
  EE.defaultMaxListeners = 10;
  EE.setMaxListeners = () => EventEmitter;
  EE.getEventListeners = () => [];
  EE.once = oncePromise;
  const mod: Record<string, unknown> = { EventEmitter, default: EventEmitter };
  mod.setMaxListeners = EE.setMaxListeners;
  mod.getEventListeners = EE.getEventListeners;
  mod.defaultMaxListeners = 10;
  mod.once = oncePromise;
  return mod as RequireEntry;
}

/**
 * node: 前缀别名。esbuild 只把 `fs` 这类裸名标为 external，但插件源码里
 * 也常见 `require("node:fs")`（尤其被 vite/rollup 打包过一次的产物），
 * 两种写法都要能解析到同一份实现。
 */
/**
 * 把 `window.require` / `globalThis.require` 装上（Obsidian 也提供）。
 *
 * 插件会合法地用 `window.require("node:crypto")`、`window.require("electron")`
 * 这类全局 require —— obsidian-importer 就是 `Platform.isDesktopApp ? window.require("node:crypto") : null`
 * 然后调 randomUUID。缺了它轻则功能降级，重则整包求值失败。
 */
export function installWindowRequire(map?: Record<string, RequireEntry>): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.require && g.__nfRequireInstalled) return;
  const resolved = withNodePrefixAliases(map ?? createNodeBuiltins());
  const req = (name: string): RequireEntry => {
    if (resolved[name]) return resolved[name];
    if (name === "obsidian") {
      throw new Error("window.require(\"obsidian\") 不可用：请用 import/require 的 obsidian 模块");
    }
    const stub = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "__esModule") return false;
          if (prop === "default") return undefined;
          return () => {
            throw new Error(`noteforge 沙箱未提供模块 "${name}" 的导出 "${String(prop)}"`);
          };
        },
        has: () => true,
      },
    ) as RequireEntry;
    return stub;
  };
  g.require = req;
  g.__nfRequireInstalled = true;
  const win = (globalThis.window ?? undefined) as unknown as Record<string, unknown> | undefined;
  if (win) win.require = req;
}

export function withNodePrefixAliases(map: Record<string, RequireEntry>): Record<string, RequireEntry> {
  const out: Record<string, RequireEntry> = { ...map };
  for (const name of Object.keys(map)) out[`node:${name}`] = map[name];
  return out;
}

/** Obsidian 插件常用 electron（多数只为 isMacOS/isWin 之类） */
export function createElectronStub(): RequireEntry {
  const remote = {
    app: { getPath: (k: string) => (hostPlatform.os === "win32" ? `C:\\Temp\\${k}` : `/tmp/${k}`), getVersion: () => "0.0.0", getName: () => "NoteForge" },
    shell: {
      openExternal: async (url: string) => {
        window.open(url, "_blank");
      },
      showItemInFolder: async () => undefined,
    },
    clipboard: {
      writeText: async (t: string) => navigator.clipboard?.writeText(t),
      readText: async () => navigator.clipboard?.readText() ?? "",
    },
  };
  return {
    app: remote.app,
    shell: remote.shell,
    clipboard: remote.clipboard,
    remote,
    ipcRenderer: { on: () => undefined, send: () => undefined, invoke: async () => undefined },
    get isMacOS() { return hostPlatform.os === "darwin"; },
    get isWin() { return hostPlatform.os === "win32"; },
    get isLinux() { return hostPlatform.os === "linux"; },
  };
}