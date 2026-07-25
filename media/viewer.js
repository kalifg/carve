// @ts-nocheck
// Carve webview viewer: drives the OpenSCAD WASM module + Three.js mesh viewer.
// Loaded from media/viewer.js inside a VS Code Webview.

import OpenSCAD from 'openscad';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// Keep the preview-format selection in this entry module. VS Code webviews
// resolve the import map before executing any module code, so an unresolved
// helper import prevents even the WASM error handler from running.
const PREVIEW_3D_FORMAT = 'binstl';
const PREVIEW_2D_FORMAT = 'svg';

function fallbackPreviewFormat(format, stderr) {
  if (format === PREVIEW_3D_FORMAT && /not a 3D object/i.test(stderr)) {
    return PREVIEW_2D_FORMAT;
  }
  if (format === PREVIEW_2D_FORMAT && /not a 2D object/i.test(stderr)) {
    return PREVIEW_3D_FORMAT;
  }
  return undefined;
}

const vscode = acquireVsCodeApi();
const $status = document.getElementById('status');
const canvas = document.getElementById('viewer');
const viewer2d = document.getElementById('viewer2d');
const svgPreview = document.getElementById('svgPreview');

const setStatus = (text, isError = false) => {
  $status.textContent = text;
  $status.classList.toggle('error', !!isError);
};

function captureOutput(Module) {
  const out = [];
  const err = [];
  Module.print = (s) => out.push(s);
  Module.printErr = (s) => err.push(s);
  return {
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    reset: () => { out.length = 0; err.length = 0; }
  };
}

setStatus('Loading openscad.wasm\u2026');
let wasmBinary;
let capture;
let Module; // current instance, replaced per render
try {
  const wasmUrl = new URL(import.meta.resolve('openscad-wasm'));
  wasmBinary = await fetch(wasmUrl).then((r) => r.arrayBuffer());
  // Eager-instantiate once so the first render is fast.
  Module = await OpenSCAD({
    noInitialRun: true,
    noExitRuntime: true,
    wasmBinary,
    locateFile: () => wasmUrl.toString()
  });
  capture = captureOutput(Module);
  setStatus('Ready.');
  vscode.postMessage({ type: 'ready' });
} catch (e) {
  setStatus('Failed to load OpenSCAD WASM: ' + e.message, true);
  vscode.postMessage({ type: 'rendered', success: false, stderr: String(e) });
  throw e;
}

async function freshModule() {
  const wasmUrl = new URL(import.meta.resolve('openscad-wasm'));
  const M = await OpenSCAD({
    noInitialRun: true,
    noExitRuntime: true,
    wasmBinary,
    locateFile: () => wasmUrl.toString()
  });
  capture = captureOutput(M);
  return M;
}

// --- Three.js scene -------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a3a);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
camera.position.set(80, 80, 80);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(1, 1, 1);
scene.add(dir);
scene.add(new THREE.GridHelper(100, 10, 0x444466, 0x333344));

let mesh = null;
let svgObjectUrl = null;
const material = new THREE.MeshStandardMaterial({
  color: 0xf9b233, metalness: 0.1, roughness: 0.6, flatShading: true
});

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
function loop() {
  requestAnimationFrame(loop);
  resize();
  controls.update();
  renderer.render(scene, camera);
}
loop();

// --- Render pipeline ------------------------------------------------------
let pending = 0;
let moduleUsed = false; // true once we've called callMain on `Module`
async function runOpenscad(code, format) {
  // OpenSCAD's main() leaves C++ static state behind that prevents a clean
  // second call. Re-instantiate the module between renders.
  if (moduleUsed) {
    Module = await freshModule();
  }
  moduleUsed = true;
  capture.reset();
  try { Module.FS.writeFile('/in.scad', code); } catch (e) {
    return { success: false, stderr: 'FS.writeFile failed: ' + e.message };
  }
  let rc;
  try {
    rc = Module.callMain(['/in.scad', '-o', '/out', '--export-format=' + format]);
  } catch (e) {
    return { success: false, stderr: capture.stderr() || String(e) };
  }
  if (rc !== 0 && rc !== undefined) {
    return { success: false, stderr: capture.stderr() || `OpenSCAD exited ${rc}` };
  }
  let data;
  try { data = Module.FS.readFile('/out'); } catch (e) {
    return { success: false, stderr: capture.stderr() || 'No output produced' };
  }
  return { success: true, data, stderr: capture.stderr() };
}

let preferredPreviewFormat = PREVIEW_3D_FORMAT;
async function runPreview(code) {
  const format = preferredPreviewFormat;
  const result = await runOpenscad(code, format);
  if (result.success) return { ...result, format };

  const fallbackFormat = fallbackPreviewFormat(format, result.stderr);
  if (!fallbackFormat) return { ...result, format };

  const fallbackResult = await runOpenscad(code, fallbackFormat);
  if (fallbackResult.success) preferredPreviewFormat = fallbackFormat;
  return { ...fallbackResult, format: fallbackFormat };
}

function show3d(stl) {
  viewer2d.hidden = true;
  canvas.hidden = false;

  const geom = new STLLoader().parse(
    stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength)
  );
  geom.computeVertexNormals();
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
  mesh = new THREE.Mesh(geom, material);
  mesh.rotation.x = -Math.PI / 2; // OpenSCAD Z-up -> Three.js Y-up
  scene.add(mesh);
  geom.computeBoundingSphere();
  const r = Math.max(20, geom.boundingSphere.radius);
  camera.position.set(r * 2, r * 2, r * 2);
  controls.target.set(0, 0, 0);
  controls.update();
  return geom.attributes.position.count / 3;
}

function show2d(svg) {
  canvas.hidden = true;
  viewer2d.hidden = false;

  if (svgObjectUrl) URL.revokeObjectURL(svgObjectUrl);
  svgObjectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  svgPreview.src = svgObjectUrl;
}

async function renderToScene(code) {
  const myId = ++pending;
  const t0 = performance.now();
  setStatus('Rendering\u2026');
  const result = await runPreview(code);
  if (myId !== pending) return; // superseded
  const ms = (performance.now() - t0).toFixed(0);
  if (!result.success) {
    setStatus(`Error (${ms} ms)`, true);
    vscode.postMessage({ type: 'rendered', success: false, stderr: result.stderr });
    return;
  }
  try {
    if (result.format === PREVIEW_2D_FORMAT) {
      show2d(result.data);
      setStatus(`OK \u00b7 ${ms} ms \u00b7 2D SVG \u00b7 ${result.data.byteLength.toLocaleString()} B`);
    } else {
      const tris = show3d(result.data);
      setStatus(`OK \u00b7 ${ms} ms \u00b7 3D \u00b7 ${tris.toLocaleString()} triangles \u00b7 ${result.data.byteLength.toLocaleString()} B`);
    }
    vscode.postMessage({ type: 'rendered', success: true, stderr: result.stderr });
  } catch (e) {
    setStatus('Preview failed: ' + e.message, true);
    vscode.postMessage({ type: 'rendered', success: false, stderr: String(e) });
  }
}

async function doExport(code, format) {
  setStatus('Exporting (' + format + ')\u2026');
  const result = await runOpenscad(code, format);
  if (!result.success) {
    vscode.postMessage({ type: 'exportResult', success: false, error: result.stderr });
    setStatus('Export failed', true);
    return;
  }
  // base64-encode binary for postMessage
  let bin = '';
  const bytes = result.data;
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const b64 = btoa(bin);
  vscode.postMessage({ type: 'exportResult', success: true, data: b64 });
  setStatus('Export ready (' + result.data.length + ' B)');
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg?.type === 'render') renderToScene(msg.code);
  else if (msg?.type === 'export') doExport(msg.code, msg.format || 'binstl');
});

// Tell host we're ready (in case the initial 'ready' was sent before this listener registered).
vscode.postMessage({ type: 'ready' });
