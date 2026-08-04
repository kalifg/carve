import assert from 'node:assert/strict';
import test from 'node:test';

import { splitTopLevelCsg, wrap2dForPreview } from '../media/csg-preview.mjs';

test('splits independent normalized CSG roots without splitting nested operations', () => {
  const source = `
    multmatrix([[1, 0, 0, -20], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {
      difference() {
        circle(r = 10);
        circle(r = 5);
      }
    }
    translate([20, 0, 0]) { cube(size = [10, 10, 10]); }
  `;

  const roots = splitTopLevelCsg(source);

  assert.equal(roots.length, 2);
  assert.match(roots[0], /difference\(\)/);
  assert.match(roots[1], /cube\(/);
});

test('preserves preview modifiers, colors, comments, and punctuation in strings', () => {
  const source = `
    // profile
    #color([1, 0, 0, 1]) { text("brace }; and semicolon ;"); }
    %color([0, 0.5, 1, 0.4]) { cube(10); }
  `;

  const roots = splitTopLevelCsg(source);

  assert.equal(roots.length, 2);
  assert.match(roots[0], /^\/\/ profile\s+#color/);
  assert.match(roots[1], /^%color/);
});

test('rejects incomplete normalized CSG output', () => {
  assert.throws(
    () => splitTopLevelCsg('difference() { circle(10);'),
    /incomplete CSG output/
  );
});

test('wraps a 2D CSG branch in a shallow preview extrusion', () => {
  const wrapped = wrap2dForPreview('difference() { circle(10); circle(5); }', 0.02);

  assert.match(wrapped, /^linear_extrude\(height = 0\.02/);
  assert.match(wrapped, /difference\(\)/);
});

test('extrudes before applying an outer transform to preserve a rotated sketch plane', () => {
  const root = `
    multmatrix([[0, 0, 1, 0], [0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 0, 1]]) {
      circle(r = 10);
    }
  `;
  const wrapped = wrap2dForPreview(root);

  assert.ok(wrapped.indexOf('multmatrix') < wrapped.indexOf('linear_extrude'));
  assert.ok(wrapped.indexOf('linear_extrude') < wrapped.indexOf('circle'));
});

test('preserves transparent group and color wrappers around the preview extrusion', () => {
  const root = `
    #color([1, 0, 0, 1]) {
      group() {
        circle(r = 10);
      }
    }
  `;
  const wrapped = wrap2dForPreview(root);

  assert.match(wrapped, /^#color/);
  assert.ok(wrapped.indexOf('group') < wrapped.indexOf('linear_extrude'));
});
