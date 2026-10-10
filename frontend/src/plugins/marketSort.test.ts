/** 插件市场：兼容性徽标 / 下载量格式 / 排序偏好的纯函数测试。 */
import { describe, it, expect } from "vitest";
import {
  compatBadge,
  compatTitle,
  formatDownloads,
  isIncompatible,
  readMarketSort,
  SORT_OPTIONS,
} from "./marketSort";

describe("compatBadge", () => {
  it("按 harness status 映射徽标", () => {
    expect(compatBadge({ s: "pass" }).label).toBe("已测通过");
    expect(compatBadge({ s: "pass-view-error" }).label).toBe("部分可用");
    expect(compatBadge({ s: "pass-settings-error" }).label).toBe("部分可用");
    expect(compatBadge({ s: "load-only" }).label).toBe("仅能加载");
    expect(compatBadge({ s: "fail-onload" }).label).toBe("不兼容");
    expect(compatBadge({ s: "fail-load" }).label).toBe("不兼容");
  });

  it("无记录 = 未测", () => {
    expect(compatBadge(undefined).label).toBe("未测");
    expect(compatBadge({ s: "" }).label).toBe("未测");
  });
});

describe("isIncompatible", () => {
  it("只有 fail-* 算不兼容", () => {
    expect(isIncompatible({ s: "fail-load" })).toBe(true);
    expect(isIncompatible({ s: "pass" })).toBe(false);
    expect(isIncompatible({ s: "load-only" })).toBe(false);
    expect(isIncompatible(undefined)).toBe(false);
  });
});

describe("formatDownloads", () => {
  it("紧凑格式", () => {
    expect(formatDownloads(0)).toBe("");
    expect(formatDownloads(undefined)).toBe("");
    expect(formatDownloads(999)).toBe("999");
    expect(formatDownloads(12345)).toBe("12.3k");
    expect(formatDownloads(2_500_000)).toBe("2.5M");
  });
});

describe("compatTitle", () => {
  it("带出阶段与错误；未测给可安装说明", () => {
    const t = compatTitle({ s: "fail-load", p: "evaluate", e: "boom" });
    expect(t).toContain("不兼容");
    expect(t).toContain("evaluate");
    expect(t).toContain("boom");
    expect(compatTitle(undefined)).toContain("未在兼容性测试样本");
  });
});

describe("排序偏好", () => {
  it("选项为 兼容优先 / 热门 / 官方序，默认 compat", () => {
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual(["compat", "downloads", "official"]);
    localStorage.removeItem("nf-plugin-market-sort");
    expect(readMarketSort()).toBe("compat");
    localStorage.setItem("nf-plugin-market-sort", "downloads");
    expect(readMarketSort()).toBe("downloads");
    localStorage.setItem("nf-plugin-market-sort", "垃圾值");
    expect(readMarketSort()).toBe("compat");
  });
});
