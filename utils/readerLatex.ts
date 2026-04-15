// ═══════════════════════════════════════════════════════════════
//  LaTeX parsing and KaTeX rendering helpers used by the Reader
//  to display math expressions inline with the surrounding text.
// ═══════════════════════════════════════════════════════════════

import katex from 'katex';

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
