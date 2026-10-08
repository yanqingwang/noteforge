/**
 * 属性 ID → 人读的列名。
 *
 * 官方只规定「properties 里配的 displayName 优先」，没配时怎么显示由视图自己
 * 决定。Obsidian 的选择是：file.* 用固定英文词（Name / Modified / Extension…），
 * note/formula 属性把名字美化一下。这里照这个来，中文界面上 file.* 也给中文，
 * 因为 noteforge 的界面语言是中文。
 */

const FILE_LABELS_ZH: Record<string, string> = {
  name: "文件名",
  basename: "名称",
  path: "路径",
  folder: "文件夹",
  ext: "扩展名",
  size: "大小",
  ctime: "创建时间",
  mtime: "修改时间",
  tags: "标签",
  links: "链接",
  embeds: "嵌入",
  backlinks: "反向链接",
  properties: "属性",
  file: "文件",
};

const FILE_LABELS_EN: Record<string, string> = FILE_LABELS_ZH;

/** 未知 file 属性时的兜底美化：snake_case / camelCase → 首字母大写 */
export function humanize(name: string): string {
  if (!name) return "";
  const spaced = name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function humanizeFileProperty(name: string): string {
  return FILE_LABELS_ZH[name] ?? FILE_LABELS_EN[name] ?? humanize(name);
}

/** `note.price` → "Price"；`formula.ppu` → "Ppu" */
export function humanizePropertyName(propertyId: string): string {
  const i = propertyId.indexOf(".");
  const type = i > 0 ? propertyId.slice(0, i) : "note";
  const name = i > 0 ? propertyId.slice(i + 1) : propertyId;
  if (type === "file") return humanizeFileProperty(name);
  return humanize(name);
}