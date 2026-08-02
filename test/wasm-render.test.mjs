import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

test('bundled OpenSCAD WASM still exports 3D geometry as binary STL', async () => {
  const result = await render('cube(10);', 'binstl');

  assert.equal(result.success, true, result.stderr);
  assert.ok(result.data.byteLength > 84);
});
