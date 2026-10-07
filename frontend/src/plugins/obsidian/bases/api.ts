/**
 * Bases 的 Obsidian API 面 —— 插件看到的那一半。
 *
 * 公开声明（obsidian.d.ts 1.13）里这批东西：
 *   BasesView / BasesViewConfig / BasesQueryResult / BasesEntry / BasesEntryGroup
 *   QueryController / BasesOption(s) / parsePropertyId / Plugin.registerBasesView
 *   Value / ValueComponent
 *
 * 两点要注意：
 * - `QueryController` 在公开声明里是**空类**（内部 API），插件实际只靠
 *   BasesView 上的 data/config/allProperties，所以这里给一个最小可用实现。
 * - `BasesViewConfig.get(key)` 读的是**视图自己的状态键**（官方
 *   registerBasesView 的 options 文档：用户填的值自动存进 .base 配置），
 *   所以它就是 view 对象的一个受控视图，options 里的 default 参与读。
 */

import { Component } from "../events";
import type { TFile } from "../items";
import { normalizePropertyId, parsePropertyId, type BasesConfigFileView, type BasesPropertyId, type BasesSortConfig } from "./config";
import { propertyValue, summaryValue, type QueryOutcome, type QueryRow } from "./query";
import type { FileApi } from "./expr/file-api";
import { NULL, Value } from "./expr/values";
import { defaultSummary } from "./query";

/** `Value.renderTo` 的渲染上下文（BasesView.renderTo 传的） */
export interface RenderContext {
  openFile?: (path: string, newLeaf?: boolean) => void;
  sourcePath?: string;
}

/** 视图选项的声明（registerBasesView 的 options() 返回值） */
export type BasesOptionType =
  | "text"
  | "multitext"
  | "toggle"
  | "dropdown"
  | "slider"
  | "file"
  | "folder"
  | "property"
  | "formula";

export interface BasesOption {
  type: BasesOptionType;
  displayName: string;
  key: string;
  default?: unknown;
  description?: string;
  options?: Array<{ value: string; label?: string; description?: string }>;
  placeholder?: string;
  /** slider 专用 */
  min?: number;
  max?: number;
  step?: number;
}

export interface BasesOptionGroup {
  label?: string;
  options: BasesOption[];
}

export type BasesViewFactory = (controller: QueryController, containerEl: HTMLElement) => BasesView;

/** 插件注册自定义视图时给的东西（官方 BasesViewRegistration） */
export interface BasesViewRegistration {
  name: string;
  icon: string;
  factory: BasesViewFactory;
  /** 视图自定义配置项（用户填的值自动存进 .base 的视图状态） */
  options?: (config: BasesViewConfig) => (BasesOption | BasesOptionGroup)[];
}

/**
 * 查询控制器。公开声明是空类，但插件的 factory 签名会拿到它，
 * 给它挂上宿主引用，插件真要用时至少有东西可拿。
 */
export class QueryController {
  /** 所属视图类型（诊断用） */
  viewType: string;
  /** 触发一次重算 */
  onChange: (() => void) | null = null;

  constructor(viewType: string, onChange?: () => void) {
    this.viewType = viewType;
    this.onChange = onChange ?? null;
  }
}

/** 结果集里的一组（groupBy 产出） */
export class BasesEntryGroup {
  key?: Value;
  entries: BasesEntry[];

  constructor(entries: BasesEntry[], key?: Value) {
    this.entries = entries;
    if (key !== undefined) this.key = key;
  }

  /** 官方：该分组是否有分组键（没分组时整个结果集是一个无 key 的组） */
  hasKey(): boolean {
    return this.key !== undefined;
  }
}

/** 结果集的一行（一篇文件） */
export class BasesEntry {
  file: TFile;
  private row: QueryRow;
  private outcome: QueryOutcome;

  constructor(file: TFile, row: QueryRow, outcome: QueryOutcome) {
    this.file = file;
    this.row = row;
    this.outcome = outcome;
  }

  /** 取属性在该行上下文里的求值结果（公式会缓存） */
  getValue(propertyId: BasesPropertyId): Value | null {
    const v = propertyValue(this.row, propertyId);
    return v.typeName() === "null" && v.isEmpty() ? null : v;
  }

  /** 内部用：拿到底层行（汇总/分组要） */
  queryRow(): QueryRow {
    return this.row;
  }

  queryOutcome(): QueryOutcome {
    return this.outcome;
  }
}

/**
 * 视图配置：只清「视图自己往 .base 里塞的状态键」，不碰 type/name/order/sort 这些核心键。
 * 官方明确要求插件别占用核心 Bases 的键，所以边界就划在这里。
 */
const CORE_VIEW_KEYS = new Set([
  "type",
  "name",
  "filters",
  "order",
  "sort",
  "groupBy",
  "groupOrder",
  "limit",
  "summaries",
]);

export class BasesViewConfig {
  name: string;
  private view: BasesConfigFileView;
  private outcome: QueryOutcome;
  private defaults: Record<string, unknown>;
  private onSet: ((key: string, value: unknown) => void) | null;
  private fileApi: FileApi;
  private selfPath: string;

  constructor(opts: {
    view: BasesConfigFileView;
    outcome: QueryOutcome;
    defaults: Record<string, unknown>;
    fileApi: FileApi;
    selfPath: string;
    onSet?: (key: string, value: unknown) => void;
  }) {
    this.view = opts.view;
    this.outcome = opts.outcome;
    this.defaults = opts.defaults;
    this.fileApi = opts.fileApi;
    this.selfPath = opts.selfPath;
    this.onSet = opts.onSet ?? null;
    this.name = opts.view.name;
  }

  /** 读视图的自定义状态键；没写就用 options 里的 default */
  get(key: string): unknown {
    if (Object.prototype.hasOwnProperty.call(this.view, key) && !CORE_VIEW_KEYS.has(key)) {
      return (this.view as Record<string, unknown>)[key];
    }
    return this.defaults[key];
  }

  /**
   * 把视图选项里存的属性名解析成属性 ID（官方签名）。
   *
   * 选项值可能是裸名（`status`）也可能已经是完整 ID（`file.ext`）；
   * 裸名按官方规则算 note 属性。
   */
  getAsPropertyId(key: string): BasesPropertyId | null {
    if (!key) return null;
    if (key.includes(".")) return key;
    const v = this.get(key);
    if (typeof v !== "string" || !v) return null;
    return v.includes(".") ? v : `note.${v}`;
  }

  /**
   * 官方：按公式名求值（视图 options 里带 formula 类型时用）。
   * 公式是逐行算的，这里给结果集里第一个非空值 —— 视图选项是全局一个值，
   * 没有"某一行的公式"这个概念。
   */
  getEvaluatedFormula(_view: unknown, key: string): Value {
    for (const row of this.outcome.rows) {
      const v = propertyValue(row, `formula.${key}`);
      if (!v.isEmpty()) return v;
    }
    return NULL;
  }

  set(key: string, value: unknown): void {
    if (CORE_VIEW_KEYS.has(key)) {
      // 核心键只能通过 .base 文件本身改（写回是后续一期的事）
      return;
    }
    (this.view as Record<string, unknown>)[key] = value;
    this.onSet?.(key, value);
  }

  /** 属性显示顺序（视图的 order；没写就按官方习惯给一组默认列） */
  getOrder(): BasesPropertyId[] {
    if (this.view.order) return this.view.order;
    const notes = this.outcome.allProperties.filter((p) => p.startsWith("note.")).sort();
    return ["file.name", "file.mtime", ...notes.slice(0, 6)];
  }

  /** 排序配置（.base 里的 sort: 列表） */
  getSort(): BasesSortConfig[] {
    return this.view.sort ?? [];
  }

  /** 列头显示名：properties 里配的 displayName 优先，否则人化属性名 */
  getDisplayName(propertyId: BasesPropertyId): string {
    const configured = this.lookupDisplayName(propertyId);
    if (configured) return configured;
    const { type, name } = parsePropertyId(propertyId);
    if (type === "file") return humanizeFileProperty(name);
    return humanize(name);
  }

  /**
   * 找配置里的显示名。
   *
   * `.base` 里 `properties:` 的键三种写法都要认：`note.status`、`status`、
   * 以及带点的 `file.properties.x`。官方例子写的是裸名（`status:`），
   * 而列的顺序里写的是完整 ID（`note.status`）—— 两者得能对上。
   */
  private lookupDisplayName(propertyId: BasesPropertyId): string | undefined {
    const names = this.viewDisplayNames;
    return (
      names[propertyId] ?? names[normalizePropertyId(propertyId)] ?? names[parsePropertyId(propertyId).name]
    );
  }

  /** properties 配置（base 级 + view 级）由外部注入 */
  viewDisplayNames: Record<string, string> = {};

  /** 汇总某属性（内部用） */
  summaryOf(entries: BasesEntry[], propertyId: BasesPropertyId, summaryKey: string, custom?: Record<string, string>): Value {
    return summaryValue(summaryKey, entries.map((e) => e.queryRow()), propertyId, custom, this.fileApi, this.selfPath);
  }
}

const FILE_PROP_NAMES: Record<string, string> = {
  name: "Name",
  basename: "Name",
  path: "Path",
  folder: "Folder",
  ext: "Extension",
  size: "Size",
  ctime: "Created",
  mtime: "Modified",
  tags: "Tags",
  links: "Links",
  embeds: "Embeds",
  backlinks: "Backlinks",
  properties: "Properties",
  file: "File",
};

function humanizeFileProperty(name: string): string {
  return FILE_PROP_NAMES[name] ?? humanize(name);
}

function humanize(name: string): string {
  if (!name) return "";
  const spaced = name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** 查询结果 */
export class BasesQueryResult {
  /** 过滤后的行（已排序、已截断） */
  data: BasesEntry[];
  /** 数据集里出现过的全部属性 ID */
  properties: BasesPropertyId[];

  private _groups: BasesEntryGroup[];

  constructor(data: BasesEntry[], properties: BasesPropertyId[], groups: BasesEntryGroup[]) {
    this.data = data;
    this.properties = properties;
    this._groups = groups;
  }

  /** 分组形式（没配置 groupBy 时是一个无 key 的组装着全部） */
  get groupedData(): BasesEntryGroup[] {
    return this._groups;
  }

  getSummaryValue(queryController: unknown, entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
    void queryController; // 公开声明里 QueryController 是空类，这里不依赖它
    const first = entries[0]?.queryOutcome();
    if (!first) return NULL;
    const cfg = this.summaryHooks;
    if (cfg) return cfg(entries, prop, summaryKey);
    // 没有宿主钩子时退回只算数值/日期的默认汇总
    const values = entries.map((e) => e.getValue(prop) ?? NULL);
    return defaultSummary(summaryKey, values);
  }

  /** 宿主注入的汇总实现（能读 base 级自定义 summaries 与 fileApi） */
  summaryHooks: ((entries: BasesEntry[], prop: BasesPropertyId, key: string) => Value) | null = null;
}

/**
 * 插件视图基类。公开声明里是 `abstract class BasesView extends Component`，
 * 构造器是 protected —— 插件的 factory 里 `new MyBasesView(controller, el)`。
 */
export abstract class BasesView extends Component {
  abstract type: string;
  app: unknown;
  config: BasesViewConfig;
  allProperties: BasesPropertyId[];
  data: BasesQueryResult;
  controller: QueryController;

  constructor(controller: QueryController) {
    super();
    this.controller = controller;
    this.allProperties = [];
    this.data = new BasesQueryResult([], [], []);
    this.config = new BasesViewConfig({
      view: { type: "", name: "" },
      outcome: { rows: [], matched: [], allProperties: [], errors: [] },
      defaults: {},
      fileApi: emptyFileApi(),
      selfPath: "",
    });
  }

  /** 数据或配置变了 → 重绘 */
  abstract onDataUpdated(): void;

  /** 官方：为当前视图新建一个文件（视图的"新建"按钮用） */
  async createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const creator = this.createFileHook;
    if (!creator) throw new Error("noteforge：当前上下文不支持 createFileForView");
    await creator(baseFileName, frontmatterProcessor);
  }

  /** 宿主注入的「新建文件」实现 */
  createFileHook: ((baseFileName?: string, frontmatterProcessor?: (fm: Record<string, unknown>) => void) => Promise<void>) | null = null;
}

/** 未初始化时的占位 FileApi：读全部给中性值，不抛（免得插件一加载就炸） */
function emptyFileApi(): FileApi {
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