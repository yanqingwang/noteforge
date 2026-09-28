/**
 * HtmlViewer 纯函数测试：相对路径解析 + src/href/url() 改写为 data URL。
 * invoke 走 mock，覆盖图片、CSS、JS、HTML、外链跳过、失败回退与去重。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { resolveVaultPath, rewriteHtml } from "./HtmlViewer";

const DATA_PNG = "data:image/png;base64,SU1H";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("resolveVaultPath（相对路径解析）", () => {
  it("同目录相对路径拼接文件所在目录", () => {
    expect(resolveVaultPath("images/logo.png", "reports")).toBe("reports/images/logo.png");
    expect(resolveVaultPath("./a.png", "reports/sub")).toBe("reports/sub/a.png");
  });

  it("../ 正常回退，/ 视为 vault 根", () => {
    expect(resolveVaultPath("../assets/a.css", "reports/sub")).toBe("reports/assets/a.css");
    expect(resolveVaultPath("/top.png", "reports")).toBe("top.png");
  });

  it("外链 / 锚点 / data / mailto 一律跳过", () => {
    expect(resolveVaultPath("https://x.com/a.png", "reports")).toBeNull();
    expect(resolveVaultPath("http://x.com/a.css", "")).toBeNull();
    expect(resolveVaultPath("data:image/png;base64,xx", "reports")).toBeNull();
    expect(resolveVaultPath("#sec", "reports")).toBeNull();
    expect(resolveVaultPath("mailto:a@b.c", "reports")).toBeNull();
    expect(resolveVaultPath("", "reports")).toBeNull();
  });
});

describe("rewriteHtml（改写为 data URL）", () => {
  it("图片 src 改写为 read_file_data 的 data URL", async () => {
    invokeMock.mockResolvedValueOnce(DATA_PNG);
    const html = `<img src="images/logo.png" alt="logo">`;
    const out = await rewriteHtml(html, "reports");
    expect(out).toContain(`src="${DATA_PNG}"`);
    expect(invokeMock).toHaveBeenCalledWith("read_file_data", { path: "reports/images/logo.png" });
  });

  it("CSS/JS/HTML 改写为 base64 data URL", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_file") return Promise.resolve("body{color:red}");
      return Promise.reject(new Error("unexpected"));
    });
    const out = await rewriteHtml(`<link href="style.css" rel="stylesheet">`, "reports");
    expect(out).toMatch(/href="data:text\/css;charset=utf-8;base64,[A-Za-z0-9+/=]+"/);
  });

  it("外链与锚点保持原样", async () => {
    const html = `<a href="https://example.com/x">ext</a><a href="#top">up</a>`;
    const out = await rewriteHtml(html, "reports");
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('href="#top"');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("CSS url(...)（内联与 style 块）同样改写", async () => {
    invokeMock.mockResolvedValueOnce(DATA_PNG);
    const html = `<style>.a{background:url(images/bg.png)}</style><div style="background:url('images/bg2.png')">x</div>`;
    const out = await rewriteHtml(html, "reports");
    expect(out).toContain(`url("${DATA_PNG}")`);
    expect(out).not.toContain("url(images/");
  });

  it("同一资源引用多次只加载一次", async () => {
    invokeMock.mockResolvedValue(DATA_PNG);
    const html = `<img src="images/logo.png"><img src="images/logo.png">`;
    await rewriteHtml(html, "reports");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("单个资源读取失败时保留原 URL，不阻塞整页", async () => {
    invokeMock.mockRejectedValue(new Error("ENOENT"));
    const html = `<img src="missing.png"><img src="ok.png">`;
    const out = await rewriteHtml(html, "reports");
    expect(out).toContain('src="missing.png"');
  });

  it("无相对引用时原样返回", async () => {
    const html = `<p>plain</p><a href="https://a.b">x</a>`;
    expect(await rewriteHtml(html, "")).toBe(html);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
