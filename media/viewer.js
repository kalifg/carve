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

function cleanStderr(stderr) {
  return String(stderr ?? '')
    .split('\n')
    .filter((line) => !/Could not initialize localization\s+\(application path is ['"]\/['"]\)\.?/i.test(line))
    .join('\n')
    .trim();
}

function isEmptyTopLevel(stderr) {
  return /Current top level object is empty/i.test(stderr);
}

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
const emptyPreview = document.getElementById('emptyPreview');
const viewer2dGrid = document.getElementById('viewer2dGrid');
const svgPreview = document.getElementById('svgPreview');
const fit2dButton = document.getElementById('fit2d');

const setStatus = (text, isError = false) => {
  $status.textContent = text;
  $status.classList.toggle('error', !!isError);
};

function createOutputCapture() {
  const out = [];
  const err = [];
  return {
    print: (s) => out.push(s),
    printErr: (s) => err.push(s),
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
  capture = createOutputCapture();
  // Eager-instantiate once so the first render is fast.
  Module = await OpenSCAD({
    noInitialRun: true,
    noExitRuntime: true,
    wasmBinary,
    locateFile: () => wasmUrl.toString(),
    print: capture.print,
    printErr: capture.printErr
  });
  setStatus('Ready.');
  vscode.postMessage({ type: 'ready' });
} catch (e) {
  setStatus('Failed to load OpenSCAD WASM: ' + e.message, true);
  vscode.postMessage({ type: 'rendered', success: false, stderr: String(e) });
  throw e;
}

async function freshModule() {
  const wasmUrl = new URL(import.meta.resolve('openscad-wasm'));
  capture = createOutputCapture();
  const M = await OpenSCAD({
    noInitialRun: true,
    noExitRuntime: true,
    wasmBinary,
    locateFile: () => wasmUrl.toString(),
    print: capture.print,
    printErr: capture.printErr
  });
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
let svgBounds = null;
let view2dScale = 1;
let view2dOffsetX = 0;
let view2dOffsetY = 0;
let view2dIsFitted = true;
let view2dWidth = 0;
let view2dHeight = 0;
const material = new THREE.MeshStandardMaterial({
  color: 0xf9b233, metalness: 0.1, roughness: 0.6, flatShading: true
});

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize2d();
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
    return { success: false, stderr: cleanStderr(capture.stderr()) || String(e) };
  }
  if (rc !== 0 && rc !== undefined) {
    return { success: false, stderr: cleanStderr(capture.stderr()) || `OpenSCAD exited ${rc}` };
  }
  let data;
  try { data = Module.FS.readFile('/out'); } catch (e) {
    return { success: false, stderr: cleanStderr(capture.stderr()) || 'No output produced' };
  }
  return { success: true, data, stderr: cleanStderr(capture.stderr()) };
}

let preferredPreviewFormat = PREVIEW_3D_FORMAT;
async function runPreview(code) {
  const format = preferredPreviewFormat;
  const result = await runOpenscad(code, format);
  if (result.success) return { ...result, format };
  if (isEmptyTopLevel(result.stderr)) {
    return { ...result, success: true, empty: true, stderr: '', format };
  }

  const fallbackFormat = fallbackPreviewFormat(format, result.stderr);
  if (!fallbackFormat) return { ...result, format };

  const fallbackResult = await runOpenscad(code, fallbackFormat);
  if (isEmptyTopLevel(fallbackResult.stderr)) {
    return { ...fallbackResult, success: true, empty: true, stderr: '', format: fallbackFormat };
  }
  if (fallbackResult.success) preferredPreviewFormat = fallbackFormat;
  return { ...fallbackResult, format: fallbackFormat };
}

function clear3dPreview() {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh = null;
}

function clear2dPreview() {
  if (svgObjectUrl) URL.revokeObjectURL(svgObjectUrl);
  svgObjectUrl = null;
  svgBounds = null;
  svgPreview.removeAttribute('src');
  const ctx = viewer2dGrid.getContext('2d');
  ctx?.clearRect(0, 0, viewer2dGrid.width, viewer2dGrid.height);
}

function showEmpty() {
  clear3dPreview();
  clear2dPreview();
  canvas.hidden = true;
  viewer2d.hidden = true;
  emptyPreview.hidden = false;
}

function show3d(stl) {
  emptyPreview.hidden = true;
  viewer2d.hidden = true;
  canvas.hidden = false;
  clear2dPreview();

  const geom = new STLLoader().parse(
    stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength)
  );
  geom.computeVertexNormals();
  clear3dPreview();
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

function parseSvgBounds(svg) {
  const source = new TextDecoder().decode(svg);
  const match = source.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (!match) throw new Error('OpenSCAD SVG has no viewBox.');
  const values = match[1].trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) ||
      values[2] <= 0 || values[3] <= 0) {
    throw new Error('OpenSCAD SVG has an invalid viewBox.');
  }
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function gridStepForScale(scale) {
  const targetModelUnits = 64 / scale;
  const power = 10 ** Math.floor(Math.log10(targetModelUnits));
  const normalized = targetModelUnits / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

function formatAxisValue(value, step) {
  const normalized = Math.abs(value) < step * 1e-6 ? 0 : value;
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));
  const fixed = normalized.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function draw2dGrid() {
  if (!svgBounds || viewer2d.hidden || view2dWidth === 0 || view2dHeight === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(view2dWidth * dpr);
  const pixelHeight = Math.round(view2dHeight * dpr);
  if (viewer2dGrid.width !== pixelWidth || viewer2dGrid.height !== pixelHeight) {
    viewer2dGrid.width = pixelWidth;
    viewer2dGrid.height = pixelHeight;
  }

  const ctx = viewer2dGrid.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view2dWidth, view2dHeight);

  const step = gridStepForScale(view2dScale);
  const minX = -view2dOffsetX / view2dScale;
  const maxX = (view2dWidth - view2dOffsetX) / view2dScale;
  const minSvgY = -view2dOffsetY / view2dScale;
  const maxSvgY = (view2dHeight - view2dOffsetY) / view2dScale;

  ctx.beginPath();
  ctx.strokeStyle = '#dfdfdf';
  ctx.lineWidth = 1;
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
    const screenX = view2dOffsetX + x * view2dScale;
    ctx.moveTo(screenX, 0);
    ctx.lineTo(screenX, view2dHeight);
  }
  for (let y = Math.ceil(minSvgY / step) * step; y <= maxSvgY; y += step) {
    const screenY = view2dOffsetY + y * view2dScale;
    ctx.moveTo(0, screenY);
    ctx.lineTo(view2dWidth, screenY);
  }
  ctx.stroke();

  const originX = view2dOffsetX;
  const originY = view2dOffsetY;
  const zeroTolerance = step * 1e-6;
  ctx.font = '11px sans-serif';

  if (originY >= 0 && originY <= view2dHeight) {
    ctx.beginPath();
    ctx.strokeStyle = '#d64545';
    ctx.lineWidth = 1.5;
    ctx.moveTo(0, originY);
    ctx.lineTo(view2dWidth, originY);
    ctx.moveTo(view2dWidth - 7, originY - 4);
    ctx.lineTo(view2dWidth, originY);
    ctx.lineTo(view2dWidth - 7, originY + 4);
    const firstXTick = Math.ceil(minX / step);
    const lastXTick = Math.floor(maxX / step);
    for (let tick = firstXTick; tick <= lastXTick; tick++) {
      const value = tick * step;
      if (Math.abs(value) < zeroTolerance) continue;
      const screenX = view2dOffsetX + value * view2dScale;
      ctx.moveTo(screenX, originY - 4);
      ctx.lineTo(screenX, originY + 4);
    }
    ctx.stroke();

    ctx.fillStyle = '#b52d2d';
    ctx.textAlign = 'center';
    const labelsBelow = originY <= view2dHeight - 22;
    ctx.textBaseline = labelsBelow ? 'top' : 'bottom';
    const labelY = originY + (labelsBelow ? 6 : -6);
    for (let tick = firstXTick; tick <= lastXTick; tick++) {
      const value = tick * step;
      if (Math.abs(value) < zeroTolerance) continue;
      const screenX = view2dOffsetX + value * view2dScale;
      const label = formatAxisValue(value, step);
      const halfWidth = ctx.measureText(label).width / 2;
      if (screenX > halfWidth + 2 && screenX < view2dWidth - halfWidth - 26) {
        ctx.fillText(label, screenX, labelY);
      }
    }
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('X', view2dWidth - 9, labelY);
    ctx.font = '11px sans-serif';
  }
  if (originX >= 0 && originX <= view2dWidth) {
    ctx.beginPath();
    ctx.strokeStyle = '#36a269';
    ctx.lineWidth = 1.5;
    ctx.moveTo(originX, 0);
    ctx.lineTo(originX, view2dHeight);
    ctx.moveTo(originX - 4, 7);
    ctx.lineTo(originX, 0);
    ctx.lineTo(originX + 4, 7);
    const firstYTick = Math.ceil(minSvgY / step);
    const lastYTick = Math.floor(maxSvgY / step);
    for (let tick = firstYTick; tick <= lastYTick; tick++) {
      const svgValue = tick * step;
      if (Math.abs(svgValue) < zeroTolerance) continue;
      const screenY = view2dOffsetY + svgValue * view2dScale;
      ctx.moveTo(originX - 4, screenY);
      ctx.lineTo(originX + 4, screenY);
    }
    ctx.stroke();

    ctx.fillStyle = '#25784d';
    const labelsRight = originX <= view2dWidth - 46;
    ctx.textAlign = labelsRight ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    const labelX = originX + (labelsRight ? 7 : -7);
    for (let tick = firstYTick; tick <= lastYTick; tick++) {
      const svgValue = tick * step;
      if (Math.abs(svgValue) < zeroTolerance) continue;
      const screenY = view2dOffsetY + svgValue * view2dScale;
      if (screenY > 24 && screenY < view2dHeight - 9) {
        // SVG's screen Y direction is opposite OpenSCAD's model Y direction.
        ctx.fillText(formatAxisValue(-svgValue, step), labelX, screenY);
      }
    }
    ctx.font = 'bold 12px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Y', labelX, 9);
    ctx.font = '11px sans-serif';
  }
  if (originX >= 0 && originX <= view2dWidth && originY >= 0 && originY <= view2dHeight) {
    ctx.fillStyle = '#555';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('0', originX + 6, originY + 6);
  }
}

function update2dTransform() {
  if (!svgBounds) return;
  svgPreview.style.width = `${svgBounds.width}px`;
  svgPreview.style.height = `${svgBounds.height}px`;
  const imageX = view2dOffsetX + svgBounds.x * view2dScale;
  const imageY = view2dOffsetY + svgBounds.y * view2dScale;
  svgPreview.style.transform = `translate(${imageX}px, ${imageY}px) scale(${view2dScale})`;
  draw2dGrid();
}

function fit2d() {
  if (!svgBounds) return;
  const width = viewer2d.clientWidth;
  const height = viewer2d.clientHeight;
  if (width === 0 || height === 0) return;
  const padding = Math.max(32, Math.min(width, height) * 0.07);
  view2dScale = Math.min(
    (width - padding * 2) / svgBounds.width,
    (height - padding * 2) / svgBounds.height
  );
  view2dOffsetX = (width - svgBounds.width * view2dScale) / 2 - svgBounds.x * view2dScale;
  view2dOffsetY = (height - svgBounds.height * view2dScale) / 2 - svgBounds.y * view2dScale;
  view2dIsFitted = true;
  update2dTransform();
}

function resize2d() {
  if (viewer2d.hidden) return;
  const width = viewer2d.clientWidth;
  const height = viewer2d.clientHeight;
  if (width === 0 || height === 0 || (width === view2dWidth && height === view2dHeight)) return;
  view2dWidth = width;
  view2dHeight = height;
  if (view2dIsFitted) fit2d();
  else update2dTransform();
}

viewer2d.addEventListener('wheel', (event) => {
  if (!svgBounds) return;
  event.preventDefault();
  const rect = viewer2d.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const modelX = (pointerX - view2dOffsetX) / view2dScale;
  const modelY = (pointerY - view2dOffsetY) / view2dScale;
  const zoomFactor = Math.exp(-event.deltaY * 0.0015);
  const newScale = Math.min(500, Math.max(0.02, view2dScale * zoomFactor));
  view2dOffsetX = pointerX - modelX * newScale;
  view2dOffsetY = pointerY - modelY * newScale;
  view2dScale = newScale;
  view2dIsFitted = false;
  update2dTransform();
}, { passive: false });

let pan2dPointerId = null;
let pan2dX = 0;
let pan2dY = 0;
viewer2d.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target === fit2dButton) return;
  pan2dPointerId = event.pointerId;
  pan2dX = event.clientX;
  pan2dY = event.clientY;
  viewer2d.setPointerCapture(event.pointerId);
  viewer2d.classList.add('panning');
});
viewer2d.addEventListener('pointermove', (event) => {
  if (event.pointerId !== pan2dPointerId) return;
  view2dOffsetX += event.clientX - pan2dX;
  view2dOffsetY += event.clientY - pan2dY;
  pan2dX = event.clientX;
  pan2dY = event.clientY;
  view2dIsFitted = false;
  update2dTransform();
});
function end2dPan(event) {
  if (event.pointerId !== pan2dPointerId) return;
  pan2dPointerId = null;
  viewer2d.classList.remove('panning');
}
viewer2d.addEventListener('pointerup', end2dPan);
viewer2d.addEventListener('pointercancel', end2dPan);
viewer2d.addEventListener('dblclick', fit2d);
fit2dButton.addEventListener('click', fit2d);

function show2d(svg) {
  emptyPreview.hidden = true;
  canvas.hidden = true;
  viewer2d.hidden = false;
  clear3dPreview();

  svgBounds = parseSvgBounds(svg);
  if (svgObjectUrl) URL.revokeObjectURL(svgObjectUrl);
  svgObjectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  svgPreview.src = svgObjectUrl;
  view2dWidth = viewer2d.clientWidth;
  view2dHeight = viewer2d.clientHeight;
  requestAnimationFrame(fit2d);
}

async function renderToScene(code) {
  const myId = ++pending;
  const t0 = performance.now();
  setStatus('Rendering\u2026');
  const result = await runPreview(code);
  if (myId !== pending) return; // superseded
  const ms = (performance.now() - t0).toFixed(0);
  if (!result.success) {
    setStatus(`Error (${ms} ms)\n${result.stderr || 'OpenSCAD produced no diagnostic output.'}`, true);
    vscode.postMessage({ type: 'rendered', success: false, stderr: result.stderr });
    return;
  }
  try {
    if (result.empty) {
      showEmpty();
      setStatus(`Empty \u00b7 ${ms} ms \u00b7 no top-level geometry`);
    } else if (result.format === PREVIEW_2D_FORMAT) {
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
