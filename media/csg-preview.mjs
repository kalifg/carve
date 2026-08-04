// Utilities for turning OpenSCAD's normalized CSG export into independent
// top-level preview branches. Kept browser-independent for direct unit tests.

export function splitTopLevelCsg(source) {
  const roots = [];
  let start = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  const pushRoot = (end) => {
    const root = source.slice(start, end).trim();
    if (root) roots.push(root);
    start = end;
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '{') braceDepth++;
    else if (char === '}') braceDepth--;
    else if (char === '(') parenDepth++;
    else if (char === ')') parenDepth--;
    else if (char === '[') bracketDepth++;
    else if (char === ']') bracketDepth--;

    if (braceDepth < 0 || parenDepth < 0 || bracketDepth < 0) {
      throw new Error('OpenSCAD produced unbalanced CSG output.');
    }

    const atTopLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
    if (atTopLevel && (char === ';' || char === '}')) pushRoot(index + 1);
  }

  if (quote || blockComment || braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0) {
    throw new Error('OpenSCAD produced incomplete CSG output.');
  }

  const trailing = source.slice(start).trim();
  if (trailing) roots.push(trailing);
  return roots;
}

export function wrap2dForPreview(root, thickness = 0.01) {
  if (!root.trim()) throw new Error('Cannot preview an empty CSG branch.');
  if (!Number.isFinite(thickness) || thickness <= 0) {
    throw new Error('The 2D preview thickness must be positive.');
  }
  return `linear_extrude(height = ${thickness}, center = false, convexity = 10) {\n${root}\n}`;
}
