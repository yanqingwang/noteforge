/**
 * 应用版本号的单一来源。
 *
 * 版本声明在 src-tauri/tauri.conf.json，运行时由 Tauri 读出（getVersion），
 * 避免 About 对话框 / 状态栏 / PKGBUILD 三处各写一份导致版本漂移
 * （历史上就出现过 UI 显示 0.1.0 而打包是另一个版本的情况）。
 */
import { getVersion } from "@tauri-apps/api/app";

let cached: string | null = null;

/** 取应用版本；非 Tauri 环境（如 vitest/jsdom）返回 "dev" */
export async function appVersion(): Promise<string> {
  if (cached) return cached;
  try {
    cached = await getVersion();
  } catch {
    cached = "dev";
  }
  return cached;
}
