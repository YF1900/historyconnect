/**
 * 安全な DOM 生成ヘルパー。
 * テキストは必ず textContent で入れ、innerHTML は使わない（XSS対策）。
 */
type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | number | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** 外部リンク。参照元を送らず、新しいタブで開く */
export function extLink(href: string, label: string, cls = ''): HTMLAnchorElement {
  const safe = /^https?:\/\//.test(href) ? href : '#';
  return h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', class: cls }, label);
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** null などを除いて子要素を追加する */
export function add(parent: Element, ...children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child);
  }
}
