// SystemOne in-page agent for the user's own browser tab (Chrome, Safari,
// Brave, Edge via AppleScript "execute javascript"). It reads visible
// interactive elements and short texts from the DOM, and clicks, types or
// copies by the ids it handed out. Returns a JSON string. Roles are reported
// in Accessibility terms so the agent describes web and native apps alike.
function systemOneDomAgent(req) {
  const MAX = 220, MAX_TEXTS = 60;
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
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
    if (role === 'menuitem' || role === 'option') return 'AXMenuItem';
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
    const sources = [el.getAttribute('aria-label'), byId, fieldLabel, el.getAttribute('title'),
      el.getAttribute('placeholder'), el.getAttribute('alt'), buttonValue, (el.querySelector('img[alt]') || {}).alt, own];
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
    const selector = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],'
      + '[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=searchbox],'
      + '[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]';
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
      const entry = { id: `d${registry.length}`, role: roleOf(el), label, context: contextOf(el),
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
  if (req.op === 'press') {
    if (el.tagName === 'SELECT') { el.focus(); return ok(); }
    el.focus({ preventScroll: true });
    el.click();
    return ok();
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
