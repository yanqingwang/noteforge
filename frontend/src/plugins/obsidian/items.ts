/** TAbstractFile / TFile / TFolder —— Obsidian 插件最基础的文件句柄类型。 */

import type { Vault } from "./vault";

export abstract class TAbstractFile {
  vault!: Vault;
  path: string;
  name: string;
  parent: TFolder | null = null;

  constructor(path: string) {
    this.path = path;
    this.name = path.includes("/") ? (path.split("/").pop() as string) : path;
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };

  constructor(path: string, stat?: Partial<{ ctime: number; mtime: number; size: number }>) {
    super(path);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
    this.stat = { ctime: 0, mtime: 0, size: 0, ...stat };
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === "" || this.path === "/";
  }
}