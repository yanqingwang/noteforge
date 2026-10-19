import { describe, it, expect } from "vitest";
import { scoreMatch, rankCandidates } from "./matchScore";

describe("scoreMatch", () => {
  it("空查询匹配一切（得分 0）", () => {
    expect(scoreMatch("", "a/b.md")).toBe(0);
    expect(scoreMatch("  ", "x")).toBe(0);
  });

  it("basename 精确匹配最优", () => {
    expect(scoreMatch("readme", "docs/readme.md")).toBe(0);
    expect(scoreMatch("README", "docs/readme.md")).toBe(0); // 大小写不敏感
    expect(scoreMatch("readme.md", "docs/readme.md")).toBe(0);
  });

  it("basename 前缀优于路径前缀，路径前缀优于子串", () => {
    const prefixBase = scoreMatch("rep", "reports.md")!;
    const prefixPath = scoreMatch("rep", "reports/单文件报告.html")!;
    const subBase = scoreMatch("ports", "reports.md")!;
    const subPath = scoreMatch("报告", "reports/单文件报告.html")!;
    expect(prefixBase).toBeLessThan(prefixPath);
    expect(prefixPath).toBeLessThan(subBase);
    expect(subBase).toBeLessThan(subPath);
  });

  it("子串起始位置越早分越低", () => {
    const early = scoreMatch("b", "ab.md")!;
    const late = scoreMatch("b", "xxxxab.md")!;
    expect(early).toBeLessThan(late);
  });

  it("子序列匹配（跳字）兜底", () => {
    expect(scoreMatch("rdm", "readme.md")).not.toBeNull();
    expect(scoreMatch("xyz", "readme.md")).toBeNull();
  });
});

describe("rankCandidates", () => {
  const files = [
    { path: "docs/report-2026.md" },
    { path: "reports/单文件报告.html" },
    { path: "readme.md" },
    { path: "archive/old-report.md" },
  ];
  const getText = (f: { path: string }) => f.path;

  it("按匹配质量排序：前缀命中排在子串命中前", () => {
    const out = rankCandidates(files, "report", getText);
    // report-2026.md 与 reports/... 都是前缀级；old-report 是子串级，排最后
    expect(out[out.length - 1].path).toBe("archive/old-report.md");
    expect(out[0].path).not.toBe("archive/old-report.md");
  });

  it("最近使用加权：同等匹配质量下最近的排前", () => {
    // 两个候选同为 basename 前缀匹配且长度相同（同分），recent 决胜
    const tied = [{ path: "b/report-b.md" }, { path: "a/report-a.md" }];
    const out = rankCandidates(tied, "report", getText, ["b/report-b.md"]);
    expect(out[0].path).toBe("b/report-b.md");
  });

  it("最近使用不能逆转匹配质量差距（前缀仍优于子串+recent）", () => {
    const recent = ["archive/old-report.md"];
    const out = rankCandidates(files, "report", getText, recent);
    expect(out[0].path).toBe("docs/report-2026.md");
  });

  it("无匹配时被过滤；limit 生效", () => {
    expect(rankCandidates(files, "zzz", getText)).toEqual([]);
    expect(rankCandidates(files, "", getText, [], 2).length).toBe(2);
  });
});
