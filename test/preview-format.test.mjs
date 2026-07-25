import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREVIEW_2D_FORMAT,
  PREVIEW_3D_FORMAT,
  fallbackPreviewFormat
} from '../media/preview-format.mjs';

test('falls back to SVG when OpenSCAD rejects a 2D model as STL', () => {
  assert.equal(
    fallbackPreviewFormat(
      PREVIEW_3D_FORMAT,
      'Current top level object is not a 3D object.'
    ),
    PREVIEW_2D_FORMAT
  );
});

test('falls back to STL when a previously 2D model becomes 3D', () => {
  assert.equal(
    fallbackPreviewFormat(
      PREVIEW_2D_FORMAT,
      'Current top level object is not a 2D object.'
    ),
    PREVIEW_3D_FORMAT
  );
});

test('does not hide parser or other render errors behind a fallback', () => {
  assert.equal(
    fallbackPreviewFormat(
      PREVIEW_3D_FORMAT,
      'ERROR: Parser error in file /in.scad, line 2: syntax error'
    ),
    undefined
  );
});
