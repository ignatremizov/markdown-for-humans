/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Wraps top-level multi-word prose runs in \text{} before KaTeX rendering so
 * spaces the user typed survive display without mutating the stored source.
 */
export function preserveProseSpaces(latex: string): string {
  if (!latex || !latex.includes(' ')) {
    return latex;
  }

  const isLetter = (char: string): boolean =>
    (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');

  let output = '';
  let depth = 0;
  let index = 0;

  while (index < latex.length) {
    const char = latex[index];

    if (char === '\\') {
      output += char;
      index += 1;

      if (index < latex.length && isLetter(latex[index])) {
        while (index < latex.length && isLetter(latex[index])) {
          output += latex[index];
          index += 1;
        }
      } else if (index < latex.length) {
        output += latex[index];
        index += 1;
      }
      continue;
    }

    if (char === '{') {
      depth += 1;
      output += char;
      index += 1;
      continue;
    }

    if (char === '}') {
      depth = Math.max(0, depth - 1);
      output += char;
      index += 1;
      continue;
    }

    if (depth === 0 && isLetter(char)) {
      let run = '';

      while (index < latex.length) {
        if (isLetter(latex[index])) {
          run += latex[index];
          index += 1;
        } else if (latex[index] === ' ' && index + 1 < latex.length && isLetter(latex[index + 1])) {
          run += ' ';
          index += 1;
        } else {
          break;
        }
      }

      if (run.includes(' ')) {
        if (output.endsWith(' ')) {
          output = output.slice(0, -1);
          run = ` ${run}`;
        }

        if (index < latex.length && latex[index] === ' ') {
          run += ' ';
          index += 1;
        }

        output += `\\text{${run}}`;
      } else {
        output += run;
      }

      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}
