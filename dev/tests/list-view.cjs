/* Node test: the row accounting of the real list-view component. The
   component runs in a small fake DOM; no browser is needed. What is verified:

     - the row count that drives the height of the hidden select follows the
       real number of items
     - a single item still uses the two-row native workaround but exposes a
       one-row height, so it cannot create a phantom scrollbar
     - removing rows updates the exposed height immediately

   Run: node dev/tests/list-view.cjs */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIST_VIEW = path.resolve(__dirname, '../../v2/data/player/components/list-view.js');

const makeStyle = () => ({
  props: {},

  setProperty(name, value) {
    this.props[name] = value;
  }
});

const makeNode = (tagName = 'div') => ({
  tagName,
  children: [],
  parent: null,
  attributes: {},
  style: makeStyle(),
  listeners: {},

  append(node) {
    node.parent = this;
    this.children.push(node);
  },
  appendChild(node) {
    this.append(node);
    return node;
  },
  after(node) {
    const list = this.parent.children;
    const at = list.indexOf(this);
    list.splice(at + 1, 0, node);
    node.parent = this.parent;
  },
  remove() {
    if (this.parent) {
      const at = this.parent.children.indexOf(this);
      if (at !== -1) {
        this.parent.children.splice(at, 1);
      }
    }
  },
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    this.attributeChangedCallback?.(name, null, String(value));
  },
  getAttribute(name) {
    return this.attributes[name];
  },
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  },
  dispatchEvent(event) {
    for (const fn of (this.listeners[event.type] || []).slice()) {
      fn(event);
    }
  },
  querySelector(selector) {
    return this.children.find(node =>
      selector === 'slot' && node.tagName.toLowerCase() === 'slot') || null;
  },
  querySelectorAll() {
    return this.children.filter(node => node.tagName.toLowerCase() !== 'slot');
  }
});

class FakeShadowRoot {
  #nodes;

  constructor(host) {
    this.host = host;
    this.#nodes = {};
    this.children = [];
    this.innerHTML = '';
  }

  set innerHTML(value) {
    if (this.#nodes.select) {
      return; // the component builds its shadow tree once
    }

    const select = makeNode('select');
    const header = makeNode('div');
    const slot = makeNode('slot');
    const parent = makeNode('div');
    const extra = makeNode('style');

    const optionsContainer = {children: []};
    const hiddenHeader = makeNode('option');
    hiddenHeader.parent = optionsContainer;
    optionsContainer.children.push(hiddenHeader);

    select.optionsContainer = optionsContainer;
    select.options = optionsContainer.children;
    select.selectedOptions = [];
    select.size = 0;
    select.selectedIndex = 0;
    Object.defineProperty(select, 'length', {
      get: () => select.options.length
    });

    header.append(slot);
    parent.append(select);
    parent.append(header);
    slot.assignedElements = () => this.host.children;

    this.#nodes = {
      select,
      header,
      slot,
      parent,
      extra,
      hiddenHeader
    };
  }

  get innerHTML() {
    return '';
  }

  getElementById(id) {
    return this.#nodes[id];
  }

  append(node) {
    this.children.push(node);
  }
}

class FakeHTMLElement {
  constructor() {
    this.children = [];
    this.attributes = {};
    this.style = makeStyle();
    this.listeners = {};
    this.offset = 0;
  }

  attachShadow() {
    this.shadowRoot = new FakeShadowRoot(this);
    return this.shadowRoot;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    this.attributeChangedCallback?.(name, null, String(value));
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatchEvent(event) {
    for (const fn of (this.listeners[event.type] || []).slice()) {
      fn(event);
    }
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }
}

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = Boolean(options.bubbles);
  }
}

class FakeMutationObserver {
  observe() {}
}

const makeWorld = () => {
  const registry = new Map();
  const customElements = {
    define(name, cls) {
      registry.set(name, cls);
    },
    get(name) {
      return registry.get(name);
    }
  };
  const document = {
    createElement: tag => makeNode(tag)
  };
  const context = {
    HTMLElement: FakeHTMLElement,
    MutationObserver: FakeMutationObserver,
    Event: FakeEvent,
    customElements,
    document,
    console
  };
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(LIST_VIEW, 'utf8'), vm.createContext(context), {
    filename: LIST_VIEW
  });

  return context;
};

const must = (condition, message) => {
  if (condition === false) {
    throw Error(message);
  }
};

const run = async () => {
  const source = fs.readFileSync(LIST_VIEW, 'utf8');
  must(source.includes('height: calc(var(--height) * var(--rows, 0))'),
    'the hidden select does not follow the exposed row count');

  const world = makeWorld();
  const ListView = world.customElements.get('simple-list-view');
  const view = new ListView();

  view.setAttribute('headers', 'false');
  const title = world.document.createElement('span');
  title.setAttribute('width', '1fr');
  const link = world.document.createElement('span');
  link.setAttribute('width', '2fr');
  view.appendChild(title);
  view.appendChild(link);
  view.connectedCallback();

  const parent = view.shadowRoot.getElementById('parent');
  const select = view.shadowRoot.getElementById('select');
  const state = () => ({
    rows: Number(parent.style.props['--rows']),
    size: select.size,
    length: view.length
  });

  let s = state();
  must(s.rows === 0 && s.size === 0 && s.length === 0, 'the empty list is not one empty row');

  view.option([{name: 'One'}, {name: 'link'}], 'One', 1).insert();
  s = state();
  must(s.length === 1, 'the first item did not enter the list');
  must(s.size === 2, 'the single-item list-box workaround was dropped');
  must(s.rows === 1, 'one item exposes more than one row of height');

  view.option([{name: 'Two'}, {name: 'link'}], 'Two', 2).insert();
  s = state();
  must(s.length === 2 && s.rows === 2 && s.size === 2, 'two items expose the wrong row count');

  view.option([{name: 'Three'}, {name: 'link'}], 'Three', 3).insert();
  s = state();
  must(s.length === 3 && s.rows === 3 && s.size === 3, 'three items expose the wrong row count');

  view.removeIndex(1);
  s = state();
  must(s.length === 2 && s.rows === 2 && s.size === 2, 'a removal did not refresh the row count');

  view.removeIndex(1);
  s = state();
  must(s.length === 1 && s.rows === 1 && s.size === 2,
    'the last surviving item exposes a phantom second row');

  view.clear();
  s = state();
  must(s.length === 0 && s.rows === 0, 'clearing the list left a row behind');

  console.log('LIST-VIEW TEST PASSED');
};

run().catch(e => {
  console.error('LIST-VIEW TEST FAILED:', e.message);
  process.exit(1);
});
