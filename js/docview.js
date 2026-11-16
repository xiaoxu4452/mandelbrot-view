/* A deliberately small Markdown renderer for the built-in mathematics guide.
 *
 * The guide is committed as docs/FRACTAL_MATH*.md so it can be read on GitHub
 * as well as in the app.  Pulling in a full Markdown package for one document
 * would add a network dependency to a page that must also work offline, so
 * this covers exactly the constructs the guide uses: headings, paragraphs,
 * fenced code, tables, lists, block quotes, rules and inline emphasis/code/
 * links.  LaTeX is left as readable text (the GitHub view renders it).
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function inline(src) {
  let out = esc(src);
  out = out.replace(/`([^`]+)`/g, (_, x) => `<code>${x}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (all, text, url) => {
    if (!/^(https?:\/\/|\/|#|\.\/|[\w.-]+\.(md|txt))/i.test(url)) return text;
    /* Links inside the guide are written for GitHub's docs/ folder.  Resolve
     * them the same way when the guide is shown from the site root. */
    const href = /^https?:|^\/|^#|^\.\//i.test(url) || url.includes('/')
      ? url : `docs/${url}`;
    return `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
  });
  return out;
}

/** Markdown source -> HTML string.  Never parses user input: only the two
 * documents shipped with the application are passed here. */
export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());

  for (let i = 0; i < lines.length;) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre class="${lang === 'mermaid' ? 'mermaid' : ''}"><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      flush();
      const n = head[1].length;
      out.push(`<h${n}>${inline(head[2])}</h${n}>`);
      i++;
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length &&
        /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      flush();
      const th = cells(line).map((x) => `<th>${inline(x)}</th>`).join('');
      i += 2;
      let rows = '';
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows += `<tr>${cells(lines[i]).map((x) => `<td>${inline(x)}</td>`).join('')}</tr>`;
        i++;
      }
      out.push(`<div class="doc-table"><table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*[-*]\s+/, '')));
        i++;
      }
      out.push(`<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*\d+\.\s+/, '')));
        i++;
      }
      out.push(`<ol>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(inline(lines[i].replace(/^>\s?/, '')));
        i++;
      }
      out.push(`<blockquote>${q.join('<br>')}</blockquote>`);
      continue;
    }
    if (/^---+\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}
