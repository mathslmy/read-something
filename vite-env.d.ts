/// <reference types="vite/client" />

declare module 'katex' {
  interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    errorColor?: string;
    strict?: boolean | string | ((errorCode: string, errorMsg: string) => string | boolean);
    trust?: boolean | ((ctx: Record<string, unknown>) => boolean);
    output?: 'html' | 'mathml' | 'htmlAndMathml';
    macros?: Record<string, string>;
    fleqn?: boolean;
    leqno?: boolean;
    minRuleThickness?: number;
    maxSize?: number;
    maxExpand?: number;
  }
  export function renderToString(expression: string, options?: KatexOptions): string;
  const katex: { renderToString: typeof renderToString };
  export default katex;
}

