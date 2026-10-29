/** toast.mjs - single dismissible status/error message above the content. */
import { el } from './dom.mjs';

/**
 * @param {string} message
 * @param {'ok'|'error'} [tone]
 */
export function toast(message, tone = 'ok') {
  const region = document.getElementById('toast');
  if (!region) return;
  region.replaceChildren(
    el('div', { class: `toast toast-${tone}`, role: tone === 'error' ? 'alert' : 'status' },
      el('p', {}, message),
      el('button', {
        type: 'button', class: 'icon-button', 'aria-label': 'Dismiss message',
        onclick: () => region.replaceChildren(),
      }, '×')));
}
