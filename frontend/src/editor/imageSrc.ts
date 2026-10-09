/**
 * 图片 src 解析器：把 vault 相对路径解析为 <img> 可用的 URL。
 *
 * - `"data"`（默认）：`read_file_data` → base64 data URL，与历史行为一致。
 * - `"asset"`：`convertFileSrc(<vaultPath>/<rel>)` → `http://asset.localhost/...`
 *   （Windows/Android 的自定义协议形态）。需要 `tauri.conf.json` 启用
 *   `app.security.assetProtocol`，且 CSP 的 `img-src` 允许 `http://asset.localhost`。
 */
export interface ImageSrcConfig {
  mode: "data" | "asset";
  /** vault 绝对路径（asset 模式需要）。 */
  vaultPath: string;
}

export type ImageSrcResolver = (rel: string) => Promise<string>;

export function makeImageSrcResolver(getCfg: () => ImageSrcConfig): ImageSrcResolver {
  const cache = new Map<string, string>();
  return async (rel: string): Promise<string> => {
    const { mode, vaultPath } = getCfg();
    const key = `${mode}:${rel}`; // 按模式分桶，切换设置后不会命中旧缓存
    const hit = cache.get(key);
    if (hit) return hit;
    let src: string;
    if (mode === "asset") {
      if (!vaultPath) throw new Error("vault 未打开，无法使用 asset 模式");
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const abs = `${vaultPath}/${rel}`.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
      src = convertFileSrc(abs);
    } else {
      const { invoke } = await import("@tauri-apps/api/core");
      src = await invoke<string>("read_file_data", { path: rel });
    }
    cache.set(key, src);
    return src;
  };
}
