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

test('the preview exposes captured compiler output in a collapsible console', () => {
  assert.match(extensionSource, /id="consoleToggle"/);
  assert.match(extensionSource, /id="compileConsole"/);
  assert.match(extensionSource, /id="compileLog"/);
  assert.match(viewerSource, /function setCompileLog\(/);
  assert.match(viewerSource, /log: capturedLog\(\)/);
  assert.doesNotMatch(viewerSource, /setConsoleOpen\(true\)/);
  assert.match(viewerSource, /`Error \(\$\{ms\} ms\)\\n\$\{result\.stderr/);
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

test('the 3D viewer preserves its viewpoint between renders and supports refitting', () => {
  assert.match(viewerSource, /let has3dViewpoint = false/);
  assert.equal(viewerSource.match(/if \(!has3dViewpoint\) fit3dPreview\(\)/g)?.length, 2);
  assert.match(viewerSource, /fit3dButton\.addEventListener\('click', fit3dPreview\)/);
  assert.match(viewerSource, /canvas\.addEventListener\('dblclick', fit3dPreview\)/);
  assert.match(extensionSource, /id="fit3d"/);
});

test('the 3D viewer offers X, Y, and Z plane-aligned view presets', () => {
  assert.match(extensionSource, /id="viewPresets3d"/);
  assert.deepEqual(
    [...extensionSource.matchAll(/data-plane-view="([XYZ])"/g)].map((match) => match[1]),
    ['X', 'Y', 'Z']
  );
  assert.match(viewerSource, /const PLANE_VIEWS =/);
  assert.match(viewerSource, /function setPlaneView\(plane\)/);
  assert.match(viewerSource, /button\.dataset\.planeView/);
});

test('the 3D viewer toggles between perspective and isometric projection', () => {
  assert.match(extensionSource, /id="projection3d"/);
  assert.match(viewerSource, /new THREE\.OrthographicCamera/);
  assert.match(viewerSource, /function setOrthographicProjection\(enabled\)/);
  assert.match(viewerSource, /controls\.object = camera/);
  assert.match(viewerSource, /projection3dButton\.addEventListener\('click', toggle3dProjection\)/);
  const toggleBody = viewerSource.match(/function toggle3dProjection\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.doesNotMatch(toggleBody, /fit3dPreview/);
});

test('the 3D viewer uses a light studio background and balanced lighting', () => {
  assert.match(viewerSource, /renderer\.outputColorSpace = THREE\.SRGBColorSpace/);
  assert.match(viewerSource, /renderer\.toneMapping = THREE\.ACESFilmicToneMapping/);
  assert.match(viewerSource, /scene\.background = new THREE\.Color\(0xf1f1ef\)/);
  assert.match(viewerSource, /new THREE\.HemisphereLight/);
  assert.equal(viewerSource.match(/new THREE\.DirectionalLight/g)?.length, 3);
});

test('the 3D measurement layer uses OpenSCAD space and can be hidden', () => {
  assert.match(viewerSource, /previewGroup\.add\(modelGroup, measurementGroup\)/);
  assert.match(viewerSource, /new THREE\.LineSegments\(geometry, material\)/);
  assert.match(viewerSource, /new THREE\.SpriteMaterial/);
  assert.match(viewerSource, /controls\.addEventListener\('change', refresh3dMeasurements\)/);
  assert.match(viewerSource, /perspectiveWorldUnitsPerPixel/);
  assert.match(viewerSource, /const axisNameOffset = direction\.clone\(\)\.multiplyScalar\(36\)/);
  assert.match(viewerSource, /addScaledVector\(LABEL_OFFSETS\[axis\], 32\)/);
  assert.match(extensionSource, /id="axes3d"/);
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
  assert.match(viewerSource, /!\/\^ERROR:\/mi\.test\(stderr\)/);
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
  assert.match(viewerSource, /mayContainMixedGeometry\(code\)/);
  assert.match(viewerSource, /function runHybridPreview\(/);
  assert.match(viewerSource, /splitCsgForPreview\(/);
  assert.match(viewerSource, /wrap2dForPreview\(/);
  assert.match(viewerSource, /function showHybrid\(/);
  assert.match(viewerSource, /Hybrid 2D \+ 3D/);
});

test('evaluated OpenSCAD colors become per-part Three.js materials', () => {
  assert.match(viewerSource, /mayContainColor\(code\)/);
  assert.match(viewerSource, /splitCsgForPreview\(/);
  assert.match(viewerSource, /function materialForPart\(/);
  assert.match(viewerSource, /material\.color\.setRGB\(r, g, b, THREE\.SRGBColorSpace\)/);
  assert.match(viewerSource, /material\.opacity = opacity/);
  assert.match(viewerSource, /material\.depthWrite = opacity >= 1/);
});
