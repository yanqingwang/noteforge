/**
 * 兼容性测试 harness 的打包入口。
 *
 * harness 在 Node + jsdom 里跑，而 shim 源码是 TS 且依赖 CM 模块，所以先用 vite
 * 把「应用侧真正用的那一份 shim」打成独立 ESM 包给 harness 用 —— 这样测出来的
 * 结论对应真实产物，而不是另写一份模拟实现。
 */
export { createObsidianApi, createMemoryHost, MemoryFs, createRecorder } from "./plugins/obsidian/index";
export { evaluatePlugin, installNodeGlobals, createNodeBuiltins, createElectronStub, withNodePrefixAliases } from "./plugins/loader";
export { createCmModules } from "./plugins/obsidian/cm-modules";
export { OBSIDIAN_EXPORT_NAMES } from "./plugins/obsidian/index";
export type { Host, PluginManifest, ObsidianApi } from "./plugins/obsidian/index";