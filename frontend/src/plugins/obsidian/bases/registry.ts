/**
 * Bases 宿主注册表。
 *
 * 插件侧只看到 `BasesView` / `BasesViewConfig` 这些类，看不到数据从哪来。
 * 数据由宿主（真机 / harness 共用同一份查询引擎）通过 `_nfBind()` 注入：
 * 宿主调 factory 拿到实例 → 绑定 config/data/allProperties → 调 onDataUpdated()。
 *
 * 这也是为什么 `BasesView` 虽然是给插件继承的，却带着一个 `nf` 前缀的内部方法：
 * 不能占用插件可能用到的名字。
 */

import { BUILTIN_VIEW_TYPES } from "./config";
import { BasesEntry, BasesEntryGroup, BasesQueryResult, BasesView, BasesViewConfig, QueryController, type BasesOption, type BasesOptionGroup, type BasesViewRegistration } from "./api";
import { propertyValue, runQuery, summaryValue, type QueryOutcome } from "./query";
import type { FileApi } from "./expr/file-api";
import { Value } from "./expr/values";
import type { BasesConfigFile, BasesConfigFileView } from "./config";
import type { TFile } from "../items";

/** 视图需要的宿主能力 */
export interface BasesHost {
  fileApi: FileApi;
  /** 所有文件路径（候选数据集） */
  files(): string[];
  /** 注册插件自定义视图 */
  register(viewId: string, reg: BasesViewRegistration): boolean;
  /** 视图类型清单（内置 + 插件注册的），给布局选择器用 */
  viewTypes(): BasesViewTypeInfo[];
  /** 打开某个 base 文件（内置视图用） */
  openBase(path: string, viewName?: string): Promise<void>;
  /** 新建一个文件（BasesView.createFileForView 用） */
  createFile(opts: { baseFileName?: string; frontmatter?: Record<string, unknown>; path?: string }): Promise<string>;
}

export interface BasesViewTypeInfo {
  type: string;
  name: string;
  icon: string;
  builtin: boolean;
  /** 插件视图可自定义的选项（内置视图没有） */
  options?: (config: BasesViewConfig) => (BasesOption | BasesOptionGroup)[];
}

/** 已注册的插件视图 */
interface Registered {
  type: string;
  reg: BasesViewRegistration;
  pluginId: string;
}

class BasesHostImpl implements BasesHost {
  fileApi: FileApi;
  filesFn: () => string[] = () => [];
  openBaseFn: (path: string, viewName?: string) => Promise<void> = async () => {};
  createFileFn: (opts: { baseFileName?: string; frontmatter?: Record<string, unknown>; path?: string }) => Promise<string> = async () => "";

  private registered = new Map<string, Registered>();

  constructor(fileApi: FileApi) {
    this.fileApi = fileApi;
  }

  files(): string[] {
    return this.filesFn();
  }

  register(viewId: string, reg: BasesViewRegistration, pluginId = "host"): boolean {
    if (this.registered.has(viewId)) return false;
    this.registered.set(viewId, { type: viewId, reg, pluginId });
    return true;
  }

  unregister(viewId: string): void {
    this.registered.delete(viewId);
  }

  clear(): void {
    this.registered.clear();
  }

  lookup(viewId: string): BasesViewRegistration | null {
    return this.registered.get(viewId)?.reg ?? null;
  }

  pluginIdOf(viewId: string): string | null {
    return this.registered.get(viewId)?.pluginId ?? null;
  }

  viewTypes(): BasesViewTypeInfo[] {
    const builtin: BasesViewTypeInfo[] = BUILTIN_VIEW_TYPES.map((t) => ({
      type: t,
      name: t === "table" ? "Table" : "List",
      icon: t === "table" ? "lucide-table" : "lucide-list",
      builtin: true,
    }));
    const custom: BasesViewTypeInfo[] = [...this.registered.values()].map((r) => ({
      type: r.type,
      name: r.reg.name,
      icon: r.reg.icon ?? "lucide-layout-grid",
      builtin: false,
      options: r.reg.options,
    }));
    return [...builtin, ...custom];
  }

  async openBase(path: string, viewName?: string): Promise<void> {
    await this.openBaseFn(path, viewName);
  }

  async createFile(opts: { baseFileName?: string; frontmatter?: Record<string, unknown>; path?: string }): Promise<string> {
    return this.createFileFn(opts);
  }
}

let host: BasesHostImpl | null = null;

/** 拿到（或建立）Bases 宿主。真机与 harness 都在加载插件前调用一次。 */
export function ensureBasesHost(fileApi: FileApi): BasesHostImpl {
  if (!host) host = new BasesHostImpl(fileApi);
  else host.fileApi = fileApi;
  return host;
}

export function currentBasesHost(): BasesHostImpl | null {
  return host;
}

/** 测试用：重置注册表 */
export function resetBasesHost(): void {
  host = null;
}

/** 给 TFile 造一个 entry 需要的最小文件句柄（harness 里没有真 TFile 也能用） */
function fileHandle(path: string): TFile {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : "",
    stat: { ctime: 0, mtime: 0, size: 0 },
    vault: null,
    parent: null,
  } as unknown as TFile;
}

export interface MountedView {
  /** 插件视图实例（BasesView 子类） */
  view: BasesView;
  controller: QueryController;
  /** 重新求值并重绘 */
  refresh(): void;
}

/**
 * 把一个 base 在某个视图下跑起来，挂载成 BasesView 实例。
 *
 * 内置视图（table/list）由 noteforge 自己渲染，不会走到这里；
 * 这个函数专门给插件注册的视图类型用。
 */
export function mountBasesView(opts: {
  viewType: string;
  config: BasesConfigFile;
  view: BasesConfigFileView;
  containerEl: HTMLElement;
  app: unknown;
  selfPath: string;
  fileApi: FileApi;
  /** 内置视图插件自己的默认值（options 声明的 default） */
  optionDefaults?: Record<string, unknown>;
  /** 视图状态变更回调（写回 .base 那一期用） */
  onConfigSet?: (key: string, value: unknown) => void;
}): MountedView | null {
  const found = currentBasesHost()?.lookup(opts.viewType);
  if (!found) return null;
  // 用 const 承接（而不是 let/可选链结果），收窄才能带进下面的闭包里
  const reg: BasesViewRegistration = found;

  const outcome = runQuery(
    { config: opts.config, fileApi: opts.fileApi, files: currentBasesHost()?.files() ?? [], selfPath: opts.selfPath },
    opts.view,
  );
  const config = buildViewConfig(opts, outcome, reg);
  const result = buildQueryResult(opts, outcome);

  const controller = new QueryController(opts.viewType, () => refresh());
  let view: BasesView | null = null;
  try {
    view = reg.factory(controller, opts.containerEl);
  } catch (e) {
    console.error(`[bases] 插件视图 ${opts.viewType} 的 factory 抛错`, e);
    return null;
  }
  if (!view) return null;
  view.app = opts.app;
  view.config = config;
  view.data = result;
  view.allProperties = outcome.allProperties;
  bindBasesView(view, opts);
  try {
    view.onDataUpdated();
  } catch (e) {
    console.error(`[bases] 插件视图 ${opts.viewType} 的 onDataUpdated 抛错`, e);
  }

  function refresh(): void {
    const next = runQuery(
      { config: opts.config, fileApi: opts.fileApi, files: currentBasesHost()?.files() ?? [], selfPath: opts.selfPath },
      opts.view,
    );
    view!.config = buildViewConfig(opts, next, reg);
    view!.data = buildQueryResult(opts, next);
    view!.allProperties = next.allProperties;
    try {
      view!.onDataUpdated();
    } catch (e) {
      console.error(`[bases] 插件视图 ${opts.viewType} 的 onDataUpdated 抛错`, e);
    }
  }

  return { view, controller, refresh };
}

function buildViewConfig(
  opts: {
    view: BasesConfigFileView;
    selfPath: string;
    fileApi: FileApi;
    onConfigSet?: (key: string, value: unknown) => void;
  },
  outcome: QueryOutcome,
  reg: BasesViewRegistration,
): BasesViewConfig {
  const defaults: Record<string, unknown> = {};
  // options() 里声明的 default 作为缺省值（官方：用户填的值自动存进 .base）
  for (const item of collectOptions(reg)) {
    if (item.default !== undefined) defaults[item.key] = item.default;
  }
  const cfg = new BasesViewConfig({
    view: opts.view,
    outcome,
    defaults,
    fileApi: opts.fileApi,
    selfPath: opts.selfPath,
    onSet: opts.onConfigSet,
  });
  return cfg;
}

/** options 可能返回分组，展平 */
function collectOptions(reg: BasesViewRegistration): BasesOption[] {
  if (!reg.options) return [];
  let out: BasesOption[] = [];
  try {
    for (const item of reg.options(cfgForOptions)) {
      if (item && Array.isArray((item as BasesOptionGroup).options)) out.push(...(item as BasesOptionGroup).options);
      else out.push(item as BasesOption);
    }
  } catch (e) {
    console.warn("[bases] options() 抛错", e);
  }
  return out;
}

// options(config) 的实参只在取 default 时用不到内容，给个空壳即可
const cfgForOptions = new BasesViewConfig({
  view: { type: "", name: "" },
  outcome: { rows: [], matched: [], allProperties: [], errors: [] },
  defaults: {},
  fileApi: emptyApi(),
  selfPath: "",
});

function emptyApi(): FileApi {
  return {
    exists: () => false,
    basename: (p) => p.split("/").pop() ?? p,
    folder: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "/"),
    ext: (p) => p.match(/\.([^.]+)$/)?.[1] ?? "",
    size: () => 0,
    ctime: () => new Date(0),
    mtime: () => new Date(0),
    properties: () => ({}),
    hasProperty: () => false,
    tags: () => [],
    links: () => [],
    embeds: () => [],
    backlinks: () => [],
    resolve: (t) => t,
  };
}

function buildQueryResult(opts: { view: BasesConfigFileView; fileApi: FileApi; selfPath: string; config?: BasesConfigFile }, outcome: QueryOutcome): BasesQueryResult {
  const entries = outcome.rows.map((r) => new BasesEntry(fileHandle(r.path), r, outcome));
  const groups = groupEntries(entries, opts.view);
  const result = new BasesQueryResult(entries, outcome.allProperties, groups);
  result.summaryHooks = (es, prop, key) => {
    const rows = es.map((e) => e.queryRow());
    return summaryValue(key, rows, prop, opts.config?.summaries, opts.fileApi, opts.selfPath);
  };
  return result;
}

/**
 * 分组：按 view.groupBy 的属性分桶。
 *
 * `groupOrder` 决定顺序与可见性（`null` 表示"该属性无值的那一组"）；
 * 没写 groupOrder 时按 groupBy.direction 排。
 */
export function groupEntries(entries: BasesEntry[], view: BasesConfigFileView): BasesEntryGroup[] {
  const prop = view.groupBy?.property;
  if (!prop) {
    // 官方：一个无 key 的组装着全部
    return [new BasesEntryGroup(entries)];
  }
  const keyOf = (e: BasesEntry): Value => propertyValue(e.queryRow(), prop);
  const buckets = new Map<string, { key?: Value; entries: BasesEntry[] }>();
  for (const e of entries) {
    const v = keyOf(e);
    const k = v.isEmpty() ? " empty" : `${v.typeName()}:${v.toString()}`;
    let b = buckets.get(k);
    if (!b) {
      b = { entries: [] };
      if (!v.isEmpty()) b.key = v;
      buckets.set(k, b);
    }
    b.entries.push(e);
  }

  const dir = view.groupBy?.direction ?? "ASC";
  const cmp = (a: { key?: Value }, b2: { key?: Value }): number => {
    // 无 key 的组永远排最后（官方：groupOrder 里的 null 那一项）
    if (!a.key) return 1;
    if (!b2.key) return -1;
    return compareGroups(a.key, b2.key) * (dir === "DESC" ? -1 : 1);
  };

  if (view.groupOrder !== undefined) {
    const out: BasesEntryGroup[] = [];
    for (const want of view.groupOrder) {
      if (want === null) {
        const b = buckets.get(" empty");
        if (b) out.push(new BasesEntryGroup(b.entries));
        continue;
      }
      const found = [...buckets.values()].find((b) => b.key?.toString() === want);
      if (found) out.push(new BasesEntryGroup(found.entries, found.key));
    }
    return out;
  }
  return [...buckets.values()].sort(cmp).map((b) => new BasesEntryGroup(b.entries, b.key));
}

function compareGroups(a: Value, b: Value): number {
  const x = a.comparable();
  const y = b.comparable();
  if (typeof x === "number" && typeof y === "number") return x - y;
  const sx = String(x);
  const sy = String(y);
  return sx === sy ? 0 : sx < sy ? -1 : 1;
}

/** 给 BasesView 实例注入宿主能力（createFileForView 用） */
function bindBasesView(view: BasesView, opts: { fileApi: FileApi; selfPath: string }): void {
  view.createFileHook = async (baseFileName, frontmatterProcessor) => {
    const fm: Record<string, unknown> = {};
    frontmatterProcessor?.(fm);
    await currentBasesHost()?.createFile({ baseFileName, frontmatter: fm, path: opts.selfPath });
  };
}
