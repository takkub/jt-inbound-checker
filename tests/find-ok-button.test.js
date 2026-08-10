'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

class FixtureElement {
  constructor(tag, { text = '', className = '', role = '', rect = [0, 0, 100, 32] } = {}) {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
    this.className = className;
    this.hidden = false;
    this.disabled = false;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.clickCount = 0;
    if (role) this.attributes.set('role', role);
    const [left, top, width, height] = rect;
    this.rect = { left, top, width, height, right: left + width, bottom: top + height };
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }

  matches(selector) {
    return selector.split(',').some(raw => {
      const part = raw.trim();
      if (part === 'button') return this.tagName === 'BUTTON';
      if (part === 'form') return this.tagName === 'FORM';
      if (part === 'main') return this.tagName === 'MAIN';
      if (part === 'body') return this.tagName === 'BODY';
      if (part === '[role="button"]') return this.getAttribute('role') === 'button';
      if (part === '[role="main"]') return this.getAttribute('role') === 'main';
      if (part.startsWith('.')) return this.className.split(/\s+/).includes(part.slice(1));
      return false;
    });
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  getClientRects() { return this.rect.width && this.rect.height ? [this.rect] : []; }
  getBoundingClientRect() { return this.rect; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); return true; }
  click() { this.clickCount++; this.listeners.get('click')?.({ type: 'click' }); }
}

class FixtureInput extends FixtureElement {
  constructor(options) { super('input', options); this._value = ''; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
}

class FixtureEvent {
  constructor(type, options = {}) { this.type = type; this.bubbles = !!options.bubbles; }
}

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const context = {
  SEL: { messageBox: '.el-message-box, .ant-modal' },
  HTMLInputElement: FixtureInput,
  Event: FixtureEvent,
  InputEvent: FixtureEvent,
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
};
vm.createContext(context);
vm.runInContext([
  'isVisible',
  'isSafeOkButton',
  'isStrictlyNearWaybillInput',
  'findOkButton',
  'fillWaybillInput',
  'isInboundLocation',
].map(name => extractFunction(source, name)).join('\n'), context);

const { findOkButton, fillWaybillInput, isInboundLocation } = context;
const div = options => new FixtureElement('div', options);
const button = (text, rect) => new FixtureElement('button', { text, rect });
const input = rect => new FixtureInput({ rect });

test('new-page sibling wrappers find the adjacent exact OK', () => {
  const field = input([20, 10, 180, 32]);
  const ok = button('OK', [212, 10, 55, 32]);
  const row = div().append(div().append(field), div().append(ok));
  new FixtureElement('form').append(row);
  assert.equal(findOkButton(field), ok);
});

test('nested wrappers still resolve at their nearest shared row', () => {
  const field = input([20, 20, 180, 32]);
  const ok = button(' ok ', [212, 20, 55, 32]);
  const row = div().append(div().append(div().append(field)), div().append(div().append(ok)));
  new FixtureElement('form').append(row);
  assert.equal(findOkButton(field), ok);
});

test('a form-wide unrelated exact OK is ignored in favor of the local OK', () => {
  const field = input([20, 10, 180, 32]);
  const localOk = button('OK', [212, 10, 55, 32]);
  const unrelatedOk = button('OK', [212, 320, 55, 32]);
  const form = new FixtureElement('form');
  form.append(div().append(field), div().append(localOk), div().append(unrelatedOk));
  assert.equal(findOkButton(field), localOk);
});

test('a page-wide exact OK is rejected when no associated local OK exists', () => {
  const field = input([20, 10, 180, 32]);
  const unrelatedOk = button('OK', [700, 320, 55, 32]);
  const page = div().append(div().append(field), div().append(unrelatedOk));
  new FixtureElement('main').append(page);
  assert.equal(findOkButton(field), null);
  assert.equal(unrelatedOk.clickCount, 0);
});

test('Upload All beside the Waybill controls is never eligible', () => {
  const field = input([20, 10, 180, 32]);
  const uploadAll = button('Upload All', [275, 10, 100, 32]);
  const ok = button('OK', [212, 10, 55, 32]);
  const row = div().append(field, ok, uploadAll);
  new FixtureElement('form').append(row);
  assert.equal(findOkButton(field), ok);
  assert.equal(uploadAll.clickCount, 0);
});

test('a dialog OK is excluded even when it is geometrically close', () => {
  const field = input([20, 10, 180, 32]);
  const dialogOk = button('OK', [212, 10, 55, 32]);
  const dialog = div({ className: 'ant-modal' }).append(dialogOk);
  const form = new FixtureElement('form').append(field, dialog);
  assert.equal(findOkButton(field), null);
  assert.equal(dialogOk.clickCount, 0);
});

test('multiple local exact OK buttons fail safely', () => {
  const field = input([20, 10, 180, 32]);
  const row = div().append(field, button('OK', [212, 10, 55, 32]), button('OK', [275, 10, 55, 32]));
  new FixtureElement('form').append(row);
  assert.equal(findOkButton(field), null);
});

test('fill then click stages the entered waybill through the local OK', () => {
  const field = input([20, 10, 180, 32]);
  const ok = button('OK', [212, 10, 55, 32]);
  const staged = [];
  const events = [];
  field.addEventListener('input', event => events.push(event.type));
  field.addEventListener('change', event => events.push(event.type));
  ok.addEventListener('click', () => staged.push(field.value));
  new FixtureElement('form').append(div().append(field, ok));

  fillWaybillInput(field, 'JT1234567890');
  findOkButton(field).click();

  assert.equal(field.value, 'JT1234567890');
  assert.deepEqual(events, ['input', 'change']);
  assert.deepEqual(staged, ['JT1234567890']);
});

test('both new and legacy inbound routes remain accepted', () => {
  assert.equal(isInboundLocation({ protocol: 'https:', hostname: 'home-site.jtexpress.co.th', pathname: '/mailPutIn', hash: '' }), true);
  assert.equal(isInboundLocation({ protocol: 'https:', hostname: 'home.jtexpress.co.th', pathname: '/', hash: '#/mailPutIn' }), true);
  assert.equal(isInboundLocation({ protocol: 'https:', hostname: 'home-site.jtexpress.co.th', pathname: '/other', hash: '' }), false);
});
