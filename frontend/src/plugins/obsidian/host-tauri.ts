/**
 * 应用侧宿主：把 shim 的 Host 接口接到 Tauri 命令与 CodeMirror 视图上。
 *
 * 与 harness 用内存文件系统不同，这里是真实 vault：所有读写走 invoke，
 * 插件的 app.vault 操作直接落到用户磁盘上的笔记。
 */

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { createCmModules } from "./cm-modules";
import { base64ToBytes, bytesToBase64, type Host } from "./types";
import type { EditorLike } from "./workspace";

export interface HostHooks {
  vaultPath: () => string;
  activeFile: () => string | null;
  openFile: (path: string) => Promise<void>;
  /** 插件视图容器注册表（React 侧登记 DOM 节点） */
  container: (type: string) => HTMLElement | null;
}

/** CM6 EditorView → Obsidian 的 Editor 接口。插件（dataview/tasks 等）重度依赖它。 */
export function createEditorAdapter(view: EditorView | null): EditorLike | null {
  if (!view) return null;
  const toOffset = (pos: { line: number; ch: number }): number => {
    const line = view.state.doc.line(Math.min(Math.max(pos.line + 1, 1), view.state.doc.lines));
    return Math.min(line.from + pos.ch, line.to);
  };
  const toPos = (offset: number): { line: number; ch: number } => {
    const line = view.state.doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  };
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (v: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    },
    getLine: (n: number) => view.state.doc.line(n + 1)?.text ?? "",
    lineCount: () => view.state.doc.lines,
    getSelection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    replaceSelection: (v: string) => {
      const sel = view.state.selection.main;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: v }, scrollIntoView: true });
    },
    replaceRange: (replace, from, to) => {
      view.dispatch({
        changes: { from: toOffset(from), to: to ? toOffset(to) : undefined, insert: replace },
      });
    },
    getCursor: (which?: "from" | "to" | "head" | "anchor") => {
      const sel = view.state.selection.main;
      const anchor = which === "anchor" ? sel.anchor : sel.from;
      const head = which === "from" ? sel.from : which === "to" ? sel.to : sel.head;
      return toPos(which === "anchor" || which === "from" ? anchor : head);
    },
    setCursor: (pos) => {
      const p = Array.isArray(pos) ? pos[0] : pos;
      const off = toOffset(p);
      view.dispatch({ selection: { anchor: off } });
    },
    getScrollInfo: () => ({ top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }),
    scrollTo: (x, y) => {
      view.scrollDOM.scrollTop = y ?? view.scrollDOM.scrollTop;
      view.scrollDOM.scrollLeft = x ?? view.scrollDOM.scrollLeft;
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    cm6: () => view,
    refresh: () => view.requestMeasure(),
  };
}

/** 构造走 Tauri 的 Host。 */
export function createTauriHost(hooks: HostHooks): Host {
  const root = () => hooks.vaultPath();
  return {
    kind: "tauri",
    vaultPath: root,
    fs: {
      list: async (path) => {
        const entries = await invoke<Array<{ path: string; is_dir: boolean; size: number; modified: number }>>(
          "list_dir",
          { vaultRoot: root(), path },
        );
        return entries.map((e) => ({ ...e }));
      },
      read: (path) => invoke<string>("read_file", { path }),
      write: async (path, data) => {
        await invoke("write_note", { notePath: path, content: data });
      },
      remove: async (path) => {
        await invoke("delete_note", { notePath: path });
      },
      mkdir: async (path) => {
        await invoke("make_dir", { vaultRoot: root(), path });
      },
      stat: async (path) => {
        try {
          const s = await invoke<{ mtime_ms: number; size: number }>("stat_note", { notePath: path });
          return { size: s.size, modified: s.mtime_ms };
        } catch {
          return null;
        }
      },
      readBinary: async (path) => {
        const dataUrl = await invoke<string>("read_file_data", { path });
        const b64 = dataUrl.split(",")[1] ?? "";
        return b64;
      },
      writeBinary: async (path, base64) => {
        await invoke("write_attachment", { path, data: Array.from(base64ToBytes(base64)) });
      },
    },
    activeFile: hooks.activeFile,
    openFile: hooks.openFile,
    saveActiveFile: async (content) => {
      const active = hooks.activeFile();
      if (!active) throw new Error("没有活动文件");
      await invoke("write_note", { notePath: active, content });
    },
    cmModules: () => createCmModules(),
    requestContainer: hooks.container,
    renderMarkdown: async (markdown, sourcePath) => {
      void sourcePath;
      return invoke<string>("render_markdown", { content: markdown });
    },
  };
}

/** 供测试与调试：把二进制转 base64（宿主内部也可能用到）。 */
export { bytesToBase64 };
export type { EditorView };