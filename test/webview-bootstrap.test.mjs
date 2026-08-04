import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const viewerSource = await readFile(
  new URL('../media/viewer.js', import.meta.url),
  'utf8'
);
const extensionSource = await readFile(
  new URL('../src/extension.ts', import.meta.url),
  'utf8'
);

test('every bare viewer import is represented in the webview import map', () => {
  const specifiers = [
    ...viewerSource.matchAll(/\bfrom\s+['"]([^./][^'"]*)['"]/g)
  ].map((match) => match[1]);

  assert.deepEqual(specifiers, [
    'openscad',
    'three',
    'three/addons/controls/OrbitControls.js',
    'three/addons/loaders/STLLoader.js'
  ]);

  for (const specifier of specifiers) {
    assert.match(extensionSource, new RegExp(`"${specifier.replaceAll('.', '\\.')}":`));
  }
});

test('the 2D fallback does not add another webview startup module', () => {
  assert.match(viewerSource, /const PREVIEW_2D_FORMAT = 'svg'/);
  assert.match(viewerSource, /function fallbackPreviewFormat\(/);
  assert.doesNotMatch(extensionSource, /carve-preview-format/);
});

test('every WASM instance receives output hooks during construction', () => {
  assert.equal(viewerSource.match(/print: capture\.print,/g)?.length, 2);
  assert.equal(viewerSource.match(/printErr: capture\.printErr/g)?.length, 2);
  assert.doesNotMatch(viewerSource, /Module\.printErr\s*=/);
});

test('the 2D viewer supports fit, pointer-centered zoom, pan, and axes', () => {
  assert.match(viewerSource, /function fit2d\(/);
  assert.match(viewerSource, /addEventListener\('wheel'/);
  assert.match(viewerSource, /setPointerCapture\(event\.pointerId\)/);
  assert.match(viewerSource, /strokeStyle = '#d64545'/);
  assert.match(viewerSource, /strokeStyle = '#36a269'/);
  assert.match(extensionSource, /id="viewer2dGrid"/);
  assert.match(extensionSource, /id="fit2d"/);
});

test('2D axis measurements adapt to zoom and preserve OpenSCAD Y direction', () => {
  assert.match(viewerSource, /function formatAxisValue\(/);
  assert.match(viewerSource, /formatAxisValue\(value, step\)/);
  assert.match(viewerSource, /formatAxisValue\(-svgValue, step\)/);
  assert.match(viewerSource, /const step = gridStepForScale\(view2dScale\)/);
});

test('empty geometry is a neutral preview state and localization noise is filtered', () => {
  assert.match(viewerSource, /function cleanStderr\(/);
  assert.match(viewerSource, /Could not initialize localization/);
  assert.match(viewerSource, /function isEmptyTopLevel\(/);
  assert.match(viewerSource, /empty: true/);
  assert.match(viewerSource, /function showEmpty\(/);
  assert.match(extensionSource, /id="emptyPreview"/);
});

test('mixed 2D and 3D geometry is detected before a partial preview is shown', () => {
  assert.match(viewerSource, /function isMixedDimensions\(/);
  assert.match(viewerSource, /mixedDimensions: true/);
  assert.match(viewerSource, /function showPlaceholder\(/);
  assert.match(viewerSource, /incompatible 2D and 3D operations/);
});

test('independent mixed roots use a combined hybrid preview', () => {
  assert.match(viewerSource, /function runHybridPreview\(/);
  assert.match(viewerSource, /splitTopLevelCsg\(/);
  assert.match(viewerSource, /wrap2dForPreview\(/);
  assert.match(viewerSource, /function showHybrid\(/);
  assert.match(viewerSource, /Hybrid 2D \+ 3D/);
});
