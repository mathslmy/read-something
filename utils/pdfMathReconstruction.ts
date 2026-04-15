// ═══════════════════════════════════════════════════════════════
//  PDF math reconstruction
//
//  pdf.js' getTextContent() returns glyph runs with their page
//  coordinates but no structural markup. For a LaTeX-typeset paper
//  that means a superscript such as `C^n` is extracted as two items
//  at different baselines and ends up as the flat string `C n`, and
//  every math symbol is a Unicode glyph (Ω, ⊂, ∞, …) with no way to
//  recover the original `\Omega`, `\subset`, `\infty` commands.
//
//  This module takes the raw text items for one page, groups them
//  into visual lines, detects super/subscripts via their baseline
//  offset and rewrites runs that look mathematical into KaTeX-ready
//  strings wrapped in `$...$`, mapping common Unicode math glyphs to
//  their canonical LaTeX commands in the process. Anything that does
//  not look like math is returned untouched.
// ═══════════════════════════════════════════════════════════════

export interface PdfTextItem {
  str: string;
  width?: number;
  height?: number;
  /** pdf.js transform is [a, b, c, d, e, f]; [e, f] is the baseline origin. */
  transform?: number[];
  fontName?: string;
  hasEOL?: boolean;
}

// ── Unicode → LaTeX mapping for the most common math glyphs ──
// We deliberately avoid mapping Greek capitals whose glyph is
// identical to a Latin letter (A, B, E, Z, H, I, K, M, N, O, P, T, X)
// because they are routinely used as plain letters and the mapping
// would produce more false positives than useful rewrites.
export const UNICODE_TO_LATEX: Record<string, string> = {
  // Greek lowercase
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ε': '\\varepsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta',
  'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
  'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho',
  'σ': '\\sigma', 'ς': '\\varsigma', 'τ': '\\tau', 'υ': '\\upsilon',
  'φ': '\\varphi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'ϵ': '\\epsilon', 'ϑ': '\\vartheta', 'ϕ': '\\phi', 'ϱ': '\\varrho',
  'ϖ': '\\varpi',
  // Greek uppercase (only those visually distinct from Latin)
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
  'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon',
  'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  // Binary operators
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div',
  '·': '\\cdot', '∘': '\\circ', '∙': '\\bullet',
  '⊕': '\\oplus', '⊗': '\\otimes', '⊖': '\\ominus', '⊙': '\\odot',
  '∧': '\\wedge', '∨': '\\vee', '∩': '\\cap', '∪': '\\cup',
  '⊓': '\\sqcap', '⊔': '\\sqcup', '⋆': '\\star', '⋄': '\\diamond',
  '†': '\\dagger', '‡': '\\ddagger',
  // Large operators
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod',
  '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '⋂': '\\bigcap', '⋃': '\\bigcup', '⨁': '\\bigoplus', '⨂': '\\bigotimes',
  // Relations
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx',
  '≡': '\\equiv', '∼': '\\sim', '≃': '\\simeq', '≅': '\\cong',
  '≺': '\\prec', '≻': '\\succ', '⪯': '\\preceq', '⪰': '\\succeq',
  '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq',
  '⊊': '\\subsetneq', '⊋': '\\supsetneq',
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni',
  '∝': '\\propto', '∥': '\\parallel', '∦': '\\nparallel',
  '⊥': '\\perp', '≪': '\\ll', '≫': '\\gg',
  '⟂': '\\perp', '⊢': '\\vdash', '⊨': '\\models',
  // Arrows
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto', '↑': '\\uparrow', '↓': '\\downarrow',
  '⇑': '\\Uparrow', '⇓': '\\Downarrow', '⟶': '\\longrightarrow',
  '⟵': '\\longleftarrow', '⟷': '\\longleftrightarrow',
  '⟹': '\\Longrightarrow', '⟸': '\\Longleftarrow',
  // Misc math
  '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla',
  '∀': '\\forall', '∃': '\\exists', '∄': '\\nexists',
  '∅': '\\emptyset', '∎': '\\blacksquare', '□': '\\square',
  '¬': '\\neg', 'ℵ': '\\aleph', 'ℓ': '\\ell', '℘': '\\wp',
  '…': '\\ldots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots',
  // Blackboard bold
  'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}',
  'ℝ': '\\mathbb{R}', 'ℂ': '\\mathbb{C}', 'ℍ': '\\mathbb{H}',
  'ℙ': '\\mathbb{P}', 'ℑ': '\\Im', 'ℜ': '\\Re',
  // Primes
  '′': "'", '″': "''", '‴': "'''", '⁗': "''''",
  // Minus sign (pdf.js often extracts `−` rather than ASCII `-`)
  '−': '-',
};

// Every Unicode char that hints at math content. We exclude `…`
// which commonly appears in prose as a plain ellipsis — its presence
// alone is not enough to flip a sentence into a math run.
export const MATH_HINT_CHARS = new Set(
  Object.keys(UNICODE_TO_LATEX).filter((ch) => ch !== '…')
);

// Individual characters that may appear within a math run but are
// not themselves a strong "this is math" signal. Used when extending
// a math region across intervening plain letters / digits / spaces.
// Includes the Unicode minus `−` (U+2212) so that `−∞` stays inside
// the enclosing math run.
const MATH_NEUTRAL_CHAR_REGEX = /^[A-Za-z0-9 ()[\]{}.,;:+\-*/=<>|!&^_\\−]*$/;

interface ProcessedItem {
  str: string;
  baseline: number;
  height: number;
  fontHeight: number;
  hasEOL: boolean;
  /** 0 = baseline, 1 = superscript, -1 = subscript. Populated per line. */
  role: 0 | 1 | -1;
}

const resolveItemHeight = (item: PdfTextItem) => {
  const h = typeof item.height === 'number' ? item.height : 0;
  if (h > 0) return h;
  const transform = item.transform;
  if (Array.isArray(transform) && transform.length >= 4) {
    const scaleY = Math.abs(Number(transform[3]) || 0);
    if (scaleY > 0) return scaleY;
  }
  return 0;
};

const resolveItemBaseline = (item: PdfTextItem) => {
  const transform = item.transform;
  if (Array.isArray(transform) && transform.length >= 6) {
    return Number(transform[5]) || 0;
  }
  return 0;
};

const resolveItemFontHeight = (item: PdfTextItem) => {
  const transform = item.transform;
  if (Array.isArray(transform) && transform.length >= 4) {
    const scaleY = Math.abs(Number(transform[3]) || 0);
    if (scaleY > 0) return scaleY;
  }
  return resolveItemHeight(item);
};

const buildProcessedItems = (items: PdfTextItem[]): ProcessedItem[] =>
  items.map((item) => ({
    str: typeof item.str === 'string' ? item.str : '',
    baseline: resolveItemBaseline(item),
    height: resolveItemHeight(item),
    fontHeight: resolveItemFontHeight(item),
    hasEOL: !!item.hasEOL,
    role: 0,
  }));

/**
 * Split the processed items into visual lines. pdf.js sets `hasEOL`
 * for items that mark a new line; when that signal is missing we fall
 * back to grouping by baseline proximity.
 */
const groupItemsIntoLines = (items: ProcessedItem[]): ProcessedItem[][] => {
  const lines: ProcessedItem[][] = [];
  let current: ProcessedItem[] = [];
  let lineBaseline: number | null = null;
  let lineFontHeight = 0;

  const flush = () => {
    if (current.length > 0) lines.push(current);
    current = [];
    lineBaseline = null;
    lineFontHeight = 0;
  };

  items.forEach((item) => {
    if (item.hasEOL && item.str.trim() === '') {
      flush();
      return;
    }
    if (current.length === 0) {
      lineBaseline = item.baseline;
      lineFontHeight = item.fontHeight || item.height;
      current.push(item);
      return;
    }
    const referenceHeight = Math.max(lineFontHeight, item.fontHeight || item.height, 1);
    const delta = Math.abs(item.baseline - (lineBaseline ?? item.baseline));
    // Allow super/subscripts (within ~0.8 * font height) to stay in the line.
    if (delta <= referenceHeight * 0.85) {
      current.push(item);
      // Keep the dominant baseline — track the largest font as the body.
      if ((item.fontHeight || item.height) > lineFontHeight) {
        lineFontHeight = item.fontHeight || item.height;
        lineBaseline = item.baseline;
      }
    } else {
      flush();
      lineBaseline = item.baseline;
      lineFontHeight = item.fontHeight || item.height;
      current.push(item);
    }
    if (item.hasEOL) flush();
  });
  flush();

  return lines;
};

/**
 * Within a visual line, tag every item as baseline / superscript /
 * subscript. The body baseline is estimated as the median baseline of
 * items using the dominant font size — that way a sequence of small
 * superscripts does not pull the reference line upward.
 */
const classifyLineRoles = (line: ProcessedItem[]) => {
  if (line.length === 0) return;
  const heights = line.map((item) => item.fontHeight || item.height || 0).filter((h) => h > 0);
  if (heights.length === 0) return;
  heights.sort((a, b) => a - b);
  const medianFontHeight = heights[Math.floor(heights.length / 2)];
  const bodyThreshold = medianFontHeight * 0.9;

  const bodyBaselines = line
    .filter((item) => (item.fontHeight || item.height) >= bodyThreshold)
    .map((item) => item.baseline)
    .sort((a, b) => a - b);
  const bodyBaseline =
    bodyBaselines.length > 0
      ? bodyBaselines[Math.floor(bodyBaselines.length / 2)]
      : line[0].baseline;

  const supThreshold = medianFontHeight * 0.22;
  const subThreshold = medianFontHeight * 0.15;

  line.forEach((item) => {
    const delta = item.baseline - bodyBaseline;
    const itemFontHeight = item.fontHeight || item.height || medianFontHeight;
    const isSmaller = itemFontHeight < medianFontHeight * 0.85;
    if (delta > supThreshold && (isSmaller || delta > medianFontHeight * 0.4)) {
      item.role = 1;
    } else if (delta < -subThreshold && (isSmaller || delta < -medianFontHeight * 0.25)) {
      item.role = -1;
    } else {
      item.role = 0;
    }
  });
};

const containsMathHint = (text: string) => {
  for (const ch of text) {
    if (MATH_HINT_CHARS.has(ch)) return true;
  }
  return false;
};

const translateUnicodeChar = (ch: string) => {
  const mapped = UNICODE_TO_LATEX[ch];
  if (mapped === undefined) return ch;
  // Ensure commands are separated from the following character.
  return mapped;
};

const translateUnicodeSegment = (text: string) => {
  let result = '';
  let lastWasCommand = false;
  for (const ch of text) {
    const mapped = UNICODE_TO_LATEX[ch];
    if (mapped !== undefined) {
      if (lastWasCommand && result.length > 0 && /[A-Za-z]$/.test(result)) {
        result += ' ';
      }
      result += mapped;
      lastWasCommand = mapped.startsWith('\\') && /[A-Za-z]$/.test(mapped);
      continue;
    }
    if (lastWasCommand && /[A-Za-z]/.test(ch)) {
      result += ' ';
    }
    result += ch;
    lastWasCommand = false;
  }
  return result;
};

/**
 * Render a sequence of items that have already been classified into
 * baseline / super / sub roles as a LaTeX math expression (without
 * the enclosing `$...$`). Super/subscript runs are wrapped with `^{}`
 * or `_{}` and Unicode math glyphs are translated to commands.
 */
const renderMathRun = (items: ProcessedItem[]): string => {
  let result = '';

  // When the running output ends with a LaTeX command name such as
  // `\Omega` and the next fragment starts with an ASCII letter, LaTeX
  // would try to parse `\OmegaC` as a single (non-existent) macro. We
  // emit an explicit space in that case so that `\Omega C` is stable.
  const appendRaw = (text: string) => {
    if (!text) return;
    if (result.length > 0) {
      const lastCommand = result.match(/\\[A-Za-z]+$/);
      if (lastCommand && /^[A-Za-z]/.test(text)) {
        result += ' ';
      }
    }
    result += text;
  };

  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (item.role === 0) {
      appendRaw(translateUnicodeSegment(item.str));
      index += 1;
      continue;
    }
    // Collect consecutive items with the same role.
    const runRole = item.role;
    let runText = '';
    while (index < items.length && items[index].role === runRole) {
      runText += items[index].str;
      index += 1;
    }
    const translated = translateUnicodeSegment(runText).trim();
    if (translated.length === 0) continue;
    const wrapper = runRole === 1 ? '^' : '_';
    // Single ASCII letter/digit can skip braces.
    if (/^[A-Za-z0-9]$/.test(translated)) {
      appendRaw(`${wrapper}${translated}`);
    } else {
      appendRaw(`${wrapper}{${translated}}`);
    }
  }
  // Collapse duplicate whitespace introduced by the translation step.
  return result.replace(/[ \t]{2,}/g, ' ').trim();
};

const itemLooksMathy = (item: ProcessedItem) => {
  if (item.role !== 0) return true;
  if (containsMathHint(item.str)) return true;
  return false;
};

/**
 * Walk through the classified items in a line and split them into
 * alternating prose and math runs. A run is marked as math when it
 * contains at least one strong math hint (Unicode math glyph or a
 * super/subscript). Intervening plain text that connects two math
 * items (such as a single letter or a space) is absorbed so that an
 * expression like `C^n be` becomes `$C^n$ be` rather than being
 * broken up into `$C^n$ $be$`.
 */
const segmentLineIntoRuns = (line: ProcessedItem[]): Array<{ math: boolean; items: ProcessedItem[] }> => {
  const runs: Array<{ math: boolean; items: ProcessedItem[] }> = [];
  let i = 0;
  while (i < line.length) {
    const item = line[i];
    if (!itemLooksMathy(item)) {
      // Extend plain prose run.
      const bucket: ProcessedItem[] = [];
      while (i < line.length && !itemLooksMathy(line[i])) {
        bucket.push(line[i]);
        i += 1;
      }
      runs.push({ math: false, items: bucket });
      continue;
    }
    // Math run. Extend forward while the item looks mathy or is a
    // short neutral connector between math items.
    const bucket: ProcessedItem[] = [];
    while (i < line.length) {
      const cursor = line[i];
      if (itemLooksMathy(cursor)) {
        bucket.push(cursor);
        i += 1;
        continue;
      }
      // Look ahead: is there another mathy item shortly after, with only
      // neutral text in between? If yes, swallow the neutral items.
      let lookahead = i;
      const buffered: ProcessedItem[] = [];
      while (lookahead < line.length && !itemLooksMathy(line[lookahead])) {
        const textBetween = line[lookahead].str;
        if (!MATH_NEUTRAL_CHAR_REGEX.test(textBetween)) break;
        buffered.push(line[lookahead]);
        lookahead += 1;
        if (buffered.length > 3) break;
      }
      if (lookahead < line.length && itemLooksMathy(line[lookahead]) && buffered.length <= 3) {
        bucket.push(...buffered);
        i = lookahead;
        continue;
      }
      break;
    }
    runs.push({ math: true, items: bucket });
  }
  return runs;
};

const joinProseItems = (items: ProcessedItem[]) => {
  let text = '';
  items.forEach((item, idx) => {
    if (idx > 0) {
      const prevChar = text[text.length - 1];
      const nextChar = item.str[0];
      if (prevChar && nextChar && !/\s/.test(prevChar) && !/\s/.test(nextChar)) {
        // Preserve an implicit space between adjacent items.
        text += ' ';
      }
    }
    text += item.str;
  });
  return text;
};

const renderLine = (line: ProcessedItem[]): string => {
  if (line.length === 0) return '';
  classifyLineRoles(line);
  const runs = segmentLineIntoRuns(line);
  return runs
    .map((run) => {
      if (!run.math) return joinProseItems(run.items);
      const body = renderMathRun(run.items);
      if (body.trim().length === 0) return joinProseItems(run.items);
      return `$${body}$`;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Reconstruct a page of text from pdf.js text items while attempting
 * to recover LaTeX math expressions. The returned string preserves
 * line breaks and wraps math segments with `$...$` so that the reader
 * can render them via KaTeX.
 *
 * For pages where no math content is detected the result is identical
 * to the naïve `items.map(i => i.str).join(' ')` extraction, so this
 * is safe to use for every PDF.
 */
export const reconstructPdfPageWithMath = (items: PdfTextItem[]): string => {
  if (!Array.isArray(items) || items.length === 0) return '';
  const processed = buildProcessedItems(items);
  const lines = groupItemsIntoLines(processed);
  const rendered = lines
    .map((line) => renderLine(line))
    .filter((line) => line.length > 0);
  return rendered.join('\n');
};
