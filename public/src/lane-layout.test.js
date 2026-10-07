// The lane label has to stay inside the gutter the car starts after. A lane's
// padding-left is where the car's `left` begins, and the label is positioned
// absolutely from the lane's own edge, so nothing in the flow stops a long
// handle from running under the car: the bound has to be written down, at
// every breakpoint that moves the gutter. A 24-character handle (the room's
// MAX_HANDLE_LEN) used to run ~150px past the car's start at 1280px.
//
// Reads the shipped stylesheet rather than rendering — `public/` has no build
// step and Node has no layout engine — so it checks the rule's shape: the
// label is clipped with an ellipsis and its max-width plus its left offset
// fits the gutter, desktop and narrow alike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style-a.css', import.meta.url), 'utf8');

/** Declarations of the first `selector {…}` block found in `text`. */
function block(text, selector) {
  const at = text.search(new RegExp(`(^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{`));
  assert.notEqual(at, -1, `${selector} rule not found`);
  const open = text.indexOf('{', at);
  const body = text.slice(open + 1, text.indexOf('}', open));
  const decls = {};
  for (const part of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) decls[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return decls;
}

/** The body of the first `@media (max-width: 540px)` block. */
function narrowMedia() {
  const at = css.indexOf('@media (max-width: 540px)');
  assert.notEqual(at, -1, 'narrow breakpoint not found');
  let depth = 0;
  const start = css.indexOf('{', at);
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start + 1, i);
  }
  throw new Error('unterminated media block');
}

/** rem total of a `calc(a - b - c)` or a bare `Nrem`; only subtraction of rem terms. */
function rem(value) {
  const terms = value.replace(/^calc\(|\)$/g, '').split(/\s+-\s+/);
  return terms
    .map((t) => {
      const m = /^(-?[\d.]+)rem$/.exec(t.trim());
      assert.ok(m, `unexpected term ${t} in ${value}`);
      return Number(m[1]);
    })
    .reduce((acc, n, i) => (i === 0 ? n : acc - n));
}

test('a long lane handle is ellipsized, not left to overflow', () => {
  const label = block(css, '.lane-handle');
  assert.equal(label.overflow, 'hidden');
  assert.equal(label['text-overflow'], 'ellipsis');
  assert.equal(label['white-space'], 'nowrap');
});

test('the label fits the gutter the car starts after, at desktop width', () => {
  const lane = block(css, '.lane');
  const label = block(css, '.lane-handle');
  assert.ok(label['max-width'], '.lane-handle needs a max-width');
  assert.ok(rem(label.left) + rem(label['max-width']) <= rem(lane['padding-left']));
});

test('the label fits the narrower gutter too', () => {
  const narrow = narrowMedia();
  const desktopLabel = block(css, '.lane-handle');
  const lane = block(narrow, '.lane');
  const label = block(narrow, '.lane-handle');
  assert.ok(label['max-width'], 'the narrow breakpoint must re-bound the label');
  const left = label.left ?? desktopLabel.left;
  assert.ok(rem(left) + rem(label['max-width']) <= rem(lane['padding-left']));
});
