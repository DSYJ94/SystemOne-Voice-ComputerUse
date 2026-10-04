// SystemOne in-page agent for the user's own browser tab (Chrome, Safari,
// Brave, Edge via AppleScript "execute javascript"). It reads visible
// interactive elements and short texts from the DOM, and clicks, types or
// copies by the ids it handed out. Returns a JSON string. Roles are reported
// in Accessibility terms so the agent describes web and native apps alike.
function systemOneDomAgent(req) {
  const MAX = 220, MAX_TEXTS = 60;
  // Icon fonts draw glyphs from Unicode's private-use areas (e.g. \ue488); they mean nothing
  // as words, so they are removed like control characters.
  const clean = text => String(text || '').replace(/[\ue000-\uf8ff\u{f0000}-\u{10ffff}\u0000-\u001f\u200b-\u200f]/gu, '')
    .replace(/\s+/g, ' ').trim();
  const isField = el => el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
    || (el.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'hidden', 'range', 'color']
      .includes((el.type || 'text').toLowerCase()))
    || ['textbox', 'searchbox', 'combobox'].includes(el.getAttribute('role'));
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    return r.bottom > -40 && r.top < innerHeight + 40 && r.right > 0 && r.left < innerWidth;
  };
  const roleOf = el => {
    const role = el.getAttribute('role');
    const tag = el.tagName;
    const type = (el.type || '').toLowerCase();
    if (role === 'tab') return 'AXTab';
    if (['treeitem', 'row', 'gridcell', 'option', 'listitem'].includes(role)) return 'AXRow';
    if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return 'AXMenuItem';
    if (role === 'checkbox' || role === 'switch' || type === 'checkbox') return 'AXCheckBox';
    if (role === 'radio' || type === 'radio') return 'AXRadioButton';
    if (tag === 'SELECT' || role === 'combobox' || role === 'listbox') return 'AXPopUpButton';
    if (tag === 'TEXTAREA' || el.isContentEditable || role === 'textbox' && el.getAttribute('aria-multiline') === 'true') return 'AXTextArea';
    if (role === 'searchbox' || type === 'search') return 'AXSearchField';
    if (isField(el)) return 'AXTextField';
    if ((tag === 'A' && el.href) || role === 'link') return 'AXLink';
    return 'AXButton';
  };
  const labelOf = el => {
    const labelled = el.getAttribute('aria-labelledby');
    const byId = labelled ? labelled.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean)
      .map(node => node.innerText).join(' ') : '';
    const fieldLabel = el.labels && el.labels.length ? el.labels[0].innerText : '';
    const buttonValue = el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type) ? el.value : '';
    const own = el.tagName === 'SELECT' ? '' : (el.innerText || el.textContent);
    // First source that says something: sites sometimes put "true", "null" or a bare id in aria-label.
    // An icon-only control is often named by its tooltip, an inner icon's label, or a labelled wrapper.
    const inner = el.querySelector('[aria-label],[title],img[alt],svg title');
    const innerLabel = inner ? (inner.getAttribute('aria-label') || inner.getAttribute('title') || inner.getAttribute('alt')
      || inner.textContent) : '';
    const sources = [el.getAttribute('aria-label'), byId, fieldLabel, el.getAttribute('title'),
      el.getAttribute('placeholder'), el.getAttribute('alt'), buttonValue, own, innerLabel,
      el.getAttribute('data-tooltip'), el.getAttribute('aria-description')];
    const meaningful = text => text && !/^(?:true|false|null|undefined|nan|on|off|[-_.#\s]+)$/i.test(text);
    return (sources.map(item => clean(item || '')).find(meaningful) || '').slice(0, 120);
  };
  const contextOf = el => {
    const near = el.closest('[aria-label]:not(a):not(button),nav,header,footer,aside,form,dialog,[role=dialog],[role=navigation],li,tr,article,section');
    if (!near || near === el) return '';
    const name = near.getAttribute('aria-label') || (near.matches('li,tr,article') ? near.innerText : '')
      || ({ NAV: 'navigation', HEADER: 'header', FOOTER: 'footer', ASIDE: 'sidebar', FORM: 'form', DIALOG: 'dialog' })[near.tagName] || '';
    return clean(name).slice(0, 60);
  };
  const ok = value => JSON.stringify({ ok: true, value: value === undefined ? null : value });
  const fail = error => JSON.stringify({ ok: false, error });

  if (req.op === 'snapshot') {
    // Every interactive ARIA role (tree items in folder lists, rows and options in message
    // lists, grid cells…), plus anything reachable with the keyboard.
    const selector = 'a[href],button,input:not([type=hidden]),textarea,select,summary,'
      + ['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch',
        'combobox', 'searchbox', 'textbox', 'treeitem', 'row', 'gridcell', 'slider', 'spinbutton']
        .map(role => `[role=${role}]`).join(',')
      + ',[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
    const registry = [];
    const elements = [];
    let truncated = false;
    for (const el of document.querySelectorAll(selector)) {
      if (elements.length >= MAX) { truncated = true; break; }
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      // A span inside a link is the same target as the link itself.
      if (!isField(el) && el.parentElement && el.parentElement.closest('a[href],button,[role=button],[role=link]')) continue;
      const label = labelOf(el);
      if (!label) continue;
      const type = (el.type || '').toLowerCase();
      const secure = type === 'password';
      const field = isField(el) && !el.readOnly && el.tagName !== 'SELECT';
      // Items in a list say where they are ("item 1 of 25"), so "the latest" or "the second" can be judged.
      const item = el.closest('[role=row],[role=option],[role=treeitem],[role=listitem],li,tr,article');
      let position = '';
      if (item && item.parentElement) {
        const peers = [...item.parentElement.children].filter(peer => peer.tagName === item.tagName
          && (peer.getAttribute('role') || '') === (item.getAttribute('role') || ''));
        if (peers.length > 2) position = `item ${peers.indexOf(item) + 1} of ${peers.length}`;
      }
      const context = [contextOf(el), position].filter(Boolean).join(' · ');
      const entry = { id: `d${registry.length}`, role: roleOf(el), label, context,
        editable: field && !secure, secure, pressable: !field || el.tagName === 'SELECT' };
      if (field && !secure) entry.value = clean(el.isContentEditable ? el.innerText : el.value).slice(0, 80);
      if (el.tagName === 'SELECT' && el.selectedOptions[0]) entry.value = clean(el.selectedOptions[0].text);
      if (el.checked || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true'
        || el.getAttribute('aria-current') === 'page') entry.selected = true;
      if (el.tagName === 'A' && el.href) entry.url = el.href.slice(0, 300);
      registry.push(el);
      elements.push(entry);
    }
    // Short visible texts (headings, cells, list items) so values can be read and copied.
    let texts = 0;
    for (const el of document.querySelectorAll('h1,h2,h3,h4,p,td,th,li,dd,dt,span,strong,label,time,div')) {
      if (texts >= MAX_TEXTS) break;
      if (el.children.length || el.closest('a,button') || !visible(el)) continue;
      const text = clean(el.innerText);
      if (text.length < 2 || text.length > 160) continue;
      texts++;
      elements.push({ id: `d${registry.length}`, role: 'AXStaticText', label: text, context: contextOf(el),
        editable: false, pressable: false });
      registry.push(el);
    }
    window.__systemoneElements = registry;
    const active = document.activeElement && registry.indexOf(document.activeElement);
    return ok({ title: document.title, url: location.href, elements, truncated,
      focused: active >= 0 ? `d${active}` : null, scrollY: Math.round(scrollY) });
  }

  const registry = window.__systemoneElements || [];
  const el = registry[Number(String(req.id || '').slice(1))];
  if (req.op === 'scroll') { scrollBy({ top: (req.down ? 1 : -1) * innerHeight * 0.8, behavior: 'instant' }); return ok(); }
  if (!el || !el.isConnected) return fail('stale element');
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (req.op === 'changed') {
    // Whether the page reacted to the last press (DOM changes or navigation).
    const watch = window.__systemoneWatch || {};
    if (watch.observer) watch.observer.disconnect();
    return ok({ mutations: watch.mutations || 0, moved: location.href !== watch.href });
  }
  if (req.op === 'press') {
    if (el.tagName === 'SELECT') { el.focus(); return ok(); }
    const watch = { mutations: 0, href: location.href };
    watch.observer = new MutationObserver(records => { watch.mutations += records.length; });
    watch.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__systemoneWatch = watch;
    el.focus({ preventScroll: true });
    // The whole pointer sequence: many apps (Gmail, Outlook) act on pointer/mouse down, not on click().
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', at));
    el.dispatchEvent(new MouseEvent('mousedown', at));
    el.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.click();
    // Where it is on screen, for a real mouse click if the page ignores synthetic events.
    // Page zoom scales CSS pixels; the browser's own bars sit above the page.
    const zoom = outerWidth / innerWidth;
    const chrome = Math.max(0, outerHeight - innerHeight * zoom);
    return ok({ x: screenX + (r.left + r.width / 2) * zoom, y: screenY + chrome + (r.top + r.height / 2) * zoom });
  }
  if (req.op === 'copy') {
    const text = clean(isField(el) ? (el.value || el.innerText) : el.innerText || el.textContent);
    return text ? ok(text) : fail('nothing to copy');
  }
  if (req.op === 'type' || req.op === 'paste') {
    const text = String(req.text || '');
    el.focus();
    if (el.isContentEditable) {
      // Append at the end, never replace what is already written.
      const range = document.createRange();
      range.selectNodeContents(el); range.collapse(false);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('insertText', false, (clean(el.innerText) ? '\n' : '') + text);
      return ok(clean(el.innerText).slice(-80));
    }
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find(item => clean(item.text).toLowerCase() === text.toLowerCase());
      if (!option) return fail('no such option');
      el.value = option.value;
    } else {
      const next = el.tagName === 'TEXTAREA' && el.value ? `${el.value}\n${text}` : text;
      const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, next);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return ok(clean(el.value).slice(-80));
  }
  return fail('unsupported operation');
}
