/** 统一图标：Lucide（ISC 开源协议），描边线性风格，避免 emoji 的金属质感。 */
import type { LucideIcon } from "lucide-react";

export function Icon({ as: C, size = 16, strokeWidth = 1.8 }: { as: LucideIcon; size?: number; strokeWidth?: number }) {
  return <C size={size} strokeWidth={strokeWidth} style={{ display: "block", flexShrink: 0 }} />;
}
