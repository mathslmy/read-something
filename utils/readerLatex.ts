// ═══════════════════════════════════════════════════════════════
//  LaTeX parsing and KaTeX rendering helpers used by the Reader
//  to display math expressions inline with the surrounding text.
// ═══════════════════════════════════════════════════════════════

import katex from 'katex';
import { UNICODE_TO_LATEX, MATH_HINT_CHARS } from './pdfMathReconstruction';

export interface LatexRegion {
  /** Inclusive start offset within the owning paragraph text. */
  start: number;
  /** Exclusive end offset within the owning paragraph text. */
  end: number;
  /** Raw source including opening and closing delimiters. */
  source: string;
  /** LaTeX content with the delimiters stripped. */
  content: string;
  /** Whether the math should be rendered as a block (display mode). */
  displayMode: boolean;
}

const MATH_CONTENT_HINT_REGEX = /[\\^_{}=+\-*/<>]|\\[A-Za-z]+/;

const countTrailingBackslashes = (text: string, position: number) => {
  let count = 0;
  let cursor = position - 1;
  while (cursor >= 0 && text[cursor] === '\\') {
    count += 1;
    cursor -= 1;
  }
  return count;
};

const isEscapedPosition = (text: string, position: number) =>
  countTrailingBackslashes(text, position) % 2 === 1;

/**
 * Parse `text` and return all LaTeX regions in left-to-right order.
 * Recognises `$$...$$`, `\[...\]`, `\(...\)` and `$...$`.
 *
 * The parser is deliberately conservative about bare `$...$` math so
 * that prose containing currency markers such as `$5 and $10` is not
 * turned into garbled math. A `$...$` span is only accepted when the
 * characters immediately inside the delimiters are non-whitespace and
 * the enclosed body contains at least one math-looking character.
 */
export const parseLatexRegions = (text: string): LatexRegion[] => {
  if (!text || (text.indexOf('$') < 0 && text.indexOf('\\') < 0)) return [];

  const regions: LatexRegion[] = [];
  const length = text.length;
  let index = 0;

  while (index < length) {
    const char = text[index];

    // $$ ... $$ display math
    if (char === '$' && text[index + 1] === '$' && !isEscapedPosition(text, index)) {
      const start = index;
      const contentStart = index + 2;
      let cursor = contentStart;
      let foundEnd = -1;
      while (cursor < length - 1) {
        if (text[cursor] === '$' && text[cursor + 1] === '$' && !isEscapedPosition(text, cursor)) {
          foundEnd = cursor;
          break;
        }
        cursor += 1;
      }
      if (foundEnd > contentStart) {
        const content = text.slice(contentStart, foundEnd);
        if (content.trim().length > 0) {
          regions.push({
            start,
            end: foundEnd + 2,
            source: text.slice(start, foundEnd + 2),
            content,
            displayMode: true,
          });
          index = foundEnd + 2;
          continue;
        }
      }
      index = start + 1;
      continue;
    }

    // $ ... $ inline math
    if (char === '$' && !isEscapedPosition(text, index)) {
      const start = index;
      const next = text[index + 1];
      if (next && !/\s/.test(next)) {
        let cursor = index + 1;
        let foundEnd = -1;
        while (cursor < length) {
          const current = text[cursor];
          if (current === '\n' && text[cursor + 1] === '\n') break;
          if (current === '$' && !isEscapedPosition(text, cursor)) {
            const prev = text[cursor - 1];
            if (prev && !/\s/.test(prev)) {
              foundEnd = cursor;
            }
            break;
          }
          cursor += 1;
        }
        if (foundEnd > index + 1) {
          const content = text.slice(index + 1, foundEnd);
          if (content.trim().length > 0 && MATH_CONTENT_HINT_REGEX.test(content)) {
            regions.push({
              start,
              end: foundEnd + 1,
              source: text.slice(start, foundEnd + 1),
              content,
              displayMode: false,
            });
            index = foundEnd + 1;
            continue;
          }
        }
      }
      index += 1;
      continue;
    }

    // \[ ... \] display math
    if (char === '\\' && text[index + 1] === '[') {
      const start = index;
      const contentStart = index + 2;
      let cursor = contentStart;
      let foundEnd = -1;
      while (cursor < length - 1) {
        if (text[cursor] === '\\' && text[cursor + 1] === ']') {
          foundEnd = cursor;
          break;
        }
        cursor += 1;
      }
      if (foundEnd > contentStart) {
        const content = text.slice(contentStart, foundEnd);
        if (content.trim().length > 0) {
          regions.push({
            start,
            end: foundEnd + 2,
            source: text.slice(start, foundEnd + 2),
            content,
            displayMode: true,
          });
          index = foundEnd + 2;
          continue;
        }
      }
      index = start + 2;
      continue;
    }

    // \( ... \) inline math
    if (char === '\\' && text[index + 1] === '(') {
      const start = index;
      const contentStart = index + 2;
      let cursor = contentStart;
      let foundEnd = -1;
      while (cursor < length - 1) {
        if (text[cursor] === '\\' && text[cursor + 1] === ')') {
          foundEnd = cursor;
          break;
        }
        cursor += 1;
      }
      if (foundEnd > contentStart) {
        const content = text.slice(contentStart, foundEnd);
        if (content.trim().length > 0) {
          regions.push({
            start,
            end: foundEnd + 2,
            source: text.slice(start, foundEnd + 2),
            content,
            displayMode: false,
          });
          index = foundEnd + 2;
          continue;
        }
      }
      index = start + 2;
      continue;
    }

    index += 1;
  }

  return regions;
};

export const paragraphHasLatex = (text: string) => parseLatexRegions(text).length > 0;

// ── Implicit math region detection ─────────────────────────────
//
// Old imported books and PDFs whose text extraction wasn't routed
// through the math reconstructor contain bare Unicode math glyphs
// (`Ω ⊂ C n`) without any `$...$` wrapping. To render them we scan
// each paragraph for runs of characters that look mathematical and
// translate them into a KaTeX-compatible expression at render time.
// This is intentionally decoupled from the import-time rewriter so
// existing books get the same visual treatment without needing to
// be re-imported.

// Strong math operators / relations: their presence alone is enough
// to flip a short span into math mode.
const STRONG_MATH_CHARS = new Set<string>([
  '⊂', '⊃', '⊆', '⊇', '⊊', '⊋', '∈', '∉', '∋', '∀', '∃', '∄',
  '∑', '∏', '∫', '∬', '∭', '∮', '∪', '∩', '⋂', '⋃',
  '→', '←', '↔', '⇒', '⇐', '⇔', '↦', '⟶', '⟵', '⟹', '⟸',
  '≤', '≥', '≠', '≈', '≡', '∼', '≃', '≅', '≪', '≫',
  '∞', '∂', '∇', '∅', '∝', '⊥', '∥',
  'ℕ', 'ℤ', 'ℚ', 'ℝ', 'ℂ', 'ℍ', 'ℙ',
  '±', '∓', '⊕', '⊗', '⊖', '⊙',
]);

// Chars that tend to appear next to math symbols and should be
// absorbed into a math run without themselves triggering one. Plain
// ASCII letters/digits + common math punctuation.
const MATH_NEUTRAL_CODEPOINT_REGEX = /[A-Za-z0-9 ()[\]{}.,;:+\-*/=<>|!&^_\\'"−]/;

// Latin letters in a math run may need `\mathit{}` but KaTeX renders
// bare ASCII letters in math mode as italic variables, which is what
// we want for things like `C^n` → `C^n`. So we just translate known
// Unicode math chars and leave ASCII intact.
const translateImplicitMathChar = (char: string): string => {
  const mapped = UNICODE_TO_LATEX[char];
  if (mapped === undefined) return char;
  return mapped;
};

const translateImplicitMathRun = (text: string): string => {
  let result = '';
  for (const char of text) {
    const translated = translateImplicitMathChar(char);
    if (result.length > 0) {
      // If the running output ends with a LaTeX command (`\Omega`)
      // and the next chunk starts with an ASCII letter, we need an
      // explicit separator so LaTeX doesn't try to glue them into
      // one macro name (`\OmegaC`).
      const prevIsCommand = /\\[A-Za-z]+$/.test(result);
      if (prevIsCommand && /^[A-Za-z]/.test(translated)) {
        result += ' ';
      }
    }
    result += translated;
  }
  return result;
};

/**
 * Find runs of the paragraph text that should be rendered as math
 * even though the author (or the PDF importer) never wrapped them in
 * explicit LaTeX delimiters. A run must contain at least one strong
 * math operator, or at least two math hint chars, to count — this
 * keeps sentences such as "α version" or "c. 300 AD" out of the
 * detection.
 *
 * The scanner walks forward through the paragraph. Whenever it hits
 * a math hint char, it keeps extending the run as long as the next
 * hint char is at most `NEUTRAL_LOOKAHEAD` neutral characters away.
 * That way `Ω → [ −∞, ∞` stays joined into a single region but the
 * prose that follows a trailing `∞` doesn't get sucked in. The run
 * never extends backward past its first hint char, which means a
 * leading `u :` before `Ω` stays outside the math.
 */
const NEUTRAL_LOOKAHEAD = 5;
const TRAILING_CLOSERS = new Set(['.', ',', ';', ':', ')', ']', '}', '!', '?']);

export const findImplicitMathRegions = (text: string): LatexRegion[] => {
  if (!text) return [];
  const length = text.length;
  const regions: LatexRegion[] = [];

  let index = 0;
  while (index < length) {
    if (!MATH_HINT_CHARS.has(text[index])) {
      index += 1;
      continue;
    }

    const runStart = index;
    let runEnd = index + 1;
    let hintCount = 1;
    let strongCount = STRONG_MATH_CHARS.has(text[index]) ? 1 : 0;
    let cursor = index + 1;

    while (cursor < length) {
      const ch = text[cursor];
      if (MATH_HINT_CHARS.has(ch)) {
        hintCount += 1;
        if (STRONG_MATH_CHARS.has(ch)) strongCount += 1;
        runEnd = cursor + 1;
        cursor += 1;
        continue;
      }
      if (!MATH_NEUTRAL_CODEPOINT_REGEX.test(ch)) break;

      // Look ahead through a small window of neutral chars for the
      // next hint. If we find one, skip over the neutrals and keep
      // going. Otherwise stop — the run ends at the previous hint.
      let lookahead = cursor;
      let probeLimit = Math.min(length, cursor + NEUTRAL_LOOKAHEAD);
      let foundHint = false;
      while (lookahead < probeLimit) {
        const probe = text[lookahead];
        if (MATH_HINT_CHARS.has(probe)) { foundHint = true; break; }
        if (!MATH_NEUTRAL_CODEPOINT_REGEX.test(probe)) break;
        lookahead += 1;
      }
      if (foundHint) {
        cursor = lookahead;
        continue;
      }
      break;
    }

    // Below the detection threshold → treat as incidental Unicode
    // (e.g. a stray `α` in prose) and skip past the hint char.
    if (strongCount === 0 && hintCount < 2) {
      index = runEnd;
      continue;
    }

    // Pull any immediately trailing closer punctuation such as `)` or
    // `.` into the run so the math stops in a natural place rather
    // than leaving an orphan bracket after the KaTeX output.
    while (runEnd < length && TRAILING_CLOSERS.has(text[runEnd])) {
      runEnd += 1;
    }

    // Trim the run back through whitespace on both ends.
    let trimmedStart = runStart;
    let trimmedEnd = runEnd;
    while (trimmedEnd > trimmedStart && /\s/.test(text[trimmedEnd - 1])) trimmedEnd -= 1;
    while (trimmedStart < trimmedEnd && /\s/.test(text[trimmedStart])) trimmedStart += 1;
    if (trimmedEnd <= trimmedStart) {
      index = runEnd;
      continue;
    }

    const rawSource = text.slice(trimmedStart, trimmedEnd);
    const translated = translateImplicitMathRun(rawSource);
    regions.push({
      start: trimmedStart,
      end: trimmedEnd,
      source: rawSource,
      content: translated,
      displayMode: false,
    });
    index = runEnd;
  }

  return regions;
};

/**
 * Return the combined list of explicit (`$...$`, `\[...\]`, etc.) and
 * implicit (bare Unicode math) regions in a paragraph, preferring
 * explicit regions when the two overlap. Result is sorted by start.
 */
export const findAllLatexRegions = (text: string): LatexRegion[] => {
  const explicit = parseLatexRegions(text);
  const implicit = findImplicitMathRegions(text);
  if (implicit.length === 0) return explicit;
  if (explicit.length === 0) return implicit;

  const overlapsExplicit = (region: LatexRegion) =>
    explicit.some((ex) => ex.start < region.end && ex.end > region.start);

  const merged = [
    ...explicit,
    ...implicit.filter((region) => !overlapsExplicit(region)),
  ];
  merged.sort((a, b) => a.start - b.start);
  return merged;
};

const LATEX_RENDER_CACHE = new Map<string, string>();
const LATEX_RENDER_CACHE_LIMIT = 512;

const escapeHtml = (raw: string) =>
  raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Render a LaTeX expression to an HTML string using KaTeX. Results are
 * cached per expression+mode so scroll-driven re-renders stay cheap.
 * If KaTeX raises (e.g. on malformed input) the raw source is returned
 * inline as a fallback so the reader never loses the original content.
 */
export const renderLatexToHtml = (content: string, displayMode: boolean): string => {
  const cacheKey = `${displayMode ? 'd' : 'i'}:${content}`;
  const cached = LATEX_RENDER_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  let html: string;
  try {
    html = katex.renderToString(content, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    });
  } catch {
    const fallbackClass = displayMode
      ? 'reader-latex-fallback reader-latex-fallback--block'
      : 'reader-latex-fallback';
    html = `<span class="${fallbackClass}">${escapeHtml(content)}</span>`;
  }

  if (LATEX_RENDER_CACHE.size >= LATEX_RENDER_CACHE_LIMIT) {
    const firstKey = LATEX_RENDER_CACHE.keys().next().value;
    if (firstKey !== undefined) LATEX_RENDER_CACHE.delete(firstKey);
  }
  LATEX_RENDER_CACHE.set(cacheKey, html);
  return html;
};
