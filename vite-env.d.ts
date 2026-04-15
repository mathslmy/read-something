/// <reference types="vite/client" />

declare module 'katex' {
  interface KatexOptions {
    displayMode?: boolean;
    output?: 'html' | 'mathml' | 'htmlAndMathml';
    throwOnError?: boolean;
    errorColor?: string;
    macros?: Record<string, string>;
    strict?: boolean | string | ((errorCode: string, errorMsg: string) => string | boolean);
    trust?: boolean | ((context: unknown) => boolean);
    colorIsTextColor?: boolean;
    maxSize?: number;
    maxExpand?: number;
    leqno?: boolean;
    fleqn?: boolean;
    minRuleThickness?: number;
  }
  function render(input: string, element: HTMLElement, options?: KatexOptions): void;
  function renderToString(input: string, options?: KatexOptions): string;
  const katex: {
    render: typeof render;
    renderToString: typeof renderToString;
  };
  export default katex;
  export { render, renderToString, KatexOptions };
}

