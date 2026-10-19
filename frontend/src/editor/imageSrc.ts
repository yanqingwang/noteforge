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

/**
 * 懒同步开关缓存：本地缺失的图片在读取失败时，若同步配置开启了「附件懒同步」，
 * 就调用 sync_fetch_attachment 从服务器按需拉取一次再重试。
 * 配置变更（保存设置）后调用 resetLazyAttachmentCache() 使其重新读取。
 */
let lazyFetchEnabled: boolean | null = null;

export function resetLazyAttachmentCache(): void {
  lazyFetchEnabled = null;
}

async function lazyAttachmentsOn(): Promise<boolean> {
  if (lazyFetchEnabled !== null) return lazyFetchEnabled;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const cfg = await invoke<any>("sync_get_config");
    lazyFetchEnabled = !!cfg?.lazy_sync_attachments;
  } catch {
    lazyFetchEnabled = false;
  }
  return lazyFetchEnabled;
}

export function makeImageSrcResolver(getCfg: () => ImageSrcConfig): ImageSrcResolver {
  const cache = new Map<string, string>();
  const failed = new Set<string>(); // 失败也缓存：预览反复重渲染时不对每个图反复 IPC
  const lazyTried = new Set<string>(); // 每个路径最多按需拉取一次
  return async (rel: string): Promise<string> => {
    const { mode, vaultPath } = getCfg();
    const key = `${mode}:${rel}`; // 按模式分桶，切换设置后不会命中旧缓存
    const hit = cache.get(key);
    if (hit) return hit;
    if (failed.has(key)) throw new Error(`此前解析失败: ${rel}`);
    let src: string;
    try {
      src = await read(mode, vaultPath, rel);
    } catch (e) {
      // 可能是懒同步附件：本地没有实体，但服务器上有
      if (lazyTried.has(rel) || !(await lazyAttachmentsOn())) {
        failed.add(key);
        throw e;
      }
      lazyTried.add(rel);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sync_fetch_attachment", { path: rel });
        src = await read(mode, vaultPath, rel);
      } catch (e2) {
        failed.add(key);
        throw e2;
      }
    }
    cache.set(key, src);
    return src;
  };
}

async function read(mode: ImageSrcConfig["mode"], vaultPath: string, rel: string): Promise<string> {
  if (mode === "asset") {
    if (!vaultPath) throw new Error("vault 未打开，无法使用 asset 模式");
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const abs = `${vaultPath}/${rel}`.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    return convertFileSrc(abs);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("read_file_data", { path: rel });
}
