import type { NoteForgePlugin, PluginCommand, MarkdownPostProcessor } from "./PluginManager";

type HEType = "compare" | "timeline" | "diagram" | "report" | "slides";

function applyInline(parent: HTMLElement, text: string): void {
  const parts = text.split(/(\*\*.+?\*\*|`[^`]+`)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      const st = document.createElement("strong"); st.textContent = part.slice(2, -2); parent.appendChild(st);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      const co = document.createElement("code"); co.textContent = part.slice(1, -1); parent.appendChild(co);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

function applyMd(parent: HTMLElement, text: string): void {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = []; i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (lang) code.className = "language-" + lang;
      code.textContent = codeLines.join("\n");
      pre.appendChild(code); parent.appendChild(pre);
      continue;
    }
    if (line.trimStart().startsWith("> ")) {
      const bq = document.createElement("blockquote");
      const ql: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("> ")) { ql.push(lines[i].trimStart().slice(2)); i++; }
      applyInline(bq, ql.join("\n")); parent.appendChild(bq);
      continue;
    }
    if (line.trimStart().match(/^[-*]\s/)) {
      const ul = document.createElement("ul");
      while (i < lines.length && lines[i].trimStart().match(/^[-*]\s/)) { const li = document.createElement("li"); applyInline(li, lines[i].trimStart().slice(2)); ul.appendChild(li); i++; }
      parent.appendChild(ul);
      continue;
    }
    if (line.trimStart().match(/^\d+\.\s/)) {
      const ol = document.createElement("ol");
      while (i < lines.length && lines[i].trimStart().match(/^\d+\.\s/)) { const li = document.createElement("li"); applyInline(li, lines[i].trimStart().replace(/^\d+\.\s*/, "")); ol.appendChild(li); i++; }
      parent.appendChild(ol);
      continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      const level = Math.min(hm[1].length, 6);
      const h = document.createElement("h" + level); applyInline(h, hm[2]); parent.appendChild(h); i++;
      continue;
    }
    if (line.match(/^---+\s*$/)) { i++; continue; }
    if (line.trim() === "") { i++; continue; }
    const p = document.createElement("p"); applyInline(p, line); parent.appendChild(p); i++;
  }
}

// ── Template renderers ────────────────────────────────────────────────

function buildCompare(parent: HTMLElement, content: string): void {
  const sep = content.indexOf("---");
  const leftText = sep < 0 ? content : content.substring(0, sep).trim();
  const rightText = sep < 0 ? "" : content.substring(sep + 3).trim();
  const flex = document.createElement("div");
  flex.style.cssText = "display:flex;gap:16px;flex-wrap:wrap;";
  const l = document.createElement("div"); l.style.cssText = "flex:1;min-width:200px;background:#f5f5f5;padding:12px;border-radius:8px;";
  applyMd(l, leftText || "(left)");
  const r = document.createElement("div"); r.style.cssText = "flex:1;min-width:200px;background:#f5f5f5;padding:12px;border-radius:8px;";
  applyMd(r, rightText || "(right)");
  flex.appendChild(l); flex.appendChild(r); parent.appendChild(flex);
}

function buildTimeline(parent: HTMLElement, content: string): void {
  const tl = document.createElement("div");
  tl.style.cssText = "position:relative;padding-left:24px;border-left:2px solid #2563eb;";
  for (const line of content.split("\n")) {
    const m = line.match(/^-\s*\[([^\]]*)\]\s*(.+)/);
    if (m) {
      const item = document.createElement("div"); item.style.cssText = "margin-bottom:16px;position:relative;";
      const dot = document.createElement("div"); dot.style.cssText = "position:absolute;left:-28px;top:4px;width:12px;height:12px;border-radius:50%;background:#2563eb;border:2px solid #fff;";
      item.appendChild(dot);
      const date = document.createElement("div"); date.style.cssText = "font-size:11px;color:#666;margin-bottom:2px;"; date.textContent = m[1]; item.appendChild(date);
      const txt = document.createElement("div"); txt.style.cssText = "font-size:14px;"; applyInline(txt, m[2]); item.appendChild(txt);
      tl.appendChild(item);
    }
  }
  parent.appendChild(tl);
}

function buildDiagram(parent: HTMLElement, content: string): void {
  const pre = document.createElement("pre");
  pre.style.cssText = "font-family:'Courier New',monospace;font-size:13px;line-height:1.4;background:#f5f5f5;padding:12px;border-radius:8px;overflow-x:auto;white-space:pre;";
  pre.textContent = content;
  parent.appendChild(pre);
}

function buildReport(parent: HTMLElement, content: string): void {
  const lines = content.split("\n").filter(l => l.trim());
  const kvs = lines.filter(l => l.match(/^-\s*.+:/)).map(l => {
    const sep = l.indexOf(":");
    return { k: l.substring(1, sep).trim(), v: l.substring(sep + 1).trim() };
  });
  if (kvs.length > 0) {
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;";
    for (const kv of kvs) {
      const card = document.createElement("div");
      card.style.cssText = "background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;padding:16px;border-radius:10px;text-align:center;";
      const val = document.createElement("div"); val.style.cssText = "font-size:24px;font-weight:700;"; val.textContent = kv.v; card.appendChild(val);
      const key = document.createElement("div"); key.style.cssText = "font-size:12px;opacity:.8;margin-top:4px;"; key.textContent = kv.k; card.appendChild(key);
      grid.appendChild(card);
    }
    parent.appendChild(grid);
  }
  const body = lines.filter(l => !l.match(/^-\s*.+:/)).join("\n");
  if (body) applyMd(parent, body);
}

function buildSlides(parent: HTMLElement, content: string): void {
  const slides = content.split(/\n---+\n/).filter(s => s.trim());
  const wrap = document.createElement("div");
  let idx = 0;
  const slideDivs: HTMLDivElement[] = [];
  for (const s of slides) {
    const sd = document.createElement("div");
    sd.style.cssText = "background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:8px;";
    applyMd(sd, s.trim());
    slideDivs.push(sd);
    wrap.appendChild(sd);
  }
  if (slides.length > 1) {
    const nav = document.createElement("div");
    nav.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:center;margin-top:8px;";
    const prev = document.createElement("button"); prev.textContent = "‹ Prev"; prev.style.cssText = "padding:4px 12px;border:1px solid #ddd;border-radius:4px;cursor:pointer;background:#fff;font-size:13px;";
    const span = document.createElement("span"); span.style.cssText = "font-size:13px;color:#666;";
    const next = document.createElement("button"); next.textContent = "Next ›"; next.style.cssText = "padding:4px 12px;border:1px solid #ddd;border-radius:4px;cursor:pointer;background:#fff;font-size:13px;";
    const show = () => { slideDivs.forEach((s, i) => s.style.display = i === idx ? "block" : "none"); span.textContent = `${idx + 1} / ${slides.length}`; };
    prev.onclick = () => { if (idx > 0) { idx--; show(); } };
    next.onclick = () => { if (idx < slides.length - 1) { idx++; show(); } };
    nav.appendChild(prev); nav.appendChild(span); nav.appendChild(next); wrap.appendChild(nav);
    show();
  }
  parent.appendChild(wrap);
}

// ── Main processor ────────────────────────────────────────────────────

function processor(source: string, el: HTMLElement): void {
  let type: HEType = "report";
  let content = source;
  const nl = source.indexOf("\n");
  if (nl > 0) {
    const fl = source.substring(0, nl).trim();
    if (!fl.startsWith("---")) {
      const t = fl.toLowerCase();
      if (t === "compare" || t === "timeline" || t === "diagram" || t === "report" || t === "slides") {
        type = t; content = source.substring(nl + 1).trim();
      }
    } else {
      const end = source.indexOf("---", 3);
      if (end > 0) content = source.substring(end + 3).trim();
    }
  }
  const w = document.createElement("div"); w.className = "he-wrapper dark";
  switch (type) {
    case "compare": buildCompare(w, content); break;
    case "timeline": buildTimeline(w, content); break;
    case "diagram": buildDiagram(w, content); break;
    case "report": buildReport(w, content); break;
    case "slides": buildSlides(w, content); break;
  }
  el.appendChild(w);
}

// ── HTML file viewer ──────────────────────────────────────────────────

async function renderHtmlView(container: HTMLElement, filePath: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const content: string = await invoke("read_file", { path: filePath });
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : content;
    container.innerHTML = "";
    // Toolbar
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 12px;border-bottom:1px solid #ddd;background:#f5f5f5;";
    const zo = document.createElement("button"); zo.textContent = "−"; zo.style.cssText = "padding:2px 10px;cursor:pointer;font-size:14px;";
    const zl = document.createElement("span"); zl.textContent = "100%"; zl.style.cssText = "font-size:12px;min-width:40px;text-align:center;";
    const zi = document.createElement("button"); zi.textContent = "+"; zi.style.cssText = "padding:2px 10px;cursor:pointer;font-size:14px;";
    const zr = document.createElement("button"); zr.textContent = "↺"; zr.style.cssText = "padding:2px 10px;cursor:pointer;font-size:14px;";
    bar.appendChild(zo); bar.appendChild(zl); bar.appendChild(zi); bar.appendChild(zr);
    container.appendChild(bar);
    // Iframe
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "width:100%;flex:1;border:none;";
    iframe.srcdoc = bodyHtml;
    container.appendChild(iframe);
    container.style.cssText = "display:flex;flex-direction:column;height:100%;";
    let zoom = 1;
    const apply = () => {
      iframe.style.transform = `scale(${zoom})`;
      iframe.style.transformOrigin = "top left";
      iframe.style.width = `${100 / zoom}%`;
      zl.textContent = `${Math.round(zoom * 100)}%`;
    };
    zi.onclick = () => { zoom = Math.min(3, zoom + 0.1); apply(); };
    zo.onclick = () => { zoom = Math.max(0.3, zoom - 0.1); apply(); };
    zr.onclick = () => { zoom = 1; apply(); };
  } catch (e: any) {
    container.innerHTML = `<p style="padding:16px;color:red;">加载失败: ${e}</p>`;
  }
}

// ── Templates ─────────────────────────────────────────────────────────

const TEMPLATES: Record<string, string> = {
  compare: "对比（左右分栏）\n\n左侧内容\n---\n右侧内容",
  timeline: "时间线\n\n- [2026-01] 事件一\n- [2026-06] 事件二",
  diagram: "图示\n\n┌─────┐\n│ App │\n└──┬──┘\n   ▼\n┌─────┐\n│ DB  │\n└─────┘",
  report: "报告\n\n- 85%: 完成率\n- 100: 数量\n\n# 标题\n正文内容...",
  slides: "幻灯片\n\n# 第一页\n内容\n---\n# 第二页\n内容",
};

// ── Plugin factory ────────────────────────────────────────────────────

export function createHEPlugin(): NoteForgePlugin {
  const postProcessors = new Map<string, MarkdownPostProcessor>();
  postProcessors.set("html-effect", (source: string, el: HTMLElement) => processor(source, el));

  const commands: PluginCommand[] = Object.entries(TEMPLATES).map(([id, content]) => ({
    id: `he-${id}`,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    callback: () => {},
    editorCallback: () => `\`\`\`html-effect\n${content}\n\`\`\``,
  }));

  return {
    manifest: {
      id: "html-effectiveness",
      name: "HTML Effectiveness",
      version: "1.0.0",
      description: "Render spatial HTML in notes — compare, timeline, diagram, report, slides",
      author: "rosswang",
    },
    commands,
    views: [
      { type: "html-effectiveness-view", title: "HTML Viewer", icon: "🌐", render: renderHtmlView },
    ],
    postProcessors,
    onload: () => {},
    onunload: () => {},
  };
}
