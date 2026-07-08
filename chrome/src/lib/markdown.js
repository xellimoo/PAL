// Tiny, dependency-light, CSP-safe Markdown -> HTML renderer for the popup.
// HTML is escaped first, so model output cannot inject markup; only a known set
// of tags is produced. LaTeX math ($$…$$, $…$, \[…\], \(…\)) is rendered to
// native MathML via Temml (no fonts/CSS required for common math).

import temml from "./temml.mjs";

// Private-use chars as math placeholder delimiters: no whitespace (trim-proof),
// won't collide with real text, and never escaped by esc().
const TA = "";
const TB = "";

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderMath(tex, display) {
  try {
    return temml.renderToString(tex.trim(), { displayMode: display, throwOnError: false });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
    const safe = /^https?:\/\//i.test(u) ? u : "#";
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  return s;
}

// A GFM table separator row, e.g. "|------|:---:|---|".
function isTableSep(l) {
  const t = l.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length >= 1 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
}
function tableCells(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function renderMarkdown(src) {
  if (!src) return "";

  // 1. Pull fenced code blocks out first so their contents aren't touched.
  const blocks = [];
  src = src.replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return ` CODE${blocks.length - 1} `;
  });

  // 2. Pull math out before markdown can mangle backslashes/underscores.
  //    Display forms ($$…$$, \[…\]) first, then inline ($…$, \(…\)).
  const maths = [];
  const stash = (tex, display) => TA + (maths.push(renderMath(tex, display)) - 1) + TB;
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => stash(t, true));
  src = src.replace(/\\\[([\s\S]+?)\\\]/g, (m, t) => stash(t, true));
  src = src.replace(/\\\(([\s\S]+?)\\\)/g, (m, t) => stash(t, false));
  src = src.replace(/\$(?!\s)([^\n$]+?)(?<!\s)\$/g, (m, t) => stash(t, false));

  const blockMath = new RegExp(`^${TA}(\\d+)${TB}$`);
  const lines = src.split("\n");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push("<p>" + inline(para.join(" ")) + "</p>");
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const cb = line.match(/^ CODE(\d+) $/);
    if (cb) { flush(); out.push(blocks[+cb[1]]); i++; continue; }
    // display math alone on a line -> block-level (not wrapped in <p>)
    const mb = line.trim().match(blockMath);
    if (mb) { flush(); out.push(maths[+mb[1]]); i++; continue; }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }

    // GFM table: a row with pipes followed by a separator row (|---|---|).
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = tableCells(line);
      i += 2; // skip header + separator
      let t = "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        const cells = tableCells(lines[i]);
        t += "<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        i++;
      }
      out.push(t + "</tbody></table>");
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const lvl = Math.min(h[1].length + 2, 6); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue; }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push("<blockquote>" + inline(q.join(" ")) + "</blockquote>");
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push("<li>" + inline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>"); i++;
      }
      out.push("<ul>" + items.join("") + "</ul>");
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>"); i++;
      }
      out.push("<ol>" + items.join("") + "</ol>");
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flush();

  // 3. Reinsert any inline math placeholders left inside paragraphs/list items.
  const inlineMath = new RegExp(`${TA}(\\d+)${TB}`, "g");
  return out.join("\n").replace(inlineMath, (m, n) => maths[+n]);
}
