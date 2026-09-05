'use strict';
/* ============================================================
   colaco.se — core
   ============================================================ */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/* Safe storage: falls back to in-memory when localStorage is unavailable
   (e.g. sandboxed previews). */
const store = {
  _m: {},
  get(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? (k in this._m ? this._m[k] : d) : JSON.parse(v); }
    catch (e) { return k in this._m ? this._m[k] : d; }
  },
  set(k, v) {
    this._m[k] = v;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* in-memory only */ }
  }
};

function timeAgo(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '';
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;   if (m < 60)  return Math.floor(m) + ' min ago';
  const h = m / 60;   if (h < 24)  return Math.floor(h) + (h < 2 ? ' hour ago' : ' hours ago');
  const dd = h / 24;  if (dd < 7)  return Math.floor(dd) + (dd < 2 ? ' day ago' : ' days ago');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

