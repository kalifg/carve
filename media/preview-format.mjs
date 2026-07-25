export const PREVIEW_3D_FORMAT = 'binstl';
export const PREVIEW_2D_FORMAT = 'svg';

/**
 * Return the alternate preview format only when OpenSCAD successfully
 * evaluated the model but rejected the requested output dimensionality.
 */
export function fallbackPreviewFormat(format, stderr) {
  if (format === PREVIEW_3D_FORMAT && /not a 3D object/i.test(stderr)) {
    return PREVIEW_2D_FORMAT;
  }
  if (format === PREVIEW_2D_FORMAT && /not a 2D object/i.test(stderr)) {
    return PREVIEW_3D_FORMAT;
  }
  return undefined;
}
