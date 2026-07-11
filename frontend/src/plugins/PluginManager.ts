import { invoke } from "@tauri-apps/api/core";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
}

export interface PluginCommand {
  id: string;
  name: string;
  callback: () => void;
  editorCallback?: (selectedText: string) => string;
}

export interface PluginView {
  type: string;
  title: string;
  icon?: string;
  render: (container: HTMLElement, filePath: string) => Promise<void>;
}

export type MarkdownPostProcessor = (source: string, el: HTMLElement) => void;

export interface NoteForgePlugin {
  manifest: PluginManifest;
  commands: PluginCommand[];
  views: PluginView[];
  postProcessors: Map<string, MarkdownPostProcessor>;
  onload: () => void;
  onunload: () => void;
}

class PluginManager {
  private plugins: Map<string, NoteForgePlugin> = new Map();

  async loadPlugins(_vaultPath: string): Promise<void> {
    // Built-in: html-effectiveness
    const { createHEPlugin } = await import("./HEPlugin");
    const he = createHEPlugin();
    he.onload();
    this.plugins.set(he.manifest.id, he);
  }

  async loadFromDir(dir: string): Promise<void> {
    try {
      const entries: string[] = await invoke("list_dir", { path: dir });
      for (const entry of entries) {
        try {
          const manifestStr: string = await invoke("read_file", { path: `${dir}/${entry}/plugin.toml` });
          const manifest = JSON.parse(manifestStr) as PluginManifest;
          const plugin: NoteForgePlugin = {
            manifest,
            commands: [], views: [], postProcessors: new Map(),
            onload: () => {}, onunload: () => {},
          };
          this.plugins.set(manifest.id, plugin);
        } catch { /* skip invalid plugin dirs */ }
      }
    } catch { /* plugins dir not found */ }
  }

  getPlugin(id: string): NoteForgePlugin | undefined {
    return this.plugins.get(id);
  }

  getAllPlugins(): NoteForgePlugin[] {
    return Array.from(this.plugins.values());
  }

  getCommands(): PluginCommand[] {
    const cmds: PluginCommand[] = [];
    for (const p of this.plugins.values()) cmds.push(...p.commands);
    return cmds;
  }

  getPostProcessors(): Map<string, MarkdownPostProcessor> {
    const all = new Map<string, MarkdownPostProcessor>();
    for (const p of this.plugins.values()) {
      for (const [key, fn] of p.postProcessors) all.set(key, fn);
    }
    return all;
  }

  getViews(): PluginView[] {
    const views: PluginView[] = [];
    for (const p of this.plugins.values()) views.push(...p.views);
    return views;
  }
}

export const pluginManager = new PluginManager();
