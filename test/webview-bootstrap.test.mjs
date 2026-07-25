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
