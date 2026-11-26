import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { RootContent } from 'mdast';
import type { Extension as MarkdownExtension } from 'mdast-util-from-markdown';
import type { Code, Extension, State, Tokenizer } from 'micromark-util-types';
import type { PluggableList, Processor } from 'unified';
import 'katex/dist/katex.min.css';
import './math.css';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    capsioMath: 'capsioMath';
    capsioMathData: 'capsioMathData';
  }
}

// Extend Markdown tokenization so LaTeX delimiters cannot rewrite code or links.
const tokenizeLatex: Tokenizer = function (effects, ok, nok) {
  let closing: Code;
  return start;
  function start(code: Code) {
    if (code !== 92) return nok(code);
    effects.enter('capsioMath');
    effects.consume(code);
    return opening;
  }
  function opening(code: Code) {
    if (code !== 40 && code !== 91) return nok(code);
    closing = code === 40 ? 41 : 93;
    effects.consume(code);
    return between;
  }
  function between(code: Code): ReturnType<State> {
    if (code === null) return nok(code);
    if (code === -5 || code === -4 || code === -3) {
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return between;
    }
    effects.enter('capsioMathData');
    return inside(code);
  }
  function inside(code: Code): ReturnType<State> {
    if (code === null) return nok(code);
    if (code === -5 || code === -4 || code === -3) {
      effects.exit('capsioMathData');
      return between(code);
    }
    effects.consume(code);
    return code === 92 ? afterSlash : inside;
  }
  function afterSlash(code: Code): ReturnType<State> {
    if (code === closing) {
      effects.consume(code);
      effects.exit('capsioMathData');
      effects.exit('capsioMath');
      return ok;
    }
    if (code === 92) {
      effects.consume(code);
      return inside;
    }
    return inside(code);
  }
};

function remarkLatex(this: Processor) {
  const data = this.data() as {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: MarkdownExtension[];
  };
  const syntax: Extension = {
    text: { 92: { name: 'capsioMath', tokenize: tokenizeLatex } },
  };
  const nodes: MarkdownExtension = {
    enter: {
      capsioMath(token) {
        this.enter({ type: 'inlineMath', value: '' }, token);
        this.buffer();
      },
    },
    exit: {
      capsioMath(token) {
        this.resume();
        const source = this.sliceSerialize(token);
        const node = this.stack[this.stack.length - 1] as Extract<
          RootContent,
          { type: 'inlineMath' }
        >;
        node.value = source.slice(2, -2);
        node.data = {
          hName: 'code',
          hProperties: {
            className: ['language-math', source[1] === '[' ? 'math-display' : 'math-inline'],
          },
          hChildren: [{ type: 'text', value: node.value }],
        };
        this.exit(token);
      },
    },
  };
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(nodes);
}

export const mathRemarkPlugins: PluggableList = [remarkMath, remarkLatex];
export const mathRehypePlugins: PluggableList = [
  [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }],
];

// Math that already has delimiters, and inline code: never rewritten.
const DELIMITED =
  /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<![\\$])\$(?!\$)[^$\n]+?(?<!\\)\$|`[^`\n]+`)/g;
const INLINE_DOLLAR = /(?<![\\$])\$(?!\$)([^$\n]+?)(?<!\\)\$/g;
// A `$$` block starting a line, possibly in a list or quote, up to a `$$` ending a line.
const DISPLAY = /^((?:[ \t]*>)*[ \t]*)\$\$([\s\S]*?)\$\$[ \t]*$/gm;
const ENVIRONMENT =
  /\\begin\{(aligned|align\*?|equation\*?|gather\*?|gathered|cases|split|multline\*?|array|[pbvBV]?matrix)\}[\s\S]*?\\end\{\1\}/g;

/**
 * Fixes how models commonly lay out TeX so it renders: `$$` blocks whose delimiters share
 * a line with the formula (shown as display math), `|` in a formula inside a table cell
 * (which would split the cell), and environments, fractions, roots and small fragments
 * such as `{A_b}` written without delimiters. Code, and math that already has delimiters,
 * are left exactly as they are.
 */
export function normalizeMathDelimiters(source: string) {
  return source
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part, index) => (index % 2 === 1 ? part : normalizeProse(part)))
    .join('');
}

function normalizeProse(text: string) {
  const value = text
    .replace(DISPLAY, (match, prefix: string, content: string) => {
      if (!content.trim() || content.includes('$$') || /\n[ \t>]*\n/.test(content)) return match;
      const lines = content.split('\n');
      const opening = lines[0].trim();
      const closing = lines.length > 1 ? lines[lines.length - 1].replace(/^[ \t>]*/, '') : '';
      if (lines.length > 1 && !opening && !closing.trim()) return match;
      const body = [
        ...(opening ? [prefix + opening] : []),
        ...lines.slice(1, -1),
        ...(closing.trim() ? [prefix + closing.trim()] : []),
      ];
      return [prefix + '$$', ...body, prefix + '$$'].join('\n');
    })
    .replace(/^[ \t]*\|.*$/gm, (row) =>
      row.replace(INLINE_DOLLAR, (_match, inner: string) => {
        return `$${inner.replace(/(?<!\\)\|/g, '\\vert ')}$`;
      }),
    );
  return value
    .split(DELIMITED)
    .map((piece, index) => (index % 2 === 1 ? piece : withDelimiters(piece)))
    .join('');
}

/** TeX in plain prose that a model left without delimiters. */
function withDelimiters(prose: string) {
  const value = prose.replace(
    /\{([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+|\^[A-Za-z0-9]+))\}/g,
    (_match, expression: string) => `\\(${expression}\\)`,
  );
  // A delimiter still open here is being streamed in; wait for the rest.
  if (/\\\[|\\\(|\$\$/.test(value)) return value;
  return value
    .replace(ENVIRONMENT, (environment) => `\n$$\n${environment}\n$$\n`)
    .replace(
      /(?<![\\$])((?:\\frac\{[^{}\n]+\}\{[^{}\n]+\}|\\sqrt\{[^{}\n]+\}))(?![\\$])/g,
      (_match, expression: string) => `\\(${expression}\\)`,
    );
}
