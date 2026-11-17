import { copyToClipboard, h, icon, openLink } from "./dom.mjs";

// ---------------------------------------------------------------------------
// Minimal Markdown → DOM (no innerHTML): paragraphs, headings, lists,
// **bold**, `code`, [links](https://…), and fenced blocks as copy boxes.
// ---------------------------------------------------------------------------
export const TEXT_LANGS = new Set(["", "text", "txt", "plain", "plaintext", "markdown", "md"]);

// Markdown tables: "| a | b |" rows with a "|---|:--:|" line under the header
export const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function splitTableRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// If a table starts at lines[i], returns { header, aligns, rows, end }
export function parseTable(lines, i) {
  const head = lines[i];
  const rule = lines[i + 1];
  if (!head || !rule || !head.includes("|") || !TABLE_RULE.test(rule)) return null;
  const header = splitTableRow(head);
  const aligns = splitTableRow(rule).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : "left"));
  if (header.length < 2 && !head.trim().startsWith("|")) return null;
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].includes("|") && lines[j].trim()) {
    rows.push(splitTableRow(lines[j]));
    j++;
  }
  return { header, aligns, rows, end: j };
}

export const plainCell = (text) => String(text).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

export function tableBox(t) {
  const cols = t.header.length;
  const cell = (tag, text, i) => h(tag, { class: t.aligns[i] && t.aligns[i] !== "left" ? `zai-al-${t.aligns[i]}` : null }, inlineMarkdown(text || ""));
  const table = h("table", { class: "zai-table" },
    h("thead", {}, h("tr", {}, t.header.map((c, i) => cell("th", c, i)))),
    h("tbody", {}, t.rows.map((r) => h("tr", {}, Array.from({ length: cols }, (_, i) => cell("td", r[i], i)))))
  );
  // Copies as tab-separated text, which pastes into Sheets/Excel as cells
  const tsv = [t.header, ...t.rows].map((r) => Array.from({ length: cols }, (_, i) => plainCell(r[i] || "").replace(/\t/g, " ")).join("\t")).join("\n");
  const copyBtn = h("button", { class: "zai-icon-btn zai-copy-btn zai-table-copy", "aria-label": "Copy table", "data-tip": "Copy table (pastes into Sheets/Excel)", "data-tip-align": "end" }, icon("copy", 14));
  copyBtn.addEventListener("click", () => {
    if (!copyToClipboard(tsv)) return;
    copyBtn.replaceChildren(icon("check", 14, 2.2));
    copyBtn.classList.add("zai-copied");
    setTimeout(() => {
      copyBtn.replaceChildren(icon("copy", 14));
      copyBtn.classList.remove("zai-copied");
    }, 1500);
  });
  return h("div", { class: "zai-tablebox" }, h("div", { class: "zai-table-scroll" }, table), copyBtn);
}

export function inlineMarkdown(text) {
  const out = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|((?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])|(?<!\w)_(?![\s_])([^_\n]+?)(?<!\s)_(?!\w))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      out.push(h("code", { class: "zai-inline-code", text: m[1].slice(1, -1) }));
    } else if (m[2]) {
      out.push(h("strong", { text: m[2].slice(2, -2) }));
    } else if (m[3]) {
      const url = m[5];
      out.push(h("a", {
        class: "zai-link",
        role: "link",
        tabindex: "0",
        title: url,
        text: m[4],
        onclick: (e) => { e.preventDefault(); openLink(url); },
        onkeydown: (e) => { if (e.key === "Enter") openLink(url); },
      }));
    } else if (m[6]) {
      out.push(h("em", { text: m[7] || m[8] }));
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function copyBox(lang, code) {
  const isText = TEXT_LANGS.has(lang.toLowerCase());
  const copyBtn = h("button", { class: "zai-icon-btn zai-copy-btn", "aria-label": "Copy", "data-tip": "Copy", "data-tip-align": "end" }, icon("copy", 15));
  copyBtn.addEventListener("click", () => {
    if (!copyToClipboard(code)) return;
    copyBtn.replaceChildren(icon("check", 15, 2.2));
    copyBtn.classList.add("zai-copied");
    copyBtn.setAttribute("data-tip", "Copied");
    setTimeout(() => {
      copyBtn.replaceChildren(icon("copy", 15));
      copyBtn.classList.remove("zai-copied");
      copyBtn.setAttribute("data-tip", "Copy");
    }, 1500);
  });
  return h("figure", { class: "zai-codebox" + (isText ? " zai-textbox" : "") },
    h("figcaption", { class: "zai-codebox-head" },
      icon(isText ? "lines" : "terminal", 15),
      h("span", { text: isText ? "Text" : lang }),
      copyBtn
    ),
    h("pre", { text: code })
  );
}

export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) frag.append(h("p", {}, inlineMarkdown(para.join("\n"))));
    para = [];
  };
  const flushList = () => {
    if (list) frag.append(list.el);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushPara();
      flushList();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      frag.append(copyBox(fence[1] || "", body.join("\n")));
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      flushPara();
      flushList();
      frag.append(tableBox(table));
      i = table.end - 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      frag.append(h("hr", { class: "zai-hr" }));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      const quoted = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) quoted.push(lines[++i].replace(/^\s*>\s?/, ""));
      frag.append(h("blockquote", { class: "zai-quote" }, inlineMarkdown(quoted.join("\n"))));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      frag.append(h("div", { class: "zai-h", role: "heading", "aria-level": String(Math.min(6, heading[1].length + 2)) }, inlineMarkdown(heading[2])));
      continue;
    }

    const bullet = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flushPara();
      const ordered = /\d/.test(bullet[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, el: h(ordered ? "ol" : "ul", { class: "zai-list" }) };
      }
      list.el.append(h("li", {}, inlineMarkdown(bullet[2])));
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return frag;
}
