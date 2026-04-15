import React from 'react';
import katex from 'katex';

/**
 * Lightweight LaTeX parser and renderer built on KaTeX.
 *
 * Supported delimiters (in priority order):
 *   - $$ ... $$       (display math)
 *   - \[ ... \]       (display math)
 *   - \( ... \)       (inline math)
 *   - $  ...  $       (inline math)
 *
 * The parser is deliberately conservative: it avoids matching a lone `$`
 * that is clearly used as a currency symbol (e.g. `$5`, `$ 10`, `100$`).
 * Unclosed delimiters are treated as plain text so unrelated content is
 * never lost.
 */

export interface LatexRenderOptions {
  /** Add an extra className on the wrapping span. */
  className?: string;
  /** When true, newlines inside the text are preserved via <br />. */
  preserveNewlines?: boolean;
}

interface MathToken {
  type: 'math';
  value: string;
  display: boolean;
}

interface TextToken {
  type: 'text';
  value: string;
}

type Token = MathToken | TextToken;

const INLINE_DOLLAR_BAD_PREV = /[\w\d]/; // word char before `$` => currency
const INLINE_DOLLAR_BAD_NEXT = /[\s\d]/; // whitespace or digit after `$` => currency

/**
 * Returns true if a single `$` at index `i` is likely a currency sign
 * rather than a math delimiter.
 */
function looksLikeCurrency(text: string, i: number): boolean {
  const prev = i > 0 ? text[i - 1] : '';
  const next = i + 1 < text.length ? text[i + 1] : '';
  if (INLINE_DOLLAR_BAD_PREV.test(prev) && /\d/.test(next)) return true;
  if (/\d/.test(prev) && !next) return true;
  if (/\s/.test(prev) && INLINE_DOLLAR_BAD_NEXT.test(next)) return true;
  return false;
}

/**
 * Tokenize the given text into alternating plain-text and math runs.
 */
export function tokenizeLatex(input: string): Token[] {
  if (!input) return [];
  const tokens: Token[] = [];
  let buffer = '';
  let i = 0;

  const flushText = () => {
    if (buffer) {
      tokens.push({ type: 'text', value: buffer });
      buffer = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    // \[ ... \]
    if (ch === '\\' && next === '[') {
      const end = input.indexOf('\\]', i + 2);
      if (end !== -1) {
        flushText();
        tokens.push({ type: 'math', value: input.slice(i + 2, end), display: true });
        i = end + 2;
        continue;
      }
    }

    // \( ... \)
    if (ch === '\\' && next === '(') {
      const end = input.indexOf('\\)', i + 2);
      if (end !== -1) {
        flushText();
        tokens.push({ type: 'math', value: input.slice(i + 2, end), display: false });
        i = end + 2;
        continue;
      }
    }

    // $$ ... $$
    if (ch === '$' && next === '$') {
      const end = input.indexOf('$$', i + 2);
      if (end !== -1) {
        flushText();
        tokens.push({ type: 'math', value: input.slice(i + 2, end), display: true });
        i = end + 2;
        continue;
      }
    }

    // $ ... $  (inline)
    if (ch === '$' && next !== '$') {
      if (!looksLikeCurrency(input, i)) {
        // find closing `$` that is not escaped and not part of `$$`
        let j = i + 1;
        while (j < input.length) {
          const cj = input[j];
          if (cj === '\\' && j + 1 < input.length) {
            j += 2;
            continue;
          }
          if (cj === '$') break;
          // disallow math spanning a blank line (likely stray $)
          if (cj === '\n' && input[j + 1] === '\n') {
            j = -1;
            break;
          }
          j++;
        }
        if (j !== -1 && j < input.length && input[j] === '$') {
          const body = input.slice(i + 1, j);
          if (body.trim().length > 0) {
            flushText();
            tokens.push({ type: 'math', value: body, display: false });
            i = j + 1;
            continue;
          }
        }
      }
    }

    buffer += ch;
    i++;
  }

  flushText();
  return tokens;
}

/**
 * Detect whether the given text contains any candidate LaTeX math.
 * Cheap pre-filter to skip the full tokenizer when nothing interesting
 * is present.
 */
export function hasLatexMath(input: string | null | undefined): boolean {
  if (!input) return false;
  if (input.indexOf('$') === -1 && input.indexOf('\\(') === -1 && input.indexOf('\\[') === -1) {
    return false;
  }
  // Quick validation: at least one math-looking pair.
  const tokens = tokenizeLatex(input);
  return tokens.some(t => t.type === 'math');
}

function renderMathHtml(value: string, display: boolean): { html: string; ok: boolean } {
  try {
    const html = katex.renderToString(value, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
      strict: 'ignore',
    });
    return { html, ok: true };
  } catch (err) {
    return { html: '', ok: false };
  }
}

/**
 * Render plain text that may contain LaTeX into an array of React nodes.
 * Non-math text is returned as-is (with optional newline preservation).
 */
export function renderLatexToReact(
  input: string | null | undefined,
  options: LatexRenderOptions = {}
): React.ReactNode {
  const text = input ?? '';
  if (!hasLatexMath(text)) {
    return options.preserveNewlines ? renderTextWithNewlines(text) : text;
  }

  const tokens = tokenizeLatex(text);
  const nodes: React.ReactNode[] = [];
  tokens.forEach((token, index) => {
    if (token.type === 'text') {
      if (!token.value) return;
      nodes.push(
        <React.Fragment key={`t-${index}`}>
          {options.preserveNewlines ? renderTextWithNewlines(token.value) : token.value}
        </React.Fragment>
      );
      return;
    }
    const { html, ok } = renderMathHtml(token.value, token.display);
    if (!ok || !html) {
      // Fallback: show raw source so user still sees their input.
      const fallback = token.display ? `$$${token.value}$$` : `$${token.value}$`;
      nodes.push(
        <span key={`m-${index}`} className="latex-error" title="LaTeX 渲染失败">
          {fallback}
        </span>
      );
      return;
    }
    if (token.display) {
      nodes.push(
        <span
          key={`m-${index}`}
          className="latex-display"
          style={{ display: 'block', overflowX: 'auto', margin: '0.5em 0' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    } else {
      nodes.push(
        <span
          key={`m-${index}`}
          className="latex-inline"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
  });

  if (options.className) {
    return <span className={options.className}>{nodes}</span>;
  }
  return <>{nodes}</>;
}

function renderTextWithNewlines(text: string): React.ReactNode {
  if (!text.includes('\n')) return text;
  const parts = text.split('\n');
  const out: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push(<br key={`br-${i}`} />);
    if (part) out.push(part);
  });
  return <>{out}</>;
}

/**
 * Convenience React component wrapper for renderLatexToReact.
 */
export const LatexText: React.FC<{
  children?: string | null;
  text?: string | null;
  className?: string;
  preserveNewlines?: boolean;
}> = ({ children, text, className, preserveNewlines }) => {
  const value = typeof children === 'string' ? children : text ?? '';
  return <>{renderLatexToReact(value, { className, preserveNewlines })}</>;
};
