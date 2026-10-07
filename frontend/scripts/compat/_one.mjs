/** 调试单个插件用（与 harness 共用同一份 jsdom 环境）：node scripts/compat/_one.mjs <pluginId> */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDom } from "./jsdom-env.mjs";

installDom();
const shim = await import("../../dist-harness/obsidian-shim.mjs");
const id = process.argv[2];
const dir = resolve(import.meta.dirname, ".cache/plugins", id);
const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
const code = readFileSync(resolve(dir, "main.js"), "utf8");
const host = shim.createMemoryHost({ "README.md": "# hi\n" });
const api = shim.createObsidianApi(host, {
  name: "t",
  workspaceHooks: {
    activeFile: () => "README.md",
    openFile: async () => undefined,
    getLeafContainer: () => document.createElement("div"),
  },
});
await api.vault.ensure();
await api.setupBases();
const electron = shim.createElectronStub();
const cm = shim.createCmModules();
const requireMap = {
  obsidian: api.module,
  electron,
  "node:electron": electron,
  ...shim.createNodeBuiltins(),
  ...cm,
  ...Object.fromEntries(Object.entries(cm).map(([k, v]) => [`node:${k}`, v])),
};
try {
  const ev = shim.evaluatePlugin(code, {
    filename: `${dir}/main.js`,
    requireMap: shim.withNodePrefixAliases(requireMap),
  });
  if (ev.error) {
    console.log("求值失败:", ev.error.message);
    console.log(String(ev.error.stack).split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }
  const inst = new ev.defaultExport(api.app, manifest);
  api.registry.add(inst, id);
  await inst.onload?.();
  console.log("加载成功 | 命令:", inst.getCommands().length, "| 视图:", api.workspace.registeredViewTypes().length);
} catch (e) {
  console.log("失败:", e.message);
  console.log(String(e.stack).split("\n").slice(0, 8).join("\n"));
}
