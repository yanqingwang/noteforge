/**
 * highlight.js 按需加载：核心包 + 常用 30 语言注册（ED-09）。
 * 其余语言在首次遇到时动态 import 后注册。
 */
import hljs from "highlight.js/lib/core";

import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import toml from "highlight.js/lib/languages/ini";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import markdownLang from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import lua from "highlight.js/lib/languages/lua";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import makefile from "highlight.js/lib/languages/makefile";
import nginx from "highlight.js/lib/languages/nginx";
import plaintext from "highlight.js/lib/languages/plaintext";

const langs: Record<string, any> = {
  javascript, js: javascript, jsx: javascript, typescript, ts: typescript, tsx: typescript,
  python, py: python, rust, rs: rust, go, golang: go, java, c, cpp, "c++": cpp, csharp, cs: csharp,
  bash, sh: shell, shell, zsh: shell, json, yaml, yml: yaml, toml, ini: toml,
  xml, html: xml, svg: xml, css, sql, markdown: markdownLang, md: markdownLang, diff, patch: diff,
  dockerfile, docker: dockerfile, lua, php, ruby, rb: ruby, kotlin, kt: kotlin,
  swift, makefile, mk: makefile, nginx, plaintext, text: plaintext, txt: plaintext,
};

for (const [name, def] of Object.entries(langs)) {
  hljs.registerLanguage(name, def);
}

/** 语言别名归一 */
function normalize(lang: string): string {
  const l = lang.trim().toLowerCase();
  return langs[l] ? l : l;
}

/** 高亮代码，返回 HTML；未知语言先尝试动态加载，失败则纯文本 */
export function highlightCode(code: string, lang: string): string {
  const l = normalize(lang);
  if (l && hljs.getLanguage(l)) {
    try {
      return hljs.highlight(code, { language: l }).value;
    } catch { /* fallthrough */ }
  }
  if (l) {
    // Kick off dynamic registration for the next render; return plain now.
    import(/* @vite-ignore */ `highlight.js/lib/languages/${l}`)
      .then((m: any) => { if (m?.default) hljs.registerLanguage(l, m.default); })
      .catch(() => {});
  }
  return escapeHtml(code);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default hljs;
