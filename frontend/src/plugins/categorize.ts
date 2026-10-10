/**
 * 插件分类：按名称 + 描述关键词把 Obsidian 插件归入常见功能类别。
 *
 * Obsidian 官方市场不给插件标分类，所以这里用关键词启发式（按顺序取第一个命中），
 * 对识别不了的落回「其他」。关键词覆盖中英文，覆盖常见插件生态（dataview、
 * 表格/大纲编辑、图表/思维导图、文件/附件、同步、任务、AI、界面美化等）。
 */

export interface PluginCategory {
  key: string;
  label: string;
  /** 命中即归入本类；顺序即优先级（同一插件命中多个时取前面的） */
  keywords: string[];
}

export const CATEGORIES: PluginCategory[] = [
  { key: "data", label: "📊 数据与查询", keywords: ["dataview", "data view", "metadata", "properties", "query", "查询", "数据", "数据库", "属性"] },
  { key: "edit", label: "✏️ 编辑增强", keywords: ["table", "outliner", "linter", "format", "edit", "typing", "prettier", "markdown", "html", "link title", "表格", "大纲", "格式化", "编辑", "排版", "代码块", "code styler"] },
  { key: "visual", label: "📈 图表与可视化", keywords: ["chart", "graph", "mindmap", "canvas", "draw", "diagram", "excalidraw", "figma", "visual", "quadrant", "calendar", "heatmap", "图表", "思维导图", "可视化", "绘图", "象限", "日历", "热力图"] },
  { key: "sync", label: "🔄 同步与备份", keywords: ["sync", "backup", "drive", "nextcloud", "livesync", "onedrive", "同步", "备份", "网盘"] },
  { key: "file", label: "🗂 文件管理", keywords: ["file", "folder", "organize", "archive", "attachment", "rename", "image", "clean", "export", "import", "pdf", "文件", "文件夹", "归档", "附件", "图片", "清理", "整理", "导出", "导入"] },
  { key: "task", label: "✅ 任务与效率", keywords: ["task", "todo", "reminder", "quick", "template", "note", "periodic", "periodic notes", "project", "任务", "待办", "提醒", "模板", "快速", "效率", "项目"] },
  { key: "ai", label: "🤖 AI 与智能", keywords: ["ai", "gpt", "llm", "chatgpt", "karpathy", "smart", "agent", "智能", "ai"] },
  { key: "ui", label: "🎨 界面与主题", keywords: ["theme", "style", "color", "icon", "css", "interface", "appearance", "ui", "homepage", "hider", "主题", "样式", "颜色", "图标", "美化", "界面"] },
  { key: "tool", label: "🔧 工具", keywords: ["uri", "macros", "brat", "word count", "statistics", "宏", "统计"] },
  { key: "other", label: "📦 其他", keywords: [] },
];

/** 分类 key → 分类（含 label） */
const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** 关键词搞不定的特例：按插件名精确覆盖（优先于关键词）。 */
const OVERRIDES: Record<string, string> = {
  ExcaliBrain: "visual",
};

/** 按名称 + 描述返回插件的分类 key（命中失败归 "other"）。 */
export function categorizePlugin(name: string, description: string): string {
  const over = OVERRIDES[name.trim()];
  if (over) return over;
  const hay = `${name} ${description}`;
  for (const cat of CATEGORIES) {
    for (const k of cat.keywords) {
      // 中文关键词用包含匹配；英文用前缀词边界（"Tasks" 匹配 "task"、"Importer" 匹配 "import"；
      // 但 "ExcaliBrain" 里的 "ai" 前面是字母 r，不构成边界，不会误命中）
      if (/[\u4e00-\u9fff]/.test(k)) {
        if (hay.includes(k)) return cat.key;
      } else if (new RegExp(`\\b${escapeRe(k)}`, "i").test(hay)) {
        return cat.key;
      }
    }
  }
  return "other";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 分类 key → 展示标签。 */
export function categoryLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? "📦 其他";
}

/** 固定顺序（与 CATEGORIES 一致），未出现的 key 排最后。 */
export function categoryOrder(keys: string[]): string[] {
  const order = CATEGORIES.map((c) => c.key);
  const known = keys.filter((k) => order.includes(k)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const rest = keys.filter((k) => !order.includes(k));
  return [...known, ...rest];
}
