/**
 * Obsidian 插件兼容性测试执行器。
 *
 * 做什么：对样本里的每个插件，下载官方产物 → 在 jsdom 里用 noteforge 真实的
 * 兼容层执行 → 记录 require/加载/onload/视图创建四个阶段的成败与缺失 API。
 *
 * 关键点：跑的是 dist-harness/obsidian-shim.mjs（应用侧同一份代码的构建产物），
 * 而不是另写一份模拟实现 —— 否则测出来的结论不能代表真机行为。
 *
 * 用法：
 *   node scripts/compat/run.mjs              # 全量样本
 *   node scripts/compat/run.mjs vault-agent  # 只测指定插件（可多个）
 *   node scripts/compat/run.mjs --no-fetch   # 用缓存，不再下载
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "../..");
const CACHE = resolve(HERE, ".cache");
const REPORTS = "/home/wang/wk/wk/AIReports";
const BUNDLE = resolve(FRONTEND, "dist-harness/obsidian-shim.mjs");

const args = process.argv.slice(2);
const NO_FETCH = args.includes("--no-fetch");
/** 只用已有 compat-results.json 重新生成报告（改报告格式时不必重跑 41 个插件） */
const REPORT_ONLY = args.includes("--report-only");
/** 子进程模式（由父进程 spawn 出来跑单个插件）。 */
const CHILD = process.env.NF_COMPAT_CHILD === "1";
/** 子进程只吐结果 JSON，不做报告。 */
const JSON_ONLY = args.includes("--json-only") || CHILD;
/** 是否每个插件独立进程跑（默认开）。 */
const ISOLATE = !args.includes("--no-isolate") && !CHILD;
/** 父进程给单个子进程的硬杀时限：要比插件内的 90s 墙钟略大，留出下载预算。 */
const CHILD_TIMEOUT_MS = 180_000;
const RESULT_MARKER = "NF_COMPAT_RESULT:";
/** 默认复用已下载的产物（幂等缓存），加 --refresh 才重新走网络。 */
const REFRESH = args.includes("--refresh");

/** 取产物 main.js 某一行的源码片段（诊断「哪个对象缺方法」用）。 */
const _excerptCache = new Map();
function excerptAt(dir, lineNo, colNo = 1, span = 200) {
  try {
    let lines = _excerptCache.get(dir);
    if (!lines) {
      lines = readFileSync(resolve(dir, "main.js"), "utf8").split("\n");
      _excerptCache.set(dir, lines);
    }
    const line = lines[lineNo - 1] ?? "";
    // 从调用点列号往前带一点上下文，读者一眼能看到触发表达式
    const from = Math.max(0, colNo - 2 - 60);
    return line.slice(from, from + span).trim();
  } catch {
    return "";
  }
}
/** --from-vault <路径>：测某个 vault 里已启用的插件（排查「我这台机器上装的东西能不能用」） */
const FROM_VAULT = args.includes("--from-vault") ? args[args.indexOf("--from-vault") + 1] : null;
/**
 * --shared-api：所有插件共用同一个 app 实例（真机就是这样）。
 * 默认每个插件一份干净环境，避免相互污染；但那样会漏掉「A 插件改原型 → B 插件坏」
 * 这类跨插件干扰（nextcloud-sync-yanc 的设置页在真机不出现，单测却通过，就是这类）。
 */
const SHARED_API = args.includes("--shared-api");
/** 命令行里的插件 id（不含 --from-vault 后面那个路径值）。 */
const ONLY = args.filter(
  (a, i) => !a.startsWith("--") && args[i - 1] !== "--from-vault",
);

const CDN = "https://cdn.jsdelivr.net/gh";
const CDNDATA = "https://data.jsdelivr.com/v1/packages/gh";

/**
 * GitHub 代理：本机到 github.com / raw.githubusercontent.com / Release 资产不可达，
 * 实测 ghfast.top 与 gh-proxy.com 都能取到 Release 资产。Obsidian 官方插件浏览器
 * 就是从 Release 资产下载的，所以这是必需的第二条路径。
 */
const GH_PROXIES = ["https://ghfast.top", "https://gh-proxy.com"];

import { installDom } from "./jsdom-env.mjs";

/* ---------------- 下载 ---------------- */

async function fetchWithRetry(url, { binary = false } = {}) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "noteforge-compat-check" } });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
      return { ok: true, status: res.status, body };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 700 * i));
    }
  }
  return { ok: false, status: 0, error: String(last?.message ?? last) };
}

/** jsDelivr 版本列表（不走 GitHub API，无 60 次/小时限流）。 */
async function listVersions(repo) {
  const r = await fetchWithRetry(`${CDNDATA}/${repo}`);
  if (!r.ok) return [];
  try {
    return (JSON.parse(r.body).versions ?? []).map((v) => v.version);
  } catch {
    return [];
  }
}

/**
 * 取插件产物。Obsidian 官方浏览器从 GitHub Release 下载，但本机到
 * github.com / raw.githubusercontent.com 不可达，所以优先走 jsDelivr：
 *   1) 默认分支（多数插件把 main.js 提交进仓库）
 *   2) 版本 tag（jsDelivr 版本列表里最新几个）
 */
async function fetchPluginFiles(plugin) {
  const dir = resolve(CACHE, "plugins", plugin.id);
  const mf = resolve(dir, "manifest.json");
  const mj = resolve(dir, "main.js");
  // 已下载过就直接复用：41 个插件每次都重新校验网络会让 re-run 慢一个数量级
  if (!REFRESH && !NO_FETCH && existsSync(mf) && existsSync(mj)) {
    try {
      return {
        dir,
        manifest: JSON.parse(readFileSync(mf, "utf8")),
        source: "cache",
        ref: "cache",
        bytes: statSync(mj).size,
      };
    } catch {
      /* 缓存损坏则重新下载 */
    }
  }
  if (NO_FETCH && existsSync(mf) && existsSync(mj)) {
    return { dir, manifest: JSON.parse(readFileSync(mf, "utf8")), source: "cache", ref: "cache", bytes: statSync(mj).size };
  }
  mkdirSync(dir, { recursive: true });

  // jsDelivr 不带 ref 时用的是仓库的 "default branch"，但它探测的分支名不一定对
  // （实测 yanqingwang/opensource-AI-vault-agent 是 master，探测成 main 就 404），
  // 所以显式把 main/master/版本 tag 都试一遍。
  const versions = await listVersions(plugin.repo);
  const candidateRefs = [...new Set(["", "master", "main", ...versions.slice(0, 5)])];

  const releaseUrl = (proxy, file) => `${proxy}/https://github.com/${plugin.repo}/releases/latest/download/${file}`;

  // 路径一：jsDelivr（仓库里直接提交了 main.js 的插件）
  let manifest = null;
  let manifestRef = "";
  for (const ref of candidateRefs) {
    const r = await fetchWithRetry(`${CDN}/${plugin.repo}${ref ? `@${ref}` : ""}/manifest.json`);
    if (r.ok) {
      try {
        manifest = JSON.parse(r.body);
        manifestRef = ref;
        writeFileSync(mf, r.body);
        break;
      } catch {
        /* 不是合法 manifest，继续试下一个 ref */
      }
    }
  }

  // 路径二：GitHub Release 资产（经代理）—— 多数头部插件只在这里发 main.js
  let release = false;
  if (!manifest) {
    for (const proxy of GH_PROXIES) {
      const r = await fetchWithRetry(releaseUrl(proxy, "manifest.json"));
      if (!r.ok) continue;
      try {
        manifest = JSON.parse(r.body);
        writeFileSync(mf, r.body);
        release = true;
        break;
      } catch {
        continue;
      }
    }
  }
  if (!manifest) {
    return { dir, error: "取不到 manifest.json（jsDelivr 与 Release 代理都不可达）" };
  }

  let mainRef = "";
  if (!release) {
    const mainRefs = [...new Set([manifestRef, manifest.version ? `${manifest.version}` : "", ...candidateRefs])];
    for (const ref of mainRefs) {
      const r = await fetchWithRetry(`${CDN}/${plugin.repo}${ref ? `@${ref}` : ""}/main.js`, { binary: true });
      if (r.ok && r.body.length > 0) {
        writeFileSync(mj, r.body);
        mainRef = ref;
        break;
      }
    }
  }
  if (!mainRef) {
    for (const proxy of GH_PROXIES) {
      const r = await fetchWithRetry(releaseUrl(proxy, "main.js"), { binary: true });
      if (r.ok && r.body.length > 0) {
        writeFileSync(mj, r.body);
        mainRef = `${new URL(proxy).host}/releases/latest`;
        break;
      }
    }
  }
  if (!mainRef) {
    return { dir, manifest, error: "取不到 main.js（jsDelivr 无产物，Release 代理也不可达）" };
  }

  // styles.css 是可选的，取不到不影响结论
  if (release) {
    for (const proxy of GH_PROXIES) {
      const r = await fetchWithRetry(releaseUrl(proxy, "styles.css"));
      if (r.ok) {
        writeFileSync(resolve(dir, "styles.css"), r.body);
        break;
      }
    }
  } else {
    const r = await fetchWithRetry(`${CDN}/${plugin.repo}${mainRef ? `@${mainRef}` : ""}/styles.css`);
    if (r.ok) writeFileSync(resolve(dir, "styles.css"), r.body);
  }

  return { dir, manifest, ref: mainRef || "(default branch)", bytes: readFileSync(mj).length };
}

/* ---------------- 单插件测试 ---------------- */

/** 单个插件的墙钟上限（毫秒）。 */
const PLUGIN_TIMEOUT_MS = 90_000;
/** 单个插件下载产物��总预算（毫秒）。 */
const FETCH_BUDGET_MS = 120_000;

const VAULT_FILES = {
  "README.md": "# 测试 vault\n\n这是兼容性测试用的样本 vault。\n\n## 章节\n\n- 列表项一\n- 列表项二\n",
  "笔记/想法.md": "# 想法\n\n#标签1 #标签2\n\n[[README]] 双链\n\n```js\nconst a = 1;\n```\n",
  "笔记/子目录/深层.md": "# 深层笔记\n\nfrontmatter 测试\n",
  "项目/计划.md": "---\ntitle: 计划\ntags: [计划, 项目]\n---\n\n# 计划\n\n| 项 | 状态 |\n| --- | --- |\n| A | 进行中 |\n",
  "附件/图.png": "not-a-real-png",
  // 给「插件接管自定义扩展名」的视图用：quadrant-chart 这类插件靠它渲染图表
  "sample.canvas": "---\nchart: 1\ntitle: 样本图\ncells:\n  - label: A\n  - label: B\n---\n",
  ".obsidian/app.json": '{"attachmentFolderPath":"附件"}\n',
  ".obsidian/community-plugins.json": "[]\n",
};

/**
 * 命令冒烟白名单：pluginId → 要真跑一遍的命令 id。
 *
 * 只放「本地文件操作 + 不需要交互」的写路径命令 —— 这些命令挂了或没产出文件，
 * 插件就算"加载通过"也是不能用。跑之前后的 vault 文件差集就是产出证据。
 * 弹窗类（create-chart）、网络类（sync-now）不放进来：会卡住或需要交互。
 */
const COMMAND_SMOKE = {
  "md-to-html-effect": ["md-to-html-effect:convert-md-to-html", "md-to-html-effect:convert-batch-md-to-html"],
  "html-effectiveness": ["html-effectiveness:export-note"],
  "html-to-md-effect": [],
  "quadrant-chart": [],
  "obsidian-nextcloud-sync-yanc": [],
};

async function testPlugin(shim, plugin, sharedApi = null) {
  const t0 = Date.now();
  const result = {
    id: plugin.id,
    name: plugin.name,
    category: plugin.category,
    downloads: plugin.downloads,
    repo: plugin.repo,
    status: "unknown",
    phase: null,
    error: null,
    commands: 0,
    views: 0,
    settingTabs: 0,
    editorExtensions: 0,
    postProcessors: 0,
    cmModulesUsed: [],
    commandIds: [],
    viewShells: {},
    unresolvedRequires: [],
    unsupportedApi: {},
    apiErrors: {},
    bytes: 0,
    manifestVersion: null,
    ref: null,
  };

  // 产物下载也要有总预算：单 URL 25s×3 次重试×多个源（jsDelivr 多个版本 + GitHub 代理）
  // 累加起来能到几分钟，实测 120 样本的轮次被一个插件的下载拖了半小时。
  let files = await Promise.race([
    fetchPluginFiles(plugin),
    new Promise((res) => setTimeout(() => res({ error: `下载超时（${FETCH_BUDGET_MS / 1000}s）` }), FETCH_BUDGET_MS)),
  ]);
  // 本地 vault 的插件：直接从 vault 目录取产物
  if (files.error && FROM_VAULT) {
    const src = resolve(FROM_VAULT, ".obsidian/plugins", plugin.id);
    const cached = resolve(CACHE, "plugins", plugin.id);
    try {
      mkdirSync(cached, { recursive: true });
      let mfText = null;
      for (const f of ["manifest.json", "main.js", "styles.css"]) {
        const from = resolve(src, f);
        if (existsSync(from)) readFileSync(from, "utf8");
      }
      mfText = readFileSync(resolve(src, "manifest.json"), "utf8");
      writeFileSync(resolve(cached, "manifest.json"), mfText);
      writeFileSync(resolve(cached, "main.js"), readFileSync(resolve(src, "main.js"), "utf8"));
      if (existsSync(resolve(src, "styles.css"))) {
        writeFileSync(resolve(cached, "styles.css"), readFileSync(resolve(src, "styles.css"), "utf8"));
      }
      files = {
        dir: cached,
        manifest: JSON.parse(mfText),
        ref: "local vault",
        bytes: readFileSync(resolve(cached, "main.js")).length,
      };
    } catch (e) {
      files.error = `${files.error}（vault 目录也没有产物：${e.message}）`;
    }
  }
  if (files.error) {
    result.status = "artifact-unavailable";
    result.phase = "download";
    result.error = files.error;
    result.ms = Date.now() - t0;
    return result;
  }
  result.bytes = files.bytes ?? 0;
  result.ref = files.ref;
  result.manifestVersion = files.manifest.version ?? null;

  // 每个插件一份干净的 app/vault 环境，避免相互污染（--shared-api 时复用同一个）
  const host = shim.createMemoryHost({ ...VAULT_FILES });
  const containers = sharedApi?.containers ?? new Map();
  const api =
    sharedApi?.api ??
    shim.createObsidianApi(host, {
      name: "compat-vault",
    workspaceHooks: {
      activeFile: () => "README.md",
      openFile: async (p) => {
        await host.openFile?.(p);
      },
      getLeafContainer: (type) => {
        if (!containers.has(type)) {
          const d = document.createElement("div");
          d.className = `nf-leaf nf-leaf-${type}`;
          document.body.appendChild(d);
          containers.set(type, d);
        }
        return containers.get(type);
      },
    },
  });

  // 索引先就绪（与真机一致）
  await api.vault.ensure();

  const cm = shim.createCmModules();
  const code = readFileSync(resolve(files.dir, "main.js"), "utf8");
  const electron = shim.createElectronStub();
  const requireMap = {
    obsidian: api.module,
    electron,
    "node:electron": electron,
    ...cm,
    ...shim.withNodePrefixAliases(shim.createNodeBuiltins()),
  };

  const ev = shim.evaluatePlugin(code, { filename: `${files.dir}/main.js`, requireMap });
  result.cmModulesUsed = ev.required.filter((r) => r.name.startsWith("@")).map((r) => r.name);
  result.unresolvedRequires = [...new Set(ev.unresolved)];

  if (ev.error) {
    result.status = "fail-load";
    result.phase = "evaluate";
    result.error = ev.error.message.split("\n")[0];
    result.errorStack = String(ev.error.stack ?? "").split("\n").slice(1, 5).join(" | ");
    // 类定义阶段崩掉时，缺失的导出才是根因，必须记下来
    result.unsupportedApi = api.recorder.snapshot().unsupported;
    result.accessedApi = api.recorder.snapshot().accessed;
    result.ms = Date.now() - t0;
    return result;
  }

  const PluginClass = ev.defaultExport;
  if (typeof PluginClass !== "function") {
    result.status = "fail-load";
    result.phase = "export";
    result.error = `默认导出不是类（实际 ${typeof PluginClass}）`;
    result.ms = Date.now() - t0;
    return result;
  }

  let instance;
  try {
    instance = new PluginClass(api.app, files.manifest);
  } catch (e) {
    result.status = "fail-construct";
    result.phase = "construct";
    result.error = String(e?.message ?? e).split("\n")[0];
    result.ms = Date.now() - t0;
    return result;
  }

  // 和真机一样：构造完就按「插件目录名」登记进 registry。
  // 目录名与 manifest.id 不一致的插件（obsidian-nextcloud-sync-yanc 就是），
  // 如果登记键用错，宿主按目录 id 取插件就会取不到 —— 表现为
  // 「插件能加载、命令也在，但设置入口整个消失」。harness 必须走同一条路才测得出来。
  api.registry.add(instance, plugin.id);

  try {
    await instance.onload?.();
  } catch (e) {
    result.status = "fail-onload";
    result.phase = "onload";
    result.error = String(e?.message ?? e).split("\n")[0];
    result.errorStack = String(e?.stack ?? "").split("\n").slice(0, 6).join(" | ");
    const snap = api.recorder.snapshot();
    result.unsupportedApi = snap.unsupported;
    result.accessedApi = snap.accessed;
    result.topApi = Object.entries(snap.calls).slice(-14).map(([k, v]) => `${k}×${v}`);
    result.apiErrors = Object.fromEntries(
      Object.entries(snap.errors).map(([k, v]) => [k, v.message.split("\n")[0]]),
    );
    result.ms = Date.now() - t0;
    return result;
  }

  // 让 onload 里的异步任务（setTimeout 0 / Promise）落地
  await new Promise((r) => setTimeout(r, 80));

  // 关键校验：宿主视角的取法（按目录 id），不是插件实例直连
  const registered = api.registry.get(plugin.id);
  if (!registered) {
    result.status = "fail-registry";
    result.phase = "registry";
    result.error = `注册表按目录 id "${plugin.id}" 取不到插件（manifest.id = ${instance.manifest?.id}），宿主将看不到它的命令与设置页`;
    result.ms = Date.now() - t0;
    return result;
  }
  result.commands = registered.getCommands?.().length ?? 0;
  result.settingTabs = registered.getSettingTabs?.().length ?? 0;
  // 命令 id 快照：功能级验证要靠它确认「该有的命令都在」，光有数量说明不了问题
  result.commandIds = (registered.getCommands?.() ?? []).map((c) => c.id ?? c.name ?? "?");
  result.editorExtensions = api.registry.editorExtensions.length;
  result.postProcessors = api.registry.postProcessors.size;
  result.views = [...api.workspace.factories.keys()].length;

  // 视图工厂存在 ≠ 能创建成功：真正建一次，很多插件的问题在这里才暴露
  const viewErrors = [];
  for (const type of [...api.workspace.factories.keys()]) {
    try {
      const leaf = api.workspace.getLeaf(true);
      // 被插件接管的扩展名（如 quadrant-chart 的 .mdx）走它自己的视图，
      // 必须带上真实文件才测得到渲染 —— 否则 FileView 子类会停在「打开了但没内容」，
      // 而这一阶段恰恰看不出来（象限图画布会是空图）。
      const ownedExt = api.workspace.registeredExtensions().find(
        (e) => api.workspace.viewTypeForExtension(e) === type,
      );
      let state = { type, active: true, state: {} };
      if (ownedExt) {
        let samplePath = `sample.${ownedExt}`;
        if (!VAULT_FILES[samplePath]) {
          // 样本 vault 里没有这个扩展名的文件就现造一个（内容给通用 frontmatter）
          samplePath = `sample.${ownedExt}`;
          try {
            await api.vault.create(samplePath, "---\ntitle: 样本\n---\n\n样本内容\n");
          } catch {
            continue;
          }
        }
        state = { type, active: true, state: { file: samplePath } };
      }
      const factory = api.workspace.getViewFactory(type);
      if (!factory) continue;
      const view = factory(leaf);
      view.app = api.app;
      // 走 Obsidian 的完整顺序：setState → onOpen → onLoadFile。
      // 少调 onLoadFile 的话 FileView 子类会停在"打开了但没内容"的状态
      //（quadrant-chart 的画布会是空图），而这一阶段恰恰看不出来。
      if (state && typeof view.setState === "function") await view.setState(state, null);
      await view.onOpen?.();
      if (view.file && typeof view.onLoadFile === "function") await view.onLoadFile(view.file);
      // 等一拍再量：不少视图是异步渲染的（Svelte 面板、动态 import）
      await new Promise((r) => setTimeout(r, 120));
      // DOM 摘要：判断「视图真的画出了东西」而不只是「没抛错」
      const root = view.contentEl ?? view.containerEl;
      if (root) {
        result.viewShells ??= {};
        result.viewShells[type] = {
          children: root.childElementCount,
          textLen: (root.textContent ?? "").trim().length,
          tags: [...new Set([...root.querySelectorAll("*")].map((e) => e.tagName.toLowerCase()))]
            .filter((t) => ["canvas", "svg", "input", "table", "pre", "iframe", "img"].includes(t))
            .slice(0, 8),
        };
      }
      view.onunload?.();
    } catch (e) {
      viewErrors.push(`${type}: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  if (viewErrors.length) result.viewErrors = viewErrors;

  // 设置页是插件崩溃的常见位置：很多插件在 onload 里注册，设置页首次 display 才炸
  const tabErrors = [];
  for (const tab of registered.getSettingTabs?.() ?? []) {
    try {
      // 与应用侧同一个渲染器：声明式（1.13 getSettingDefinitions）与命令式 display 都走它，
      // 否则「只实现声明式」的插件在这里会被误判成空设置页。
      const body = tab.contentEl ?? tab.containerEl;
      if (body && !tab.containerEl.contains(body)) tab.containerEl.appendChild(body);
      body.replaceChildren();
      // 渲染器内部已按 Obsidian 语义分流：有定义走声明式，没定义才调 display()
      // 行数由渲染器自己报（它知道画到哪儿去了：contentEl 还是 containerEl）
      shim.renderSettingTab(tab, body);
      // 等内容长出来：不少插件是异步渲染的（Svelte 面板、await 之后再画）
      const rows = await shim.waitForSettingRows(tab, body);
      // 不抛错但一行都没画出来，同样是坏的（写错容器、只在某平台渲染、定义全被谓词过滤掉）
      if (rows === 0) {
        const root = tab.containerEl;
        tabErrors.push(
          `渲染后设置页为空（containerEl 子元素=${root?.childElementCount ?? -1}, ` +
            `行=${root?.querySelectorAll(".nf-setting-item,.nf-setting-group").length ?? -1}, ` +
            `containerEl 文本长度=${root?.textContent?.length ?? -1}, ` +
            `contentEl 文本长度=${tab.contentEl?.textContent?.length ?? -1}）`,
        );
      } else {
        result.settingRows = (result.settingRows ?? 0) + rows;
      }
    } catch (e) {
      tabErrors.push(String(e?.message ?? e).split("\n")[0]);
      // 保留调用点堆栈：设置页报错只给 message 无法定位（同一个 message 可能是别的类缺方法）
      const frames = String(e?.stack ?? "")
        .split("\n")
        .slice(1)
        .filter((l) => l.includes(".cache/plugins"))
        .slice(0, 3)
        .map((l) => {
          const at = l.match(/main\.js:(\d+):(\d+)/);
          const around = at ? excerptAt(files.dir, Number(at[1]), Number(at[2])) : "";
          return `${l.trim()}${around ? ` → ${around}` : ""}`;
        });
      if (frames.length) result.settingTabStacks = [...(result.settingTabStacks ?? []), ...frames];
    }
  }
  if (tabErrors.length) result.settingTabErrors = tabErrors;

  // 命令冒烟：白名单里的命令真跑一遍，看有没有产出文件
  const smokeIds = COMMAND_SMOKE[plugin.id] ?? [];
  if (smokeIds.length) {
    // 每个插件都从干净 vault 开始：上一个插件冒烟产出的文件会让下一个插件
    // 走「已存在则跳过」的分支，测出来是假的（md-to-html 与 export-note 都写 README.html）
    for (const f of api.vault.getFiles()) {
      if (!VAULT_FILES[f.path]) {
        try {
          await api.vault.delete(f);
        } catch {
          /* 删不掉就算了，冒烟结果里会体现出来 */
        }
      }
    }
    const before = new Set(api.vault.getFiles().map((f) => f.path));
    result.commandSmoke = {};
    for (const id of smokeIds) {
      const cmd = (registered.getCommands?.() ?? []).find((c) => c.id === id);
      if (!cmd) {
        result.commandSmoke[id] = { ok: false, error: "命令未注册" };
        continue;
      }
      // Obsidian 语义：命令可以只实现 checkCallback —— 先用 checking=true 问"现在能不能用"，
      // 再用 checking=false 触发执行。只调 callback 会把这类命令判成"成功但啥也没干"
      // （md-to-html-effect 的转换命令就是 checkCallback，之前一直是假阳性）。
      let run;
      if (typeof cmd.checkCallback === "function") {
        let available = false;
        try {
          available = Boolean(cmd.checkCallback(true));
        } catch (e) {
          result.commandSmoke[id] = { ok: false, error: `checkCallback 抛错：${String(e?.message ?? e).split("\n")[0]}` };
          continue;
        }
        if (!available) {
          result.commandSmoke[id] = { ok: false, error: "checkCallback 返回 false（当前上下文不可用，如没有活动文件）" };
          continue;
        }
        run = () => cmd.checkCallback(false);
      } else if (typeof cmd.callback === "function") {
        run = () => cmd.callback();
      } else {
        result.commandSmoke[id] = { ok: false, error: "命令既没有 callback 也没有 checkCallback" };
        continue;
      }
      try {
        await Promise.race([
          Promise.resolve(run()),
          new Promise((_, rej) => setTimeout(() => rej(new Error("命令 10s 未返回（可能卡在弹窗或网络）")), 10000)),
        ]);
        // 插件常写成 `void doAsyncWork()`（不 await），命令回调立刻返回。
        // 直接取快照会看不到产出，所以轮询等一小会儿。
        let added = [];
        for (let i = 0; i < 20; i++) {
          added = api.vault.getFiles().map((f) => f.path).filter((f) => !before.has(f));
          if (added.length) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        result.commandSmoke[id] = { ok: true, newFiles: added };
      } catch (e) {
        result.commandSmoke[id] = { ok: false, error: String(e?.message ?? e).split("\n")[0] };
      }
    }
  }

  const snap = api.recorder.snapshot();
  result.unsupportedApi = snap.unsupported;
  result.accessedApi = snap.accessed;
  result.apiErrors = Object.fromEntries(
    Object.entries(snap.errors).map(([k, v]) => [k, v.message.split("\n")[0]]),
  );
  result.topApi = Object.entries(snap.calls).slice(0, 12).map(([k, v]) => `${k}×${v}`);

  const functional = result.commands + result.views + result.settingTabs + result.editorExtensions + result.postProcessors;
  result.status = functional > 0 ? "pass" : "load-only";
  if (viewErrors.length && result.status === "pass") result.status = "pass-view-error";
  // 设置页崩也算「不可用」：插件能加载但用户一开设置就报错，等于没装成。
  // 早先只记 settingTabErrors 字段、状态仍报 pass，导致 iconic 被误判为完全可用。
  if (tabErrors.length && (result.status === "pass" || result.status === "pass-view-error")) {
    result.status = "pass-settings-error";
  }

  try {
    await instance.onunload?.();
  } catch {
    /* 忽略卸载异常 */
  }
  result.ms = Date.now() - t0;
  return result;
}

/** 生成 Markdown 报告（main 与 --report-only 共用）。 */
function writeReport(results, sample, summary) {
  mkdirSync(REPORTS, { recursive: true });

  // 聚合量在这里自算：--report-only 也要能出同样的表
  const agg = (pick) => {
    const m = new Map();
    for (const r of results) for (const [k, v] of Object.entries(pick(r) ?? {})) m.set(k, (m.get(k) ?? 0) + v);
    return m;
  };
  const apiFreq = agg((r) => r.unsupportedApi);
  const apiUsed = agg((r) => r.accessedApi);
  const errorFreq = new Map();
  for (const r of results) {
    for (const [k, v] of Object.entries(r.apiErrors ?? {})) {
      if (!errorFreq.has(v)) errorFreq.set(v, []);
      errorFreq.get(v).push(r.id);
    }
  }
  const countOf = (pick) => {
    const m = new Map();
    for (const r of results) for (const v of pick(r) ?? []) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const cmUsed = countOf((r) => r.cmModulesUsed);
  const unresolved = countOf((r) => r.unresolvedRequires);
// 本地日期：ISO 是 UTC，凌晨跑批会把报告写成前一天
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const md = [
  `# NoteForge × Obsidian 插件兼容性测试报告`,
  ``,
  `**报告日期：${today}**`,
  ``,
  `## 执行摘要`,
  ``,
  `对官方市场（${sample.totalInMarketplace} 个插件）按下载量分层抽取的 ${results.length} 个插件，在 Node+jsdom 里用 noteforge 真实的 Obsidian 兼容层（\`dist-harness/obsidian-shim.mjs\`，即应用侧同一份代码的构建产物）执行产物 main.js，记录 require / 求值 / 构造 / onload / 视图创建 五个阶段的结果。`,
  ``,
  `**判定口径**：\`pass\` = onload 成功且注册了命令/视图/后处理器；\`pass-view-error\` = 加载正常但视图实例化或设置页渲染出错；\`pass-settings-error\` = 加载正常但插件设置页渲染抛错；\`load-only\` = 加载成功但没有任何可用能力；\`fail-*\` = 求值/构造/onload 抛错；\`artifact-unavailable\` = 本机网络取不到产物。`,
  ``,
  `| 判定 | 数量 | 含义 |`,
  `| --- | --- | --- |`,
  `| ✅ 完全可用 | ${summary.passed} | onload 成功且注册了命令/视图/后处理器 |`,
  `| ⚠️ 可用但视图创建出错 | ${summary.viewError} | 加载正常，视图实例化抛错 |`,
  `| ⚠️ 可用但设置页出错 | ${summary.settingsError} | 加载正常，打开插件设置页时抛错 |`,
  `| 🟡 仅加载 | ${summary.loadOnly} | onload 成功但没注册任何可用能力 |`,
  `| ❌ 失败 | ${summary.failed} | 求值/构造/onload 抛错 |`,
  `| 📦 产物不可达 | ${summary.artifactMissing} | 本机网络到 github.com 不可达（Release-only 发布） |`,
  ``,
  `## 逐插件结果`,
  ``,
  `| 插件 | 类别 | 下载量 | 结论 | 命令 | 视图 | 后处理 | 设置页 | CM 模块 | 首个错误 |`,
  `| --- | --- | ---: | --- | ---: | ---: | ---: | --- | ---: | --- |`,
  ...results.map(
    (r) =>
      `| \`${r.id}\` | ${r.category} | ${r.downloads.toLocaleString()} | ${r.status} | ${r.commands} | ${r.views} | ${r.postProcessors} | ${r.settingTabErrors ? "❌" : r.settingTabs ? "✅" : "-"} | ${r.cmModulesUsed.length} | ${fmtErr(r.error || (r.settingTabErrors?.[0] ?? "")).replace(/\|/g, "\\|")} |`,
  ),
  ``,
  `## 未通过插件的根因分类`,
  ``,
  (() => {
    const cat = (r) => {
      const err = `${r.error ?? ""} ${r.errorStack ?? ""}`;
      if (r.status === "pass-view-error") return "视图创建/交互期出错";
      if (r.status === "pass-settings-error") return "插件设置页渲染出错";
      if (err.includes("combine")) return "插件自带 lezer 解析器（与宿主 @lezer/common 双实例）";
      if (err.includes("Class extends value undefined") || err.includes("without 'new'")) {
        return "基类语义不匹配（把 Plugin 当普通类调用 / 缺某基类）";
      }
      if (err.includes("JSON at position")) return "解析宿主返回的数据失败（插件读全局状态做 JSON.parse）";
      if (err.includes("Symbol(")) return "插件自用 Symbol 注册表，与宿主事件系统不一致";
      if (err.includes("reading 'bind'")) return "插件自带 SDK 在 webview 初始化失败（多为同步 SDK）";
      if (err.includes("appendChild") || err.includes("createEl")) return "依赖 Obsidian 内部 DOM / CodeMirror 5 兼容层";
      if (err.includes("this.component.load")) return "内嵌块 API 形状不匹配（embed.load 语义）";
      if (err.includes("getPrototypeOf") || err.includes("embedByExtension")) return "内嵌块 / 内建 API 的形状差异";
      if (/\.map|\.replace|\.from|instanceOf/.test(err)) return "插件内部对宿主返回值的形状假设不成立";
      if (/fs\.|child_process|crypto|spawn/.test(err)) return "需要 Node 文件系统 / 子进程";
      if (/Worker|worker/.test(err)) return "需要 Web Worker";
      if (/moment/.test(err)) return "moment 语义差异";
      if (r.asyncErrors?.length) return "异步期异常（onload 之后）";
      return "其它";
    };
    const groups = new Map();
    for (const r of results) {
      if (r.status === "pass" || r.status === "artifact-unavailable") continue;
      const k = cat(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const lines = ["| 根因 | 数量 | 插件 |", "| --- | ---: | --- |"];
    for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`| ${k} | ${rs.length} | ${rs.map((r) => `\`${r.id}\``).join(", ")} |`);
    }
    return lines.join("\n");
  })(),
  ``,
  `## shim 缺失的 API（按被访问次数）`,
  ``,
  apiFreq.size
    ? ["| API | 访问次数 | 受影响插件 |", "| --- | ---: | ---: |", ...[...apiFreq].slice(0, 30).map(([k, v]) => `| \`${k}\` | ${v} | - |`)].join("\n")
    : "（无：所有被访问的导出都已实现）",
  ``,
  `## 运行期错误（按出现插件数）`,
  ``,
  errorFreq.size
    ? ["| 错误 | 插件数 | 插件 |", "| --- | ---: | --- |", ...[...errorFreq].slice(0, 25).map(([k, v]) => `| ${k.replace(/\|/g, "\\|").slice(0, 120)} | ${v.length} | ${v.slice(0, 6).join(", ")} |`)].join("\n")
    : "（无）",
  ``,
  `## 插件用到的 obsidian API（被访问次数最多的前 30 个）`,
  ``,
  apiUsed.size
    ? ["| API | 插件数 |", "| --- | ---: |", ...[...apiUsed].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `| \`${k}\` | ${v} |`)].join("\n")
    : "（无）",
  ``,
  `## 插件用到的 CodeMirror 模块`,
  ``,
  ["| 模块 | 插件数 |", "| --- | ---: |", ...[...cmUsed].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| \`${k}\` | ${v} |`)].join("\n"),
  ``,
  `## 未能解析的 require`,
  ``,
  unresolved.size
    ? ["| 模块 | 次数 |", "| --- | ---: |", ...[...unresolved].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `| \`${k}\` | ${v} |`)].join("\n")
    : "（无）",
  ``,
  `## 复现方式`,
  ``,
  "```bash",
  "cd code/noteforge/frontend",
  "npx vite build --config vite.harness.config.ts   # 打 harness 包",
  "node scripts/compat/select-sample.mjs 40          # 生成分层样本",
  "node scripts/compat/run.mjs                        # 跑全量",
  "```",
  ``,
  `产物路径：\`code/noteforge/frontend/scripts/compat/compat-results.json\``,
  ``,
].join("\n");

  const mdFile = resolve(REPORTS, `noteforge-obsidian-plugin-compat-${today}.md`);
  writeFileSync(mdFile, md);
  console.log(`报告已写入 ${mdFile}`);
}

/* ---------------- 主流程 ---------------- */

function fmtErr(s) {
  if (!s) return "";
  return String(s).length > 150 ? `${String(s).slice(0, 150)}…` : String(s);
}

/**
 * 独立进程跑一个插件（默认路径）。
 *
 * 为什么必须独立进程：有些插件会陷入**同步死循环或微任务饥饿** ——
 * google-calendar 内置日历库的分页是 `while (有下一页) await request(...)`，
 * 撞上永远返回"同样 items + 非空 nextPageToken"的桩之后，await 只让出微任务，
 * 事件循环没机会跑，任何 setTimeout 型超时都不触发（实测烧掉 4 分钟 CPU、整轮停摆）。
 * 进程隔离 + 硬杀是唯一能兜住这种情况的办法。
 */
async function runIsolated(plugin) {
  // 只把「模式开关」传下去，不能把父进程命令行里的其它插件 id 带过去
  //（带过去子进程会连着测好几个插件，然后撞上超时）。
  const MODE_FLAGS = new Set([
    "--no-fetch",
    "--refresh",
    "--from-vault",
    "--shared-api",
    "--report-only",
    "--no-isolate",
  ]);
  const modeArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    if (a === "--from-vault") {
      modeArgs.push(a, args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (MODE_FLAGS.has(a)) modeArgs.push(a);
  }
  const childArgs = [fileURLToPath(import.meta.url), ...modeArgs, "--only", plugin.id, "--json-only"];
  const started = Date.now();
  const proc = spawnSync(process.execPath, childArgs, {
    timeout: CHILD_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NF_COMPAT_CHILD: "1" },
  });
  const out = `${proc.stdout ?? ""}`;
  const at = out.lastIndexOf(RESULT_MARKER);
  if (at >= 0) {
    try {
      const r = JSON.parse(out.slice(at + RESULT_MARKER.length).split("\n")[0]);
      r.ms = Date.now() - started;
      return r;
    } catch {
      /* 落到下面的失败合成 */
    }
  }
  return {
    id: plugin.id,
    name: plugin.name,
    category: plugin.category,
    downloads: plugin.downloads,
    repo: plugin.repo,
    status: "fail-harness",
    phase: "isolate",
    error: proc.error
      ? `子进程异常：${proc.error.message}`
      : `子进程未产出结果（${proc.signal ? `被信号 ${proc.signal} 杀死` : `退出码 ${proc.status}`}），判定为挂死`,
    commands: 0,
    views: 0,
    settingTabs: 0,
    editorExtensions: 0,
    postProcessors: 0,
    cmModulesUsed: [],
    commandIds: [],
    viewShells: {},
    unresolvedRequires: [],
    unsupportedApi: {},
    apiErrors: {},
    ms: Date.now() - started,
  };
}

async function main() {
  if (JSON_ONLY && !CHILD) {
    // 父进程不该走到这里（它只负责 spawn 子进程），真走到了就直接报错退出
    console.error("内部错误：--json-only 只能在子进程里用");
    process.exit(2);
  }
  if (REPORT_ONLY) {
    const outFile = resolve(HERE, "compat-results.json");
    const saved = JSON.parse(readFileSync(outFile, "utf8"));
    const sampleFile2 = resolve(HERE, "plugins.sample.json");
    const sample2 = JSON.parse(readFileSync(sampleFile2, "utf8"));
    writeReport(saved.results, sample2, saved.summary);
    console.log(`已根据 ${outFile} 重新生成报告`);
    return;
  }
  if (!existsSync(BUNDLE)) {
    console.error(`缺少 harness 产物 ${BUNDLE}\n请先运行：npx vite build --config vite.harness.config.ts`);
    process.exit(2);
  }
  installDom();
  const shim = await import(BUNDLE);

  const sampleFile = resolve(HERE, "plugins.sample.json");
  const sample = JSON.parse(readFileSync(sampleFile, "utf8"));
  let plugins = sample.plugins;
  if (ONLY.length) plugins = plugins.filter((p) => ONLY.includes(p.id));

  // 指定 id 不在样本里时，从缓存目录合成条目（测用户自己装的插件）
  const fromCache = (id) => {
    const dir = resolve(CACHE, "plugins", id);
    let mf = {};
    try {
      mf = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
    } catch {
      return null;
    }
    return { id, name: mf.name ?? id, repo: "(local)", category: "本地/自装", downloads: 0 };
  };
  const extra = ONLY.filter((id) => !plugins.some((p) => p.id === id)).map(fromCache).filter(Boolean);
  plugins = [...plugins, ...extra];

  // --from-vault：直接取该 vault 里已启用的插件（按缓存里有产物的优先）
  if (FROM_VAULT) {
    const enabledPath = resolve(FROM_VAULT, ".obsidian/community-plugins.json");
    let ids = [];
    try {
      ids = JSON.parse(readFileSync(enabledPath, "utf8"));
    } catch {
      console.error(`读不到启用列表: ${enabledPath}`);
      process.exit(2);
    }
    const wanted = ONLY.length ? ids.filter((id) => ONLY.includes(id)) : ids;
    plugins = wanted.map((id) => fromCache(id) ?? {
      id,
      name: id,
      repo: "(local)",
      category: "本地 vault",
      downloads: 0,
    });
    if (!ONLY.length) console.log(`来自 vault ${FROM_VAULT}：${plugins.length} 个已启用插件`);
  }

  plugins = [...plugins].sort((a, b) => b.downloads - a.downloads);

  console.log(`兼容性测试开始：${plugins.length} 个插件（样本生成于 ${sample.generatedAt}）\n`);

  const results = [];
  // 共享模式：先建一个 app，所有插件都塞进去（真机行为）
  let sharedApi = null;
  if (SHARED_API) {
    const host = shim.createMemoryHost({ ...VAULT_FILES });
    const api = shim.createObsidianApi(host, {
      name: "compat-vault",
      workspaceHooks: {
        activeFile: () => "README.md",
        openFile: async (p) => {
          await host.openFile?.(p);
        },
        getLeafContainer: (type) => {
          const key = `shared-${type}`;
          let d = sharedApi?.containers.get(key);
          if (!d) {
            d = document.createElement("div");
            d.className = `nf-leaf nf-leaf-${type}`;
            document.body.appendChild(d);
            sharedApi.containers.set(key, d);
          }
          return d;
        },
      },
    });
    await api.vault.ensure();
    sharedApi = { api, containers: new Map() };
  }
  for (const p of plugins) {
    // 单个插件的未捕获异常不能带崩整轮：插件常在定时器/微任务里抛
    const prevHandlers = { unhandled: process.listeners("unhandledRejection"), exc: process.listeners("uncaughtException") };
    const isolated = [];
    const collect = (err) => isolated.push(String(err?.message ?? err));
    process.on("unhandledRejection", collect);
    process.on("uncaughtException", collect);
    let r;
    try {
      if (ISOLATE) {
        r = await runIsolated(p);
      } else {
        // 进程内跑：单插件超时（仅对异步挂起有效，同步死循环/微任务饥饿仍然会卡住整轮）
        r = await Promise.race([
          testPlugin(shim, p, sharedApi),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error(`插件超时（${PLUGIN_TIMEOUT_MS / 1000}s 未完成，可能卡在网络或死循环）`)),
              PLUGIN_TIMEOUT_MS,
            ),
          ),
        ]);
      }
    } catch (e) {
      r = {
        id: p.id, name: p.name, category: p.category, downloads: p.downloads, repo: p.repo,
        status: "fail-harness", phase: "harness", error: String(e?.message ?? e).split("\n")[0],
        commands: 0, views: 0, settingTabs: 0, editorExtensions: 0, postProcessors: 0,
        cmModulesUsed: [], commandIds: [], viewShells: {},
        unresolvedRequires: [], unsupportedApi: {}, apiErrors: {},
      };
    }
    process.removeListener("unhandledRejection", collect);
    process.removeListener("uncaughtException", collect);
    void prevHandlers;
    if (isolated.length) r.asyncErrors = [...new Set(isolated)].slice(0, 5);
    results.push(r);
    const tag =
      r.status === "pass" ? "✅" :
      r.status === "pass-view-error" ? "⚠️ " :
      r.status === "pass-settings-error" ? "⚠️ " :
      r.status === "load-only" ? "🟡" :
      r.status === "artifact-unavailable" ? "📦" : "❌";
    console.log(
      `${tag} ${r.id.padEnd(30)} ${String(r.downloads).padStart(9)}  ${r.status.padEnd(20)} ` +
      `cmd=${String(r.commands).padStart(2)} view=${String(r.views).padStart(2)} pp=${r.postProcessors} ` +
      `cm=${r.cmModulesUsed.length} ${fmtErr(r.error)}`,
    );
  }

  /* 汇总 */
  const by = (s) => results.filter((r) => r.status === s).length;
  const passed = by("pass");
  const viewErr = by("pass-view-error");
  const settingsErr = by("pass-settings-error");
  const loadOnly = by("load-only");
  const artifactMissing = by("artifact-unavailable");
  const failed = results.length - passed - viewErr - settingsErr - loadOnly - artifactMissing;
  const summary = { passed, viewError: viewErr, settingsError: settingsErr, loadOnly, artifactMissing, failed };

  // 缺失 API 频次（决定下一步补 shim 的优先级）
  const apiFreq = new Map();
  for (const r of results) {
    for (const [k, v] of Object.entries(r.unsupportedApi ?? {})) {
      apiFreq.set(k, (apiFreq.get(k) ?? 0) + v);
    }
  }
  const errorFreq = new Map();
  for (const r of results) {
    for (const [k, v] of Object.entries(r.apiErrors ?? {})) {
      if (!errorFreq.has(v)) errorFreq.set(v, []);
      errorFreq.get(v).push(r.id);
    }
  }
  const apiUsed = new Map();
  for (const r of results) {
    for (const k of r.accessedApi ?? []) apiUsed.set(k, (apiUsed.get(k) ?? 0) + 1);
  }
  const cmUsed = new Map();
  for (const r of results) {
    for (const m of r.cmModulesUsed ?? []) cmUsed.set(m, (cmUsed.get(m) ?? 0) + 1);
  }
  const unresolved = new Map();
  for (const r of results) {
    for (const m of r.unresolvedRequires ?? []) unresolved.set(m, (unresolved.get(m) ?? 0) + 1);
  }

  const outFile = resolve(HERE, "compat-results.json");
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sampleGeneratedAt: sample.generatedAt,
        total: results.length,
        summary: { passed, viewError: viewErr, loadOnly, artifactMissing, failed },
        missingApi: Object.fromEntries([...apiFreq].sort((a, b) => b[1] - a[1])),
        usedApi: Object.fromEntries([...apiUsed].sort((a, b) => b[1] - a[1])),
        topErrors: Object.fromEntries([...errorFreq].sort((a, b) => b[1].length - a[1].length)),
        cmModules: Object.fromEntries([...cmUsed].sort((a, b) => b[1] - a[1])),
        unresolvedRequires: Object.fromEntries([...unresolved].sort((a, b) => b[1] - a[1])),
        results,
      },
      null,
      2,
    ),
  );

  if (JSON_ONLY) {
    // 子进程：结果单行 JSON 交给父进程（日志噪音在前面，用标记定位）
    for (const r of results) {
      process.stdout.write(`${RESULT_MARKER}${JSON.stringify(r)}\n`);
    }
    // 必须硬退出：插件留下的 setInterval / 未 resolve 的 promise 会吊住 Node，
    // 结果明明已经出来了，进程却一直不结束（实测每个子进程白等 2 分钟）。
    process.exit(0);
  }

  console.log(`\n===== 汇总（${results.length} 个） =====`);
  console.log(
    `✅ 完全可用 ${summary.passed}   ⚠️ 视图出错 ${viewErr}   ⚠️ 设置页出错 ${settingsErr}   🟡 仅加载 ${loadOnly}`,
  );
  console.log(`❌ 失败 ${failed}   📦 产物不可达 ${artifactMissing}`);
  console.log(`\n插件用到的 CM 模块 top：`, [...cmUsed].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(" "));
  console.log(`最常缺失的 obsidian API：`, [...apiFreq].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}(${v})`).join(" ") || "（无）");
  console.log(`被访问最多的 obsidian API：`, [...apiUsed].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}(${v})`).join(" "));
  console.log(`\n明细已写入 ${outFile}`);

  writeReport(results, sample, summary);
}

main().catch((e) => {
  console.error("测试执行失败：", e);
  process.exit(1);
});