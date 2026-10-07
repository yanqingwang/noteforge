/**
 * 插件可用的 CodeMirror / Lezer 模块表。
 *
 * Obsidian 插件产物把 @codemirror/*、@lezer/* 标为 external，加载时 require 这些
 * 包并调用它们的工厂函数（StateField.define / Decoration.mark / tags.keyword 等）。
 * 如果不给，它们在插件 onload 的第一行就抛 "require is not a function"。
 * 所以必须把 noteforge 自己那份 CM 实例转发给插件（Obsidian 也是这么做的）。
 */

import {
  autocompletion as _autocompletion,
  closeBrackets as _closeBrackets,
  closeBracketsKeymap as _closeBracketsKeymap,
  completionKeymap as _completionKeymap,
  startCompletion as _startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap as _defaultKeymap, history as _history, historyKeymap as _historyKeymap, indentWithTab as _indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle as _HighlightStyle,
  LanguageSupport as _LanguageSupport,
  StreamLanguage as _StreamLanguage,
  bracketMatching as _bracketMatching,
  foldGutter as _foldGutter,
  indentOnInput as _indentOnInput,
  syntaxTree as _syntaxTree,
} from "@codemirror/language";
import { markdown as _markdown, markdownLanguage as _markdownLanguage } from "@codemirror/lang-markdown";
import { diagnosticCount as _diagnosticCount, linter as _linter, lintGutter as _lintGutter, setDiagnostics as _setDiagnostics } from "@codemirror/lint";
import {
  Annotation as _Annotation,
  EditorSelection as _CMEditorSelection,
  Prec as _Prec,
  StateEffect as _StateEffect,
  StateField as _StateField,
  EditorState as _EditorState,
  Facet as _Facet,
  RangeSetBuilder as _RangeSetBuilder,
  RangeValue as _RangeValue,
  Compartment as _Compartment,
  Transaction as _Transaction,
  SelectionRange as _SelectionRange,
  StateEffectType as _StateEffectType,
} from "@codemirror/state";
import {
  Decoration as _Decoration,
  EditorView as _EditorView,
  GutterMarker as _GutterMarker,
  BlockType as _BlockType,
  crosshairCursor as _crosshairCursor,
  gutter as _gutter,
  gutters as _gutters,
  lineNumberMarkers as _lineNumberMarkers,
  lineNumberWidgetMarker as _lineNumberWidgetMarker,
  gutterLineClass as _gutterLineClass,
  gutterWidgetClass as _gutterWidgetClass,
  highlightSpecialChars as _hsc,
  highlightTrailingWhitespace as _highlightTrailingWhitespace,
  highlightWhitespace as _highlightWhitespace,
  hoverTooltip as _hoverTooltip,
  showTooltip as _showTooltip,
  tooltips as _tooltips,
  layer as _layer,
  panels as _panels,
  logException as _logException,
  scrollPastEnd as _scrollPastEnd,
  getPanel as _getPanel,
  closeHoverTooltip as _closeHoverTooltip,
  closeHoverTooltips as _closeHoverTooltips,
  repositionTooltips as _repositionTooltips,
  runScopeHandlers as _runScopeHandlers,
  activateHover as _activateHover,
  hasHoverTooltips as _hasHoverTooltips,
  getTooltip as _getTooltip,
  ViewPlugin as _ViewPlugin,
  ViewUpdate as _ViewUpdate,
  WidgetType as _WidgetType,
  drawSelection as _drawSelection,
  dropCursor as _dropCursor,
  highlightActiveLine as _highlightActiveLine,
  highlightActiveLineGutter as _highlightActiveLineGutter,
  highlightSpecialChars as _highlightSpecialChars,
  keymap as _keymap,
  lineNumbers as _lineNumbers,
  rectangularSelection as _rectangularSelection,
  showPanel as _showPanel,
} from "@codemirror/view";
import { NodeProp as _NodeProp, NodeSet as _NodeSet, NodeType as _NodeType, Tree as _Tree, TreeCursor as _TreeCursor } from "@lezer/common";
import { Tag as _Tag, tags as _tags } from "@lezer/highlight";
import { ContextTracker as _ContextTracker, ExternalTokenizer as _ExternalTokenizer, InputStream as _InputStream, LRParser as _LRParser, Stack as _Stack } from "@lezer/lr";
import { findNext as _findNext, findPrevious as _findPrevious, openSearchPanel as _openSearchPanel, search as _search, searchKeymap as _searchKeymap, setSearchQuery as _setSearchQuery } from "@codemirror/search";

/** 模块名 → 导出表。键名与 Obsidian 的 external 列表一致。 */
/**
 * @codemirror/language 的 LRLanguage：CM6 里所有语言的基类，
 * 插件用 `LRLanguage.define({name, parser})` 注册自己的语言（calendarium 就是）。
 * 之前只在 @lezer/lr 里给了个空类，从 @codemirror/language 取就成了 undefined。
 */
class LRLanguage {
  readonly name: string;
  readonly parser: unknown;
  readonly nodeSet: unknown;
  constructor(config: { name?: string; parser?: unknown; nodeSet?: unknown } = {}) {
    this.name = config.name ?? "anonymous";
    this.parser = config.parser ?? null;
    this.nodeSet = config.nodeSet ?? null;
  }

  static define(config: { name?: string; parser?: unknown; nodeSet?: unknown } = {}): LRLanguage {
    return new LRLanguage(config);
  }
}

export function createCmModules(): Record<string, Record<string, unknown>> {
  return {
    "@codemirror/state": {
      EditorState: _EditorState,
      StateField: _StateField,
      StateEffect: _StateEffect,
      Compartment: _Compartment,
      RangeValue: _RangeValue,
      RangeSetBuilder: _RangeSetBuilder,
      TextSelection: _CMEditorSelection,
      EditorSelection: _CMEditorSelection,
      SelectionRange: _SelectionRange,
      Transaction: _Transaction,
      Facet: _Facet,
      Annotation: _Annotation,
      Prec: _Prec,
      StateEffectType: _StateEffectType,
    },
    "@codemirror/view": {
      EditorView: _EditorView,
      ViewPlugin: _ViewPlugin,
      ViewUpdate: _ViewUpdate,
      Decoration: _Decoration,
      WidgetType: _WidgetType,
      keymap: _keymap,
      lineNumbers: _lineNumbers,
      drawSelection: _drawSelection,
      dropCursor: _dropCursor,
      highlightActiveLine: _highlightActiveLine,
      highlightActiveLineGutter: _highlightActiveLineGutter,
      highlightSpecialChars: _highlightSpecialChars,
      rectangularSelection: _rectangularSelection,
      showPanel: _showPanel,
      placeholder: () => _Decoration.mark({ class: "cm-placeholder" }),
      // gutter 家族：插件的 CodeMirror 编辑器扩展经常要加自定义装订线
      // （obsidian-git / git-graph / 图片插件都靠它，缺了在模块顶层就崩）
      GutterMarker: _GutterMarker,
      gutter: _gutter,
      gutters: _gutters,
      lineNumberMarkers: _lineNumberMarkers,
      lineNumberWidgetMarker: _lineNumberWidgetMarker,
      gutterLineClass: _gutterLineClass,
      gutterWidgetClass: _gutterWidgetClass,
      // Facet 家族：插件常直接用 showTooltip.computeN / hoverTooltip.from 等
      // （obsidian-git 的 diff 视图就是 showTooltip.computeN，缺了在模块顶层就崩）
      showTooltip: _showTooltip,
      hoverTooltip: _hoverTooltip,
      tooltips: _tooltips,
      layer: _layer,
      panels: _panels,
      logException: _logException,
      scrollPastEnd: _scrollPastEnd,
      getPanel: _getPanel,
      closeHoverTooltip: _closeHoverTooltip,
      closeHoverTooltips: _closeHoverTooltips,
      repositionTooltips: _repositionTooltips,
      runScopeHandlers: _runScopeHandlers,
      activateHover: _activateHover,
      hasHoverTooltips: _hasHoverTooltips,
      getTooltip: _getTooltip,
      crosshairCursor: _crosshairCursor,
      highlightWhitespace: _highlightWhitespace,
      highlightTrailingWhitespace: _highlightTrailingWhitespace,
      BlockType: _BlockType,
    },
    "@codemirror/commands": {
      defaultKeymap: _defaultKeymap,
      history: _history,
      historyKeymap: _historyKeymap,
      indentWithTab: _indentWithTab,
    },
    "@codemirror/language": {
      LanguageSupport: _LanguageSupport,
      // calendarium 从 @codemirror/language 取 LRLanguage（CM6 里它从这里再导出）
      LRLanguage,
      StreamLanguage: _StreamLanguage,
      HighlightStyle: _HighlightStyle,
      syntaxTree: _syntaxTree,
      bracketMatching: _bracketMatching,
      foldGutter: _foldGutter,
      indentOnInput: _indentOnInput,
      foldService: undefined,
    },
    "@codemirror/lang-markdown": { markdown: _markdown, markdownLanguage: _markdownLanguage },
    "@codemirror/search": {
      search: _search,
      searchKeymap: _searchKeymap,
      openSearchPanel: _openSearchPanel,
      findNext: _findNext,
      findPrevious: _findPrevious,
      setSearchQuery: _setSearchQuery,
      SearchQuery: class {
        constructor() {
          /* 占位 */
        }
      },
      getSearchQuery: () => null,
    },
    "@codemirror/autocomplete": {
      autocompletion: _autocompletion,
      completionKeymap: _completionKeymap,
      closeBrackets: _closeBrackets,
      closeBracketsKeymap: _closeBracketsKeymap,
      startCompletion: _startCompletion,
      CompletionContext: class {},
      CompletionResult: class {},
    },
    "@codemirror/lint": {
      linter: _linter,
      lintGutter: _lintGutter,
      setDiagnostics: _setDiagnostics,
      diagnosticCount: _diagnosticCount,
      forceLinting: () => undefined,
      // Diagnostic 在 CM6 是纯类型；插件多用作类型标注，少量代码会当值用（如 instanceof）
      Diagnostic: class {
        from() {
          return null;
        }
        static isDiagnostic() {
          return false;
        }
      },
    },
    "@lezer/common": {
      Tree: _Tree,
      NodeType: _NodeType,
      NodeProp: _NodeProp,
      // 必须是真实实现：LRParser 内部会 new NodeSet().extend(...)，
      // 用空类替代会让 Excalidraw 这类自带 markdown 解析器的插件在加载期崩掉。
      NodeSet: _NodeSet,
      TreeCursor: _TreeCursor,
      NodeCursor: _TreeCursor,
      Facet: _Facet, // Facet 实际在 @codemirror/state，这里给个别插件一个兜底
      SyntaxNodeRef: class {},
      DefaultBufferLength: 1024,
    },
    "@lezer/highlight": { tags: _tags, Tag: _Tag, styleTags: () => (x: unknown) => x },
    "@lezer/lr": {
      LRParser: _LRParser,
      ExternalTokenizer: _ExternalTokenizer,
      InputStream: _InputStream,
      ContextTracker: _ContextTracker,
      Stack: _Stack,
      LRLanguage,
      LocalTokenGroup: class {},
    },
  };
}

/** 应用侧：把 CM 模块表转成 require 映射。 */
export function buildCmRequireMap(): Record<string, Record<string, unknown>> {
  return createCmModules();
}
