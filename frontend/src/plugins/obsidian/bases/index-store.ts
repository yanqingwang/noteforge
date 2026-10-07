/**
 * Bases 元数据索引（前端侧）。
 *
 * Rust 侧的 `index_metadata` 一次遍历 vault，返回每个文件的
 * frontmatter 原文 / 行内标签 / 链接 / 嵌入 / 标题，以及解析好的反向链接。
 * 这里做三件事：
 *
 * 1. 用 `yaml` 包**真解析** frontmatter —— nf-markdown 自带的行解析把所有值
 *    当字符串，Bases 的 `age > 30`、`done == true` 会全废（这是 Bases 的地基，
 *    类型错了后面排序/筛选/公式全歪）。
 * 2. 懒解析 + 缓存：frontmatter 只在真被问到时才 parse。
 * 3. 把结果灌进 `metadataCache` —— 之前 `setCache` 零调用，插件拿到的
 *    `getFileCache(path)` 永远是 null，Bases 之外这也是白捡的兼容收益
 *    （dataview / tasks 这类插件重度依赖 frontmatter）。
 */

import { parse as parseYaml } from "yaml";
import type { FileApi } from "./expr/file-api";
import { LinkValue } from "./expr/values";

export interface MetaLinkRaw {
  target: string;
  path: string | null;
  display: string | null;
  subpath: string | null;
}

export interface MetaHeadingRaw {
  level: number;
  text: string;
}

export interface MetaFileRaw {
  path: string;
  ext: string;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  frontmatter: string | null;
  tags: string[];
  links: MetaLinkRaw[];
  embeds: MetaLinkRaw[];
  headings: MetaHeadingRaw[];
}

export interface MetaIndexRaw {
  files: MetaFileRaw[];
  backlinks: Record<string, string[]>;
  scanned: number;
  skipped: number;
}

/** 解析后的一个文件条目：frontmatter 已按 YAML 真值解析。 */
export interface IndexedFile extends Omit<MetaFileRaw, "frontmatter"> {
  frontmatter: Record<string, unknown>;
}

export interface LoadIndexResult {
  ok: boolean;
  files: number;
  /** 索引构建耗时（ms），用于状态栏提示 */
  ms: number;
  error?: string;
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** frontmatter 解析失败的路径（便于 UI 提示，而不是静默当空） */
export interface FrontmatterIssue {
  path: string;
  error: string;
}

export class IndexStore {
  private raw = new Map<string, MetaFileRaw>();
  private parsed = new Map<string, Record<string, unknown>>();
  private backlinks = new Map<string, string[]>();
  private issues: FrontmatterIssue[] = [];
  private loaded = false;

  private invoke: Invoke;

  constructor(invoke: Invoke) {
    this.invoke = invoke;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** 从 Rust 拉一次全量索引。传入文件清单以复用前端已有的文件树。 */
  async load(files: string[], root: string): Promise<LoadIndexResult> {
    const t0 = Date.now();
    try {
      const res = (await this.invoke("index_metadata", { files, root })) as MetaIndexRaw;
      this.adopt(res);
      this.loaded = true;
      return { ok: true, files: res.files.length, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, files: 0, ms: Date.now() - t0, error: String(e) };
    }
  }

  /** 测试与增量场景：直接塞一份已构造好的索引。 */
  adopt(res: MetaIndexRaw): void {
    this.raw.clear();
    this.parsed.clear();
    this.backlinks.clear();
    this.issues = [];
    for (const f of res.files ?? []) {
      this.raw.set(f.path, f);
      // 预热 frontmatter：Bases 的筛选要读所有文件的属性，懒解析在这里没意义
      this.frontmatterOf(f.path);
    }
    for (const [target, sources] of Object.entries(res.backlinks ?? {})) {
      this.backlinks.set(target, [...sources]);
    }
  }

  getFrontmatterIssues(): FrontmatterIssue[] {
    return [...this.issues];
  }

  paths(): string[] {
    return [...this.raw.keys()];
  }

  entries(): IndexedFile[] {
    return this.paths().map((p) => this.file(p) as IndexedFile);
  }

  file(path: string): IndexedFile | undefined {
    const f = this.raw.get(path);
    if (!f) return undefined;
    return { ...f, frontmatter: this.frontmatterOf(path) };
  }

  has(path: string): boolean {
    return this.raw.has(path);
  }

  backlinksOf(path: string): string[] {
    return this.backlinks.get(path) ?? [];
  }

  /**
   * 解析 frontmatter。解析失败不当空处理：记进 issues 并退回 `{}`，
   * 这样「YAML 写错了导致整列空」这类问题能被看见，而不是变成一个安静的 bug。
   */
  frontmatterOf(path: string): Record<string, unknown> {
    const hit = this.parsed.get(path);
    if (hit) return hit;
    const raw = this.raw.get(path)?.frontmatter;
    let out: Record<string, unknown> = {};
    if (raw && raw.trim()) {
      try {
        const v = parseYaml(raw);
        if (v && typeof v === "object" && !Array.isArray(v)) out = v as Record<string, unknown>;
        else if (v !== null && v !== undefined) {
          this.issues.push({ path, error: "frontmatter 不是键值映射" });
        }
      } catch (e) {
        this.issues.push({ path, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.parsed.set(path, out);
    return out;
  }

  /**
   * 文件是否变了（mtime 或大小）。宿主用它决定要不要重建索引 / 局部更新。
   */
  stampOf(path: string): { mtimeMs: number; size: number } | null {
    const f = this.raw.get(path);
    if (!f) return null;
    return { mtimeMs: f.mtime_ms, size: f.size };
  }

  /** 单文件增量更新：重新走一次 Rust 索引（只传这一个文件），代价很小。 */
  async refresh(paths: string[], root: string): Promise<boolean> {
    try {
      const res = (await this.invoke("index_metadata", { files: paths, root })) as MetaIndexRaw;
      for (const f of res.files ?? []) {
        this.raw.set(f.path, f);
        this.parsed.delete(f.path);
        this.frontmatterOf(f.path);
      }
      // 反向链接要全量重算：这一份只含被改的文件，看不到指向它的其它文件
      for (const p of paths) {
        this.backlinks.delete(p);
        for (const v of this.backlinks.values()) {
          const i = v.indexOf(p);
          if (i >= 0) v.splice(i, 1);
        }
      }
      for (const [target, sources] of Object.entries(res.backlinks ?? {})) {
        const merged = new Set([...(this.backlinks.get(target) ?? []), ...sources]);
        this.backlinks.set(target, [...merged].sort());
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 灌进 metadataCache 的形状。Obsidian 的 CachedMetadata 里 frontmatter/tags/
   * links/embeds/headings 都是插件直接读的东西。
   */
  toCacheEntry(path: string): Record<string, unknown> | null {
    const f = this.raw.get(path);
    if (!f) return null;
    return {
      frontmatter: this.frontmatterOf(path),
      tags: this.allTagsOf(path),
      links: f.links.map((l) => ({ link: l.path ?? l.target, displayText: l.display ?? undefined })),
      embeds: f.embeds.map((l) => ({ link: l.path ?? l.target, displayText: l.display ?? undefined })),
      headings: f.headings.map((h) => ({ heading: h.text, level: h.level })),
    };
  }

  /**
   * 全部标签 = frontmatter 的 tags 字段 + 行内 `#tag`（与 Obsidian 一致）。
   * frontmatter 里可以是字符串、数组、或逗号分隔字符串，三种都吃。
   */
  allTagsOf(path: string): string[] {
    const f = this.raw.get(path);
    if (!f) return [];
    const out = new Set<string>();
    // Rust 侧已去掉 #，这里再兜一层（索引可能来自别处/旧缓存）
    for (const t of f.tags) {
      const n = t.trim().replace(/^#/, "");
      if (n) out.add(n);
    }
    const fmTags = this.frontmatterOf(path).tags;
    const push = (v: unknown): void => {
      if (typeof v === "string") {
        for (const part of v.split(/[,\s]+/)) {
          const t = part.trim().replace(/^#/, "");
          if (t) out.add(t);
        }
      } else if (Array.isArray(v)) v.forEach(push);
    };
    push(fmTags);
    return [...out].sort();
  }
}
/**
 * 从索引造 Bases 的 FileApi。
 *
 * 查询引擎只认 FileApi，不认 IndexStore —— 这样 harness（内存 vault）与真机
 * （Tauri + Rust 索引）能共用同一份引擎代码与测试。
 */
export function fileApiFromIndex(store: IndexStore): FileApi {
  return {
    exists: (p) => store.has(p),
    basename: (p) => {
      const name = p.split("/").pop() ?? p;
      const dot = name.lastIndexOf(".");
      return dot > 0 ? name.slice(0, dot) : name;
    },
    folder: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "/"),
    ext: (p) => store.file(p)?.ext ?? "",
    size: (p) => store.file(p)?.size ?? 0,
    ctime: (p) => new Date(store.file(p)?.ctime_ms ?? 0),
    mtime: (p) => new Date(store.file(p)?.mtime_ms ?? 0),
    properties: (p) => store.frontmatterOf(p),
    hasProperty: (p, k) => k in store.frontmatterOf(p),
    tags: (p) => store.allTagsOf(p),
    links: (p) => (store.file(p)?.links ?? []).map(toLink),
    embeds: (p) => (store.file(p)?.embeds ?? []).map(toLink),
    backlinks: (p) => store.backlinksOf(p),
    resolve: (t) => {
      // 已经是 vault 内路径就直接认
      if (store.has(t)) return t;
      // 尝试按 Obsidian 优先级解析（与 Rust/JS 索引同一套规则）
      const lower = t.toLowerCase();
      for (const cand of [lower, `${lower}.md`, `${lower}.html`]) {
        for (const p of store.paths()) {
          if (p.toLowerCase() === cand) return p;
        }
      }
      const suffix = store
        .paths()
        .filter((p) => p.toLowerCase().endsWith(`/${lower}`))
        .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
      if (suffix.length) return suffix[0];
      const base = store
        .paths()
        .filter((p) => {
          const n = p.split("/").pop() ?? p;
          const dot = n.lastIndexOf(".");
          return (dot > 0 ? n.slice(0, dot) : n).toLowerCase() === lower;
        })
        .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
      if (base.length) return base[0];
      const fuzzy = store.paths().filter((p) => p.toLowerCase().includes(lower));
      return fuzzy.length === 1 ? fuzzy[0] : null;
    },
  };
}

function toLink(l: MetaLinkRaw): LinkValue {
  return new LinkValue(l.path ?? l.target, l.display ?? undefined);
}
