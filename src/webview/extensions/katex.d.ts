declare module 'katex' {
  export interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    trust?: boolean;
    strict?: 'error' | 'warn' | 'ignore' | string;
    output?: 'html' | 'mathml' | 'htmlAndMathml';
  }

  const katex: {
    render: (tex: string, target: HTMLElement, options?: KatexOptions) => void;
    renderToString: (tex: string, options?: KatexOptions) => string;
  };

  export default katex;
}
