/** These functions are serialized by chrome.scripting.executeScript. Keep each
 * self-contained: captured module variables do not exist in the page world. */
export function collectSemantic(observationId) {
  const elements = [];
  const handles = new Map();
  const nodes = document.querySelectorAll('button,a,input,select,textarea,[role]');
  let index = 0;
  for (; index < Math.min(nodes.length, 2_000) && elements.length < 80; index++) {
    const node = nodes[index];
    if (node.isContentEditable || node.closest('[contenteditable="true"]')) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden'
      || node.getClientRects().length === 0) continue;
    const tag = node.tagName.toLowerCase();
    const inputType = tag === 'input' ? String(node.type ?? '').toLowerCase() : '';
    if (['password', 'hidden', 'file'].includes(inputType)) continue;
    const label = (node.getAttribute('aria-label') || node.getAttribute('title')
      || node.getAttribute('placeholder') || node.labels?.[0]?.textContent
      || (['input', 'textarea', 'select'].includes(tag) ? '' : node.innerText) || '')
      .replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!label) continue;
    const role = (node.getAttribute('role') || tag).slice(0, 40);
    const disabled = Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true');
    const editable = !disabled && (tag === 'textarea'
      || (tag === 'input' && ['text', 'search', 'email', 'tel', 'url'].includes(inputType)));
    const id = `${observationId}:${index}`;
    handles.set(id, node);
    elements.push({ id, role, label, disabled, editable });
  }
  // The registry is in this extension's isolated world, never on the shared
  // DOM. An action can only use a node retained by this exact observation.
  globalThis.__systemoneChromeRegistry = {
    observationId, url: location.href, document, handles,
  };
  return { observationId, title: document.title.slice(0, 160),
    url: location.href.slice(0, 2_048),
    complete: nodes.length <= 2_000 && index === nodes.length, elements };
}

export function fillSemantic(input) {
  const registry = globalThis.__systemoneChromeRegistry;
  if (!registry || registry.document !== document
    || registry.observationId !== input.observationId
    || registry.url !== input.url || location.href !== input.url) {
    return 'not_dispatched';
  }
  const node = registry.handles.get(input.candidateId);
  if (!node || !node.isConnected || node.isContentEditable
    || node.closest('[contenteditable="true"]')) return 'not_dispatched';
  const tag = node.tagName.toLowerCase();
  const inputType = tag === 'input' ? String(node.type ?? '').toLowerCase() : '';
  if (!(tag === 'textarea' || (tag === 'input'
    && ['text', 'search', 'email', 'tel', 'url'].includes(inputType)))) {
    return 'not_dispatched';
  }
  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden'
    || node.getClientRects().length === 0 || node.disabled
    || node.getAttribute('aria-disabled') === 'true') return 'not_dispatched';
  const label = (node.getAttribute('aria-label') || node.getAttribute('title')
    || node.getAttribute('placeholder') || node.labels?.[0]?.textContent || '')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
  const role = (node.getAttribute('role') || tag).slice(0, 40);
  if (label !== input.label || role !== input.role
    || typeof input.value !== 'string' || new TextEncoder().encode(input.value).length > 1_024) {
    return 'not_dispatched';
  }
  // A second matching field appearing after observation makes the user's
  // label ambiguous. Do this immediately before the setter, in this document.
  let matching = 0;
  for (const other of document.querySelectorAll('input,textarea')) {
    if (other.isContentEditable || other.closest('[contenteditable="true"]')) continue;
    const otherTag = other.tagName.toLowerCase();
    const otherType = otherTag === 'input' ? String(other.type ?? '').toLowerCase() : '';
    if (!(otherTag === 'textarea' || (otherTag === 'input'
      && ['text', 'search', 'email', 'tel', 'url'].includes(otherType)))) continue;
    const otherStyle = getComputedStyle(other);
    if (otherStyle.display === 'none' || otherStyle.visibility === 'hidden'
      || other.getClientRects().length === 0 || other.disabled
      || other.getAttribute('aria-disabled') === 'true') continue;
    const otherLabel = (other.getAttribute('aria-label') || other.getAttribute('title')
      || other.getAttribute('placeholder') || other.labels?.[0]?.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 160);
    if (otherLabel === input.label) matching++;
    if (matching > 1) return 'not_dispatched';
  }
  if (matching !== 1) return 'not_dispatched';
  if (node.value === input.value) return 'already_matched';
  try {
    const prototype = tag === 'textarea'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return 'not_dispatched';
    setter.call(node, input.value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return node.value === input.value ? 'matched' : 'unknown';
  } catch { return 'unknown'; }
}

export function verifySemantic(input) {
  const registry = globalThis.__systemoneChromeRegistry;
  if (!registry || registry.document !== document
    || registry.observationId !== input.observationId
    || registry.url !== input.url || location.href !== input.url) return false;
  const node = registry.handles.get(input.candidateId);
  if (!node || !node.isConnected || node.isContentEditable
    || node.closest('[contenteditable="true"]')) return false;
  const tag = node.tagName.toLowerCase();
  const inputType = tag === 'input' ? String(node.type ?? '').toLowerCase() : '';
  if (!(tag === 'textarea' || (tag === 'input'
    && ['text', 'search', 'email', 'tel', 'url'].includes(inputType)))) return false;
  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden'
    || node.getClientRects().length === 0 || node.disabled
    || node.getAttribute('aria-disabled') === 'true') return false;
  const label = (node.getAttribute('aria-label') || node.getAttribute('title')
    || node.getAttribute('placeholder') || node.labels?.[0]?.textContent || '')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
  const role = (node.getAttribute('role') || tag).slice(0, 40);
  return label === input.label && role === input.role && node.value === input.value;
}
