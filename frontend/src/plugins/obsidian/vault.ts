/**
 * Vault / MetadataCache / FileManager。
 *
 * 文件树从 host.fs 递归构建，写操作后立即刷新索引 —— 插件频繁做
 * `getFileByPath` → `modify` → `getFileByPath` 的循环，索引不一致会直接导致
 * 「改完再查不到」的诡异 bug。
 */

import { Events, normalizePath, parseLinktext, type CachedMetadataLike } from "./events";
import { TAbstractFile, TFile, TFolder } from "./items";
import type { Host, PluginManifest } from "./types";

export interface VaultConfig {
  attachmentFolderPath?: string;
  newFileLocation?: string;
  newFileFolderPath?: string;
  useMarkdownLinks?: boolean;
  alwaysUpdateLinks?: boolean;
  showUnsupportedFiles?: boolean;
  [k: string]: unknown;
}

const MD_EXT = new Set(["md", "markdown"]);

export class Vault extends Events {
  adapterName = "noteforge-memory";
  config: VaultConfig = {
    attachmentFolderPath: "附件",
    newFileLocation: "folder",
    newFileFolderPath: "",
    useMarkdownLinks: false,
    alwaysUpdateLinks: false,
  };

  private files = new Map<string, TFile>();
  private folders = new Map<string, TFolder>();
  private root: TFolder;
  private ready: Promise<void> | null = null;
  private host: Host;
  private name: string;
  metadataCache: MetadataCache;

  constructor(host: Host, name: string) {
    super();
    this.host = host;
    this.name = name;
    this.root = new TFolder("");
    this.root.vault = this;
    this.metadataCache = new MetadataCache(this);
  }

  /* ---------- 索引 ---------- */

  /** 等待文件树就绪（首次访问会真正扫描，之后缓存）。 */
  async ensure(): Promise<void> {
    if (!this.ready) this.ready = this.reindex();
    await this.ready;
  }

  private async reindex(): Promise<void> {
    const prevMods = new Map<string, number>();
    for (const [p, f] of this.files) prevMods.set(p, f.stat.mtime);
    const nextFiles = new Map<string, TFile>();
    const nextFolders = new Map<string, TFolder>();
    const root = new TFolder("");
    root.vault = this;
    nextFolders.set("", root);

    const walk = async (dir: string, parent: TFolder): Promise<void> => {
      let entries;
      try {
        entries = await this.host.fs.list(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.is_dir) {
          const f = new TFolder(e.path);
          f.vault = this;
          f.parent = parent;
          parent.children.push(f);
          nextFolders.set(e.path, f);
          await walk(e.path, f);
        } else {
          const known = this.files.get(e.path);
          const file =
            known && known.stat.mtime === e.modified
              ? known
              : new TFile(e.path, { size: e.size, mtime: e.modified });
          file.vault = this;
          file.parent = parent;
          parent.children.push(file);
          nextFiles.set(e.path, file);
        }
      }
    };
    await walk("", root);
    this.files = nextFiles;
    this.folders = nextFolders;
  }

  private async touch(): Promise<void> {
    this.ready = this.reindex();
    await this.ready;
  }

  /* ---------- 基本信息 ---------- */

  getName(): string {
    return this.name;
  }

  /**
   * 配置目录名（Obsidian 是 ".obsidian"）。
   * 插件用它拼插件设置文件路径（`<configDir>/plugins/<id>/data.json`），
   * 缺失时这类插件会直接算错路径或抛 undefined。
   */
  configDir = ".obsidian";

  getRoot(): TFolder {
    return this.root;
  }

  getConfig(key: string): unknown {
    return (this.config as Record<string, unknown>)[key];
  }

  setConfig(key: string, value: unknown): void {
    (this.config as Record<string, unknown>)[key] = value;
  }

  /* ---------- 查询 ----------
   *
   * Obsidian 的这些方法是**同步**的：索引常驻内存，getFiles() 直接返回数组。
   * 早先做成 async，插件里 `vault.getMarkdownFiles().find(...)` 会在运行期报
   * "is not a function"（await 一个数组虽然能过，但不用 await 的调用就炸）。
   * 因此这里保持同步；索引由 ready()/写入操作维护。
   */

  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.files.values(), ...this.folders.values()];
  }

  getFiles(): TFile[] {
    return [...this.files.values()];
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((f) => MD_EXT.has(f.extension.toLowerCase()));
  }

  getAllFolders(includeRoot = false): TFolder[] {
    const all = [...this.folders.values()];
    return includeRoot ? all : all.filter((f) => f.path !== "");
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const p = normalizePath(path);
    return this.files.get(p) ?? this.folders.get(p) ?? null;
  }

  getFileByPath(path: string): TFile | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }

  /** Obsidian 语义：加/补扩展名后查找文件。 */
  getFileByPathLoose(path: string): TFile | null {
    const direct = this.getFileByPath(path);
    if (direct) return direct;
    if (!MD_EXT.has(path.split(".").pop()?.toLowerCase() ?? "")) {
      return this.getFileByPath(`${path}.md`);
    }
    return null;
  }

  getAvailablePathForAttachments(name: string, extension?: string): string {
    const folder = String(this.config.attachmentFolderPath || "附件").replace(/^\/+|\/+$/g, "");
    const safe = name.replace(/[\\/:*?"<>|]/g, "_");
    let candidate = folder ? `${folder}/${safe}` : safe;
    let i = 1;
    while (this.getAbstractFileByPath(candidate)) {
      candidate = folder ? `${folder}/${safe} ${i}` : `${safe} ${i}`;
      i++;
    }
    return extension && !candidate.endsWith(`.${extension}`) ? `${candidate}.${extension}` : candidate;
  }

  /* ---------- 读 ---------- */

  async read(file: TFile | string): Promise<string> {
    const p = typeof file === "string" ? file : file.path;
    return this.host.fs.read(p);
  }

  /** Obsidian 的 cachedRead：命中缓存时不重读磁盘。 */
  async cachedRead(file: TFile | string): Promise<string> {
    return this.read(file);
  }

  async readBinary(file: TFile | string): Promise<ArrayBuffer> {
    const p = typeof file === "string" ? file : file.path;
    if (!this.host.fs.readBinary) throw new Error(`宿主不支持读二进制: ${p}`);
    const b64 = await this.host.fs.readBinary(p);
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  async cachedReadBinary(file: TFile | string): Promise<ArrayBuffer> {
    return this.readBinary(file);
  }

  /**
   * Obsidian 的 embed API：把链接渲染成嵌入块。
   * shim 只做「定位目标 + 返回句柄」，真正的渲染由宿主决定；
   * 不实现的话插件（kanban/pdf-plus 等）在 onload 阶段就会抛。
   */
  async embedByExtension(
    linktext: string,
    sourcePath: string,
    _component?: unknown,
  ): Promise<{ sourcePath: string; path: string; exists: boolean }> {
    const dest = await this.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    return { sourcePath, path: dest?.path ?? "", exists: Boolean(dest) };
  }

  async embedByUrl(
    url: string,
    _sourcePath: string,
    _component?: unknown,
  ): Promise<{ url: string }> {
    return { url };
  }

  /* ---------- 写 ---------- */

  async create(path: string, data: string, _opts?: unknown): Promise<TFile> {
    const p = normalizePath(path);
    if (this.getAbstractFileByPath(p)) throw new Error(`已存在: ${p}`);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.getAbstractFileByPath(dir)) await this.createFolder(dir);
    }
    await this.host.fs.write(p, data);
    await this.touch();
    const file = this.getFileByPath(p) as TFile;
    this.trigger("create", file);
    return file;
  }

  async createBinary(path: string, data: ArrayBuffer, _opts?: unknown): Promise<TFile> {
    if (!this.host.fs.writeBinary) throw new Error("宿主不支持写二进制");
    let bin = "";
    const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    await this.host.fs.writeBinary(normalizePath(path), btoa(bin));
    await this.touch();
    return this.getFileByPath(normalizePath(path)) as TFile;
  }

  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (!this.getAbstractFileByPath(p)) await this.host.fs.mkdir(p);
    await this.touch();
    const f = this.getFolderByPath(p) as TFolder;
    this.trigger("create", f);
    return f;
  }

  async modify(file: TFile | string, data: string, _opts?: unknown): Promise<void> {
    const p = typeof file === "string" ? file : file.path;
    await this.host.fs.write(p, data);
    const target = this.getFileByPath(p);
    await this.touch();
    this.trigger("modify", target ?? p);
  }

  async modifyBinary(file: TFile | string, data: ArrayBuffer): Promise<void> {
    if (!this.host.fs.writeBinary) throw new Error("宿主不支持写二进制");
    let bin = "";
    const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await this.host.fs.writeBinary(typeof file === "string" ? file : file.path, btoa(bin));
    await this.touch();
    this.trigger("modify", file);
  }

  async append(file: TFile | string, data: string, _opts?: unknown): Promise<void> {
    const p = typeof file === "string" ? file : file.path;
    await this.host.fs.write(p, (await this.host.fs.read(p)) + data);
    await this.touch();
    this.trigger("modify", p);
  }

  async process(file: TFile, fn: (data: string) => string, opts?: unknown): Promise<string> {
    const out = fn(await this.read(file));
    await this.modify(file, out, opts);
    return out;
  }

  async delete(file: TAbstractFile | string, _force?: boolean): Promise<void> {
    const p = typeof file === "string" ? file : file.path;
    await this.host.fs.remove(p);
    await this.touch();
    this.trigger("delete", file);
  }

  async trash(file: TAbstractFile | string, _system?: boolean): Promise<void> {
    return this.delete(file);
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const content = file instanceof TFile ? await this.read(file) : "";
    const target = normalizePath(newPath);
    await this.host.fs.write(target, content);
    await this.host.fs.remove(file.path);
    await this.touch();
    this.trigger("rename", file, target);
    this.metadataCache.trigger("file-renamed", target, file.path);
  }

  async copy(file: TFile, newPath: string): Promise<TFile> {
    const target = normalizePath(newPath);
    await this.host.fs.write(target, await this.read(file));
    await this.touch();
    const f = this.getFileByPath(target) as TFile;
    this.trigger("create", f);
    return f;
  }

  /* ---------- adapter（部分插件直接用它读写原始文件） ---------- */

  get adapter() {
    const fs = this.host.fs;
    return {
      getName: () => this.adapterName,
      getBasePath: () => this.host.vaultPath(),
      exists: async (p: string) => (await fs.stat(normalizePath(p))) !== null,
      stat: async (p: string) => {
        const s = await fs.stat(normalizePath(p));
        if (!s) throw new Error(`stat 失败: ${p}`);
        return { type: "file", ctime: 0, mtime: s.modified, size: s.size };
      },
      read: async (p: string) => fs.read(normalizePath(p)),
      readBinary: async (p: string) => this.readBinary(p),
      write: async (p: string, data: string) => fs.write(normalizePath(p), data),
      writeBinary: async (p: string, data: ArrayBuffer) => this.writeBinaryAdapter(p, data),
      mkdir: async (p: string) => fs.mkdir(normalizePath(p)),
      rmdir: async (p: string, _recursive?: boolean) => fs.remove(normalizePath(p)),
      remove: async (p: string) => fs.remove(normalizePath(p)),
      rename: async (a: string, b: string) => {
        await fs.write(normalizePath(b), await fs.read(normalizePath(a)));
        await fs.remove(normalizePath(a));
      },
      list: async (p: string) => fs.list(normalizePath(p)),
      trashSystem: async () => {
        throw new Error("noteforge 不提供系统回收站");
      },
      trashLocal: async (p: string) => fs.remove(normalizePath(p)),
    };
  }

  private async writeBinaryAdapter(p: string, data: ArrayBuffer): Promise<void> {
    if (!this.host.fs.writeBinary) throw new Error("宿主不支持写二进制");
    let bin = "";
    const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await this.host.fs.writeBinary(normalizePath(p), btoa(bin));
  }

  /* ---------- 元数据缓存（见构造函数） ---------- */
}

export class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  private caches = new Map<string, CachedMetadataLike>();
  private vault: Vault;

  constructor(vault: Vault) {
    super();
    this.vault = vault;
  }

  getFileCache(file: TFile | null): CachedMetadataLike | null {
    if (!file) return null;
    return this.caches.get(file.path) ?? null;
  }

  getCache(path: string): CachedMetadataLike | null {
    return this.caches.get(path) ?? null;
  }

  setCache(path: string, cache: CachedMetadataLike): void {
    this.caches.set(path, cache);
  }

  fileToLinktext(file: TFile, _sourcePath: string, omitMdExtension?: boolean): string {
    const name = omitMdExtension ? file.basename : file.name;
    return name;
  }

  async getFirstLinkpathDest(linkpath: string, sourcePath: string): Promise<TFile | null> {
    const { path } = parseLinktext(linkpath);
    const base = sourcePath.includes("/") ? sourcePath.split("/").slice(0, -1).join("/") : "";
    const candidates = [path, base ? `${base}/${path}` : "", `${path}.md`];
    if (base) candidates.push(`${base}/${path}.md`);
    const files = this.vault.getMarkdownFiles();
    for (const c of candidates) {
      if (!c) continue;
      const exact = files.find((f) => f.path === normalizePath(c));
      if (exact) return exact;
      const byName = files.find((f) => f.name === normalizePath(c) || f.basename === normalizePath(c));
      if (byName) return byName;
    }
    return null;
  }

  getLinkpath(linkpath: string): string {
    return linkpath;
  }
}

export class FileManager {
  private app: { vault: Vault; metadataCache: MetadataCache };

  constructor(app: { vault: Vault; metadataCache: MetadataCache }) {
    this.app = app;
  }

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const content = await this.app.vault.read(file);
    const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
    const { parse, stringify } = (await import("yaml")) as typeof import("yaml");
    const fm = m ? ((parse(m[1]) as Record<string, unknown>) ?? {}) : {};
    fn(fm);
    const head = `---\n${stringify(fm)}---\n`;
    const body = m ? content.slice(m[0].length) : content;
    await this.app.vault.modify(file, head + body);
  }

  getNewFileParent(_sourcePath: string): TFolder {
    return this.app.vault.getRoot();
  }

  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    await this.app.vault.rename(file, newPath);
  }

  async trashFile(file: TAbstractFile): Promise<void> {
    await this.app.vault.trash(file);
  }
}

/** vault.manifest：Obsidian 里是 vault 自带的 .obsidian 配置读取入口。 */
export function createVaultConfigHost(_m: PluginManifest): VaultConfig {
  return {};
}