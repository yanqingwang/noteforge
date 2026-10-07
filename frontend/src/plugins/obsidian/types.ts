/**
 * Obsidian 兼容层的类型定义与宿主（host）接口。
 *
 * 设计要点：shim 不直接依赖 noteforge 的一切，而是通过一个可注入的 host 接口
 * 访问文件系统和活动文件。这样同一份 shim 代码有三种运行位置：
 *   1) 应用内（host = Tauri invoke 实现）
 *   2) 兼容性测试 harness（host = 内存文件系统）
 *   3) 单元测试（host = 内存文件系统）
 */

export interface FileEntry {
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

/** shim 需要的最小文件系统能力（对应 noteforge 的 Tauri 命令）。 */
export interface HostFs {
  list(path: string): Promise<FileEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number; modified: number } | null>;
  /** 读二进制（附件），返回 base64；不支持时抛错。 */
  readBinary?(path: string): Promise<string>;
  writeBinary?(path: string, base64: string): Promise<void>;
}

export interface Host {
  /** 宿主标识，写进 shim 生成的 UA/日志，便于诊断。 */
  readonly kind: "tauri" | "memory";
  /** vault 根目录绝对路径。 */
  vaultPath(): string;
  fs: HostFs;
  /** 当前活动笔记路径（未打开文件时为 null）。 */
  activeFile(): string | null;
  /** 打开文件（工作区动作）。 */
  openFile?(path: string): Promise<void>;
  /** 把内容写回编辑器（工作区动作）；未实现时插件对活动文件的写入应报错。 */
  saveActiveFile?(content: string): Promise<void>;
  /** 宿主提供的 @codemirror/* 与 @lezer/* 模块，供插件 require。 */
  cmModules(): Record<string, unknown>;
  /** 插件视图挂载点提供者（ItemView 的 contentEl 归属）。 */
  requestContainer?(kind: string): HTMLElement | null;
  /** markdown → HTML。应用内走 comrak（render_markdown 命令）；harness 缺省走兜底渲染。 */
  renderMarkdown?(markdown: string, sourcePath: string): Promise<string>;
}

/** Obsidian 的插件清单（取官方 manifest.json 的子集）。 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
  [k: string]: unknown;
}

/** 事件引用：registerEvent 返回，dispose 时解绑。 */
export interface EventRef {
  id: string;
  name: string;
  callback: (...args: unknown[]) => void;
  owner?: unknown;
  offref?: (ref: EventRef) => void;
}

/** 记录插件对 shim 的使用情况，兼容性测试报告的数据来源。 */
export interface ApiRecorder {
  /** 被访问到的导出名 */
  accessed: Set<string>;
  /** 被调用的导出名及次数 */
  calls: Map<string, number>;
  /** 调用中抛出的错误（按导出名归并，保留首个 stack） */
  errors: Map<string, { message: string; stack?: string; count: number }>;
  /** 未实现的导出被访问的记录 */
  unsupported: Map<string, number>;
  recordAccess(name: string): void;
  recordCall(name: string): void;
  recordError(name: string, err: unknown): void;
  recordUnsupported(name: string): void;
  reset(): void;
  snapshot(): {
    accessed: string[];
    calls: Record<string, number>;
    errors: Record<string, { message: string; stack?: string; count: number }>;
    unsupported: Record<string, number>;
  };
}

export function createRecorder(): ApiRecorder {
  const accessed = new Set<string>();
  const calls = new Map<string, number>();
  const errors = new Map<string, { message: string; stack?: string; count: number }>();
  const unsupported = new Map<string, number>();
  return {
    accessed,
    calls,
    errors,
    unsupported,
    recordAccess: (n) => void accessed.add(n),
    recordCall: (n) => calls.set(n, (calls.get(n) ?? 0) + 1),
    recordError: (n, err) => {
      const prev = errors.get(n);
      const message = err instanceof Error ? err.message : String(err);
      if (prev) {
        prev.count++;
      } else {
        errors.set(n, { message, stack: err instanceof Error ? err.stack : undefined, count: 1 });
      }
    },
    recordUnsupported: (n) => unsupported.set(n, (unsupported.get(n) ?? 0) + 1),
    reset: () => {
      accessed.clear();
      calls.clear();
      errors.clear();
      unsupported.clear();
    },
    snapshot: () => ({
      accessed: [...accessed].sort(),
      calls: Object.fromEntries([...calls].sort((a, b) => b[1] - a[1])),
      errors: Object.fromEntries(errors),
      unsupported: Object.fromEntries(unsupported),
    }),
  };
}

/** 二进制 ⇄ base64（浏览器环境无 Buffer，宿主侧也不该依赖 Node 全局）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 内存文件系统：harness 与单元测试用，不碰用户真实 vault。 */
export class MemoryFs implements HostFs {
  files = new Map<string, { content: string; modified: number }>();
  dirs = new Set<string>([""]);
  private tick = 0;

  seed(files: Record<string, string>): void {
    for (const [p, c] of Object.entries(files)) this.writeSync(p, c);
  }

  private writeSync(path: string, content: string): void {
    const now = ++this.tick;
    let dir = "";
    for (const seg of path.split("/").slice(0, -1)) {
      dir = dir ? `${dir}/${seg}` : seg;
      this.dirs.add(dir);
    }
    this.files.set(path, { content, modified: now });
  }

  async list(path: string): Promise<FileEntry[]> {
    const prefix = path ? `${path}/` : "";
    const out = new Map<string, FileEntry>();
    for (const [p, v] of this.files) {
      if (prefix && !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) out.set(p, { path: p, is_dir: false, size: v.content.length, modified: v.modified });
      else {
        const d = prefix + rest.slice(0, slash);
        out.set(d, { path: d, is_dir: true, size: 0, modified: v.modified });
      }
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error(`文件不存在: ${path}`);
    return f.content;
  }

  async write(path: string, data: string): Promise<void> {
    this.writeSync(path, data);
  }

  async remove(path: string): Promise<void> {
    if (this.files.delete(path)) return;
    const prefix = `${path}/`;
    let hit = false;
    for (const p of [...this.files.keys()]) {
      if (p.startsWith(prefix)) {
        this.files.delete(p);
        hit = true;
      }
    }
    this.dirs.delete(path);
    if (!hit) throw new Error(`文件不存在: ${path}`);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async stat(path: string): Promise<{ size: number; modified: number } | null> {
    const f = this.files.get(path);
    if (f) return { size: f.content.length, modified: f.modified };
    if (this.dirs.has(path)) return { size: 0, modified: 0 };
    return null;
  }

  async readBinary(path: string): Promise<string> {
    return bytesToBase64(new TextEncoder().encode(await this.read(path)));
  }

  async writeBinary(path: string, base64: string): Promise<void> {
    this.writeSync(path, new TextDecoder().decode(base64ToBytes(base64)));
  }
}

/** 内存 host：harness / 单测的默认宿主。 */
export function createMemoryHost(files: Record<string, string> = {}): Host & { fs: MemoryFs } {
  const fs = new MemoryFs();
  fs.seed(files);
  let active: string | null = Object.keys(files)[0] ?? null;
  return {
    kind: "memory",
    vaultPath: () => "/vault",
    fs,
    activeFile: () => active,
    openFile: async (p) => {
      if (!fs.files.has(p)) throw new Error(`文件不存在: ${p}`);
      active = p;
    },
    saveActiveFile: async (content) => {
      if (!active) throw new Error("没有活动文件");
      await fs.write(active, content);
    },
    cmModules: () => ({}),
    requestContainer: () => null,
  };
}