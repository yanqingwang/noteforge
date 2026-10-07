/**
 * JS 侧元数据索引（与 Rust 版 `bases_cmd.rs` 语义对齐，但独立实现）。
 *
 * 为什么要两份：
 * - 真机走 Rust：一次遍历整个 vault，webview 里不卡
 * - 兼容测试 harness（jsdom + 内存 vault）没有 Tauri 命令，只能在 JS 里建
 *
 * 做成独立实现而不是共用一份，是**有意的**：harness 由此变成对 Rust 索引的一个
 * 独立交叉验证 —— 两边对同一份 vault 给出不同结果时，说明至少有一份错了。
 */

import { getFrontMatterInfo } from "../extra";
import type { MetaFileRaw, MetaIndexRaw, MetaLinkRaw } from "./index-store";

export interface ReadFileFn {
  (path: string): Promise<string | null>;
}

export interface StatFileFn {
  (path: string): Promise<{ size: number; mtimeMs: number } | null>;
}

/** 只对这些扩展名解析正文（与 Rust 侧 TEXT_EXTS 一致） */
const TEXT_EXTS = new Set(["md", "markdown", "mdx", "html", "htm", "txt"]);

/** 行内标签：`#tag`，要求前面不是词字符（否则会抓到 a#b 或 URL 的 #锚点） */
const INLINE_TAG = /(?<![\w#])#([\p{L}\p{N}_\-/]+)/gu;
/** wikilink 与嵌入：`[[目标|显示]]` */
const WIKILINK = /\[\[([^[\]]+?)(?:\|([^[\]]*?))?\]\]/g;
/** ATX 标题：`## 标题` */
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;

/** 从 frontmatter 的 tags 字段取值（字符串 / 数组 / 逗号分隔都吃） */
function frontmatterTags(yaml: string | null): string[] {
  if (!yaml) return [];
  const out: string[] = [];
  const push = (v: string): void => {
    for (const part of v.split(/[,\s]+/)) {
      const t = part.trim().replace(/^#/, "");
      if (t) out.push(t);
    }
  };
  const inline = /^\s*tags\s*:\s*(.*)$/m.exec(yaml);
  if (inline) {
    const raw = inline[1].trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      for (const item of raw.slice(1, -1).split(",")) push(item);
    } else if (raw) {
      push(raw);
    }
  }
  const block = /^\s*tags\s*:\s*\r?\n((?:\s*-\s*[^\r\n]*\r?\n?)+)/m.exec(yaml);
  if (block) {
    for (const line of block[1].split("\n")) push(line.replace(/^\s*-\s*/, ""));
  }
  return out;
}

function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function basenameOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function stripExt(path: string): string {
  const i = path.lastIndexOf(".");
  return i > 0 && !path.slice(i).includes("/") ? path.slice(0, i).toLowerCase() : path.toLowerCase();
}

/**
 * 链接解析器：与 Rust 侧 LinkResolver 同一套优先级
 * （完整路径 → 路径后缀，多命中取层级最浅 → basename → 唯一模糊）
 */
class LinkResolver {
  private byPath = new Map<string, string>();
  private byBasename = new Map<string, string[]>();
  private allLower: string[] = [];

  constructor(paths: string[]) {
    for (const p of paths) {
      const lower = p.toLowerCase();
      if (!this.byPath.has(lower)) this.byPath.set(lower, p);
      const b = basenameOf(p).toLowerCase();
      const list = this.byBasename.get(b);
      if (list) list.push(p);
      else this.byBasename.set(b, [p]);
      this.allLower.push(lower);
    }
  }

  resolve(target: string): string | null {
    if (!target || target.includes("://")) return null;
    const t = target.toLowerCase();
    const tNoExt = stripExt(target);
    for (const cand of [t, `${t}.md`, `${t}.html`]) {
      const hit = this.byPath.get(cand);
      if (hit) return hit;
    }
    const suffix = this.allLower
      .filter((p) => p.endsWith(`/${t}`) || p.endsWith(`/${t}.md`) || stripExt(p).endsWith(`/${tNoExt}`))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    if (suffix.length) return this.byPath.get(suffix[0]) ?? null;
    const byBase = this.byBasename.get(tNoExt);
    if (byBase?.length) return [...byBase].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
    const fuzzy = this.allLower.filter((p) => p.includes(t));
    return fuzzy.length === 1 ? (this.byPath.get(fuzzy[0]) ?? null) : null;
  }
}

/** 建索引。返回形状与 Rust 的 index_metadata 返回一致。 */
export async function buildJsIndex(opts: {
  files: string[];
  read: ReadFileFn;
  stat?: StatFileFn;
}): Promise<MetaIndexRaw> {
  const { files, read, stat } = opts;
  const resolver = new LinkResolver(files);
  const backlinks: Record<string, string[]> = {};
  const out: MetaFileRaw[] = [];

  for (const path of files) {
    const ext = extOf(path);
    let size = 0;
    let mtime = 0;
    if (stat) {
      const s = await stat(path);
      if (s) {
        size = s.size;
        mtime = s.mtimeMs;
      }
    }
    let frontmatter: string | null = null;
    let tags: string[] = [];
    const links: MetaLinkRaw[] = [];
    const embeds: MetaLinkRaw[] = [];
    const headings: MetaFileRaw["headings"] = [];

    if (TEXT_EXTS.has(ext)) {
      const content = await read(path);
      if (content !== null) {
        size = content.length || size;
        const fm = getFrontMatterInfo(content);
        frontmatter = fm.exists ? fm.frontmatter : null;
        tags = frontmatterTags(frontmatter);
        // 行内标签
        for (const m of content.matchAll(INLINE_TAG)) {
          const t = m[1].replace(/^#/, "");
          if (t) tags.push(t);
        }
        // 链接与嵌入：embed 的 raw 前面那个字符是 !
        for (const m of content.matchAll(WIKILINK)) {
          const inner = m[1];
          const target = (inner.split("#")[0] ?? "").trim();
          if (!target) continue;
          const link: MetaLinkRaw = {
            target,
            path: resolver.resolve(target),
            display: m[2] ?? null,
            subpath: inner.includes("#") ? inner.slice(inner.indexOf("#")) : null,
          };
          const isEmbed = m.index > 0 && content[m.index - 1] === "!";
          if (isEmbed) embeds.push(link);
          else links.push(link);
          if (link.path) (backlinks[link.path] ??= []).push(path);
        }
        for (const m of content.matchAll(HEADING)) {
          headings.push({ level: m[1].length, text: m[2] });
        }
      }
    }

    out.push({
      path,
      ext,
      size,
      mtime_ms: mtime,
      // 内存 vault 没有 birth time，与 Rust 侧一样退回 mtime
      ctime_ms: mtime,
      frontmatter,
      tags: [...new Set(tags)].sort(),
      links,
      embeds,
      headings,
    });
  }

  for (const key of Object.keys(backlinks)) backlinks[key] = [...new Set(backlinks[key])].sort();
  return { files: out, backlinks, scanned: out.filter((f) => TEXT_EXTS.has(f.ext)).length, skipped: out.length };
}