/**
 * dom.mjs - tiny DOM helpers for the sync SPA. Text always goes through
 * textContent (never innerHTML), so server-supplied strings cannot inject
 * markup.
 */

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [props] Attributes; `dataset` assigns
 *   data-*; `on<event>` functions bind listeners; booleans set/omit the
 *   attribute (aria-* booleans serialise to "true"/"false").
 * @param {...unknown} children Nodes, strings, numbers, arrays; null/false skipped.
 * @returns {HTMLElement}
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'boolean') {
      if (key.startsWith('aria-')) node.setAttribute(key, String(value));
      else if (value) node.setAttribute(key, '');
      continue;
    }
    if (key === 'class') node.className = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** @param {string|null|undefined} iso @returns {string} Local time or 'Never'. */
export function formatTime(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

/** @param {string} p Project path (POSIX or Windows separators). */
export function basename(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
}
