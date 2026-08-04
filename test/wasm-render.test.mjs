import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { splitTopLevelCsg, wrap2dForPreview } from '../media/csg-preview.mjs';

const mediaUrl = new URL('../media/', import.meta.url);
const loaderSource = await readFile(new URL('openscad.js', mediaUrl), 'utf8');
const wasmBinary = await readFile(new URL('openscad.wasm', mediaUrl));
const loaderUrl = `data:text/javascript;base64,${Buffer.from(loaderSource).toString('base64')}`;
const { default: OpenSCAD } = await import(loaderUrl);

async function render(code, format) {
  const stderr = [];
  const instance = await OpenSCAD({
    noInitialRun: true,
    noExitRuntime: true,
    wasmBinary,
    locateFile: () => new URL('openscad.wasm', mediaUrl).href,
    print: () => {},
    printErr: (line) => stderr.push(line)
  });

  instance.FS.writeFile('/input.scad', code);
  let rc;
  try {
    rc = instance.callMain([
      '/input.scad',
      '-o',
      '/output',
      `--export-format=${format}`
    ]);
  } catch (error) {
    return { success: false, stderr: stderr.join('\n') || String(error) };
  }

  if (rc !== 0 && rc !== undefined) {
    return { success: false, stderr: stderr.join('\n') };
  }

  return {
    success: true,
    data: instance.FS.readFile('/output'),
    stderr: stderr.join('\n')
  };
}

test('bundled OpenSCAD WASM exports 2D geometry as SVG', async () => {
  const result = await render('difference() { circle(25); circle(12.5); }', 'svg');

  assert.equal(result.success, true, result.stderr);
  assert.match(new TextDecoder().decode(result.data), /<svg\b/);
});

test('bundled OpenSCAD WASM reports a dimensional mismatch for 2D STL', async () => {
  const result = await render('circle(10);', 'binstl');

  assert.equal(result.success, false);
  assert.match(result.stderr, /not a 3D object/i);
});

test('bundled OpenSCAD WASM reports an empty top-level object', async () => {
  const result = await render('module part() { cube(10); }', 'binstl');

  assert.equal(result.success, false);
  assert.match(result.stderr, /Current top level object is empty/i);
});

test('bundled OpenSCAD WASM warns and drops geometry when dimensions are mixed', async () => {
  const code = 'circle(10); translate([30, 0, 0]) cube(10);';
  const stlResult = await render(code, 'binstl');
  const svgResult = await render(code, 'svg');

  assert.equal(stlResult.success, false);
  assert.match(stlResult.stderr, /Mixing 2D and 3D objects is not supported/i);
  assert.match(stlResult.stderr, /not a 3D object/i);
  assert.equal(svgResult.success, true, svgResult.stderr);
  assert.match(svgResult.stderr, /Mixing 2D and 3D objects is not supported/i);
  assert.match(new TextDecoder().decode(svgResult.data), /<svg\b/);
});

test('bundled OpenSCAD WASM can isolate and preview independent mixed roots', async () => {
  const code = `
    module profile() { difference() { circle(10); circle(5); } }
    translate([-20, 0]) profile();
    translate([20, 0, 0]) linear_extrude(8) profile();
  `;
  const csgResult = await render(code, 'csg');

  assert.equal(csgResult.success, true, csgResult.stderr);
  const roots = splitTopLevelCsg(new TextDecoder().decode(csgResult.data));
  assert.equal(roots.length, 2);

  const flatProbe = await render(roots[0], 'binstl');
  const solidResult = await render(roots[1], 'binstl');
  assert.equal(flatProbe.success, false);
  assert.match(flatProbe.stderr, /not a 3D object/i);
  assert.equal(solidResult.success, true, solidResult.stderr);

  const flatResult = await render(wrap2dForPreview(roots[0]), 'binstl');
  assert.equal(flatResult.success, true, flatResult.stderr);
  assert.ok(flatResult.data.byteLength > 84);
});

test('bundled OpenSCAD WASM still exports 3D geometry as binary STL', async () => {
  const result = await render('cube(10);', 'binstl');

  assert.equal(result.success, true, result.stderr);
  assert.ok(result.data.byteLength > 84);
});
