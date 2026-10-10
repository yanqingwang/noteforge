/**
 * 插件可用的 CodeMirror / Lezer 模块表。
 *
 * Obsidian 插件产物把 @codemirror/*、@lezer/* 标为 external，加载时 require 这些
 * 包并调用它们的工厂函数（StateField.define / Decoration.mark / tags.keyword 等）。
 * 如果不给，它们在插件 onload 的第一行就抛 "require is not a function"。
 * 所以必须把 noteforge 自己那份 CM 实例转发给插件（Obsidian 也是这么做的）。
 */

import * as _cmAutocomplete from "@codemirror/autocomplete";
import * as _cmCommands from "@codemirror/commands";
import * as _cmLanguage from "@codemirror/language";
import * as _cmLangMarkdown from "@codemirror/lang-markdown";
import * as _cmLint from "@codemirror/lint";
import * as _cmSearch from "@codemirror/search";
import * as _cmState from "@codemirror/state";
import * as _cmView from "@codemirror/view";
import * as _lezerCommon from "@lezer/common";
import * as _lezerHighlight from "@lezer/highlight";
import * as _lezerLr from "@lezer/lr";

/** 模块名 → 导出表。键名与 Obsidian 的 external 列表一致。 */

export function createCmModules(): Record<string, Record<string, unknown>> {
  // 直接展开**真实模块**：手挑导出会不断缺项（syntaxHighlighting、foldService、Parser…），
  // 插件在模块求值期一句 `const {X} = require(...)` 就崩。真实现的覆盖面对插件最友好。
  return {
    "@codemirror/state": { ..._cmState },
    "@codemirror/view": { ..._cmView },
    "@codemirror/commands": { ..._cmCommands },
    "@codemirror/language": { ..._cmLanguage },
    "@codemirror/lang-markdown": { ..._cmLangMarkdown },
    "@codemirror/search": { ..._cmSearch },
    "@codemirror/autocomplete": { ..._cmAutocomplete },
    "@codemirror/lint": { ..._cmLint },
    "@lezer/common": {
      ..._lezerCommon,
      // 下面三个不是 @lezer/common 的真实导出，仅作兜底别名（老插件会这么取）
      Facet: _cmState.Facet,
      NodeCursor: _lezerCommon.TreeCursor,
      SyntaxNodeRef: class {},
    },
    "@lezer/highlight": { ..._lezerHighlight },
    // LRLanguage 真实在 @codemirror/language；老插件从 @lezer/lr 取，做个别名
    "@lezer/lr": { ..._lezerLr, LRLanguage: _cmLanguage.LRLanguage },
  };
}
