// Utilities for turning OpenSCAD's normalized CSG export into independent
// top-level preview branches. Kept browser-independent for direct unit tests.

export function mayContainMixedGeometry(source) {
  const code = stripCommentsAndStrings(source);
  const has2d = /\b(?:circle|square|polygon|text|offset|projection)\s*\(/.test(code);
  const has3d = /\b(?:cube|sphere|cylinder|polyhedron|linear_extrude|rotate_extrude|surface)\s*\(/.test(code);
  const hasDimensionDependentImport = /\bimport\s*\(/.test(code);
  return (has2d || hasDimensionDependentImport) && (has3d || hasDimensionDependentImport);
}

function stripCommentsAndStrings(source) {
  let result = '';
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        result += '\n';
      }
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
    } else if (char === '/' && next === '*') {
      blockComment = true;
      index++;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else {
      result += char;
    }
  }
  return result;
}

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
  return wrap2dBranch(root.trim(), thickness);
}

function wrap2dBranch(root, thickness) {
  const wrapper = peelTransparentWrapper(root);
  if (wrapper) {
    const children = splitTopLevelCsg(wrapper.body);
    const wrappedChildren = children
      .map((child) => wrap2dBranch(child, thickness))
      .join('\n');
    return `${wrapper.header}\n${wrappedChildren}\n}`;
  }
  return `linear_extrude(height = ${thickness}, center = false, convexity = 10) {\n${root}\n}`;
}

function peelTransparentWrapper(root) {
  const match = root.match(/^([#%!*]\s*)?(multmatrix|color|group)\s*\(/);
  if (!match) return undefined;

  let quote = null;
  let escaped = false;
  let parenDepth = 0;
  let openingBrace = -1;
  for (let index = 0; index < root.length; index++) {
    const char = root[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') parenDepth++;
    else if (char === ')') parenDepth--;
    else if (char === '{' && parenDepth === 0) {
      openingBrace = index;
      break;
    }
  }
  if (openingBrace < 0) return undefined;

  let braceDepth = 0;
  quote = null;
  escaped = false;
  for (let index = openingBrace; index < root.length; index++) {
    const char = root[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') braceDepth++;
    else if (char === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        if (root.slice(index + 1).trim()) return undefined;
        return {
          header: root.slice(0, openingBrace + 1).trimEnd(),
          body: root.slice(openingBrace + 1, index)
        };
      }
    }
  }
  return undefined;
}
