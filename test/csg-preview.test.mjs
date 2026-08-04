import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mayContainColor,
  mayContainMixedGeometry,
  splitCsgForPreview,
  splitTopLevelCsg,
  wrap2dForPreview
} from '../media/csg-preview.mjs';

test('recognizes color calls while ignoring comments and strings', () => {
  assert.equal(mayContainColor('color("red") cube(10);'), true);
  assert.equal(mayContainColor('cube(10); // color("red")'), false);
  assert.equal(mayContainColor('text("color(red)");'), false);
});

test('recognizes scenes that may combine 2D and 3D constructors', () => {
  assert.equal(
    mayContainMixedGeometry('cylinder(h=5, r1=4, r2=0); rotate([0,90,0]) circle(50);'),
    true
  );
  assert.equal(mayContainMixedGeometry('linear_extrude(5) circle(10);'), true);
  assert.equal(mayContainMixedGeometry('cube(10); sphere(5);'), false);
  assert.equal(mayContainMixedGeometry('circle(10); square(5);'), false);
});

test('mixed-geometry hint ignores constructors in comments and strings', () => {
  assert.equal(mayContainMixedGeometry('cube(10); // circle(50);'), false);
  assert.equal(mayContainMixedGeometry('text("cylinder(20)");'), false);
});

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

test('splits presentation-safe wrappers and carries evaluated colors', () => {
  const source = `
    group() {
      cylinder(h = 5, r = 3);
      multmatrix([[1, 0, 0, 20], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {
        color([1, 0.25, 0.5, 0.4]) { cylinder(h = 5, r = 2); }
      }
    }
  `;

  const parts = splitCsgForPreview(source);

  assert.equal(parts.length, 2);
  assert.equal(parts[0].color, undefined);
  assert.deepEqual(parts[1].color, { r: 1, g: 0.25, b: 0.5, a: 0.4 });
  assert.match(parts[1].source, /^group\(\)/);
  assert.match(parts[1].source, /multmatrix/);
  assert.match(parts[1].source, /color\(\[1, 0\.25, 0\.5, 0\.4\]\)/);
});
