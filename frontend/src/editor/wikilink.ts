/**
 * Wikilink（[[双向链接]]）目标解析。
 *
 * Obsidian 风格规则：
 *  - `[[note]]` / `[[dir/note]]`：按路径、路径后缀、文件名（忽略大小写）依次匹配；
 *  - `[[note|别名]]`：别名只影响显示；
 *  - `[[note#标题]]` / `[[note#^块id]]`：定位信息不参与文件匹配；
 *  - 只有唯一候选时才接受模糊匹配，多个候选视为歧义（避免跳到错误文件）。
 */

export interface VaultFile {
  path: string;
  is_dir?: boolean;
}

export interface WikilinkParts {
  /** 文件目标（已去别名、去 # 定位） */
  target: string;
  /** 别名（`|` 之后），无则为 undefined */
  alias?: string;
  /** `#` 之后的标题或 ^块 id */
  subpath?: string;
}

export interface ResolveResult {
  path: string | null;
  /** 匹配方式（调试/提示用） */
  via?: "path" | "suffix" | "basename" | "basename-ext" | "fuzzy";
  /** 候选多于一个 */
  ambiguous?: string[];
  /** 目标为空 */
  empty?: boolean;
}

/** 拆解 `[[目标|别名#标题]]` */
export function splitWikilink(raw: string): WikilinkParts {
  let s = (raw ?? "").trim();
  let alias: string | undefined;
  const pipe = s.indexOf("|");
  if (pipe >= 0) {
    alias = s.slice(pipe + 1).trim() || undefined;
    s = s.slice(0, pipe);
  }
  let subpath: string | undefined;
  const hash = s.indexOf("#");
  if (hash >= 0) {
    subpath = s.slice(hash + 1).trim() || undefined;
    s = s.slice(0, hash);
  }
  s = s.trim();
  // 去掉前导 ./ 与 /，以及 URL 编码
  s = s.replace(/^\.\//, "").replace(/^\/+/, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 非法编码保持原样 */
  }
  return { target: s, alias, subpath };
}

function norm(p: string): string {
  return p.toLowerCase();
}

function stripExt(p: string): string {
  return p.replace(/\.(md|markdown|html?)$/i, "");
}

function candidates(files: VaultFile[]): VaultFile[] {
  return files.filter((f) => !f.is_dir);
}

/** 在 vault 文件列表中解析 wikilink 目标（导出供测试） */
export function resolveWikilink(raw: string, files: VaultFile[]): ResolveResult {
  const { target } = splitWikilink(raw);
  if (!target) return { path: null, empty: true };

  const pool = candidates(files);
  if (!pool.length) return { path: null };
  const t = norm(target);
  const tNoExt = norm(stripExt(target));

  // 1) 完整路径（含补 .md）
  for (const f of pool) {
    const p = norm(f.path);
    if (p === t || p === `${t}.md` || p === `${t}.html`) {
      return { path: f.path, via: "path" };
    }
  }
  // 2) 路径后缀：[[dir/note]] 命中任意层级的同名文件
  const suffixMatches = pool.filter((f) => {
    const p = norm(f.path);
    const pNoExt = norm(stripExt(f.path));
    return p.endsWith(`/${t}`) || p.endsWith(`/${t}.md`) || pNoExt.endsWith(`/${tNoExt}`);
  });
  if (suffixMatches.length === 1) return { path: suffixMatches[0].path, via: "suffix" };
  if (suffixMatches.length > 1) {
    // 同名多文件：取层级最浅（离 vault 根最近）的那一个，与 Obsidian 一致
    const shallowest = suffixMatches
      .slice()
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))[0];
    return { path: shallowest.path, via: "suffix", ambiguous: suffixMatches.map((f) => f.path) };
  }

  // 3) 文件名匹配（忽略大小写与扩展名）
  const baseMatches = pool.filter((f) => norm(stripExt(f.path).split("/").pop()!) === tNoExt);
  if (baseMatches.length === 1) return { path: baseMatches[0].path, via: "basename" };
  if (baseMatches.length > 1) {
    return { path: baseMatches[0].path, via: "basename", ambiguous: baseMatches.map((f) => f.path) };
  }

  // 4) 唯一包含关系（模糊）
  const fuzzy = pool.filter((f) => norm(f.path).includes(t));
  if (fuzzy.length === 1) return { path: fuzzy[0].path, via: "fuzzy" };
  if (fuzzy.length > 1) return { path: null, ambiguous: fuzzy.map((f) => f.path) };

  return { path: null };
}

/** 目标是否在 vault 中存在（live 模式下给未解析链接加样式） */
export function wikilinkExists(raw: string, files: VaultFile[]): boolean {
  return resolveWikilink(raw, files).path !== null;
}
