import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mathRehypePlugins, mathRemarkPlugins, normalizeMathDelimiters } from './math';

function render(source: string) {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, ...mathRemarkPlugins]}
      rehypePlugins={mathRehypePlugins}
    >
      {normalizeMathDelimiters(source)}
    </ReactMarkdown>,
  );
}

// How models write formulas, each expected to render with no TeX left showing as text.
const formulas: [string, string, { display?: boolean }?][] = [
  ['dollars inline', '能量 $E=mc^2$ 守恒'],
  ['dollar block', '$$\n\\int_0^1 x\\,dx\n$$', { display: true }],
  ['dollar block on one line', '$$\\sum_{i=1}^n i$$', { display: true }],
  ['dollar block sharing lines with the formula', '$$x = 1\ny = 2$$', { display: true }],
  ['parentheses', '设 \\(x_i\\) 为样本'],
  ['brackets', '\\[\n a^2+b^2=c^2\n\\]', { display: true }],
  [
    'environment without delimiters',
    '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}',
    { display: true },
  ],
  ['fraction inside a dollar block', '$$\nE = \\frac{1}{2}mv^2\n$$', { display: true }],
  ['braced subscript inside math', '$x_{A_b} + y$'],
  [
    'absolute value in a table',
    '| 量 | 公式 |\n|---|---|\n| 绝对值 | $|x|$ |\n| 范数 | $\\|x\\|_2$ |',
  ],
  ['block in a list', '1. 第一步\n\n   $$\n   x = 1\n   $$', { display: true }],
  ['block in a quote', '> $$\n> x^2\n> $$', { display: true }],
  ['Chinese text in math', '$\\text{损失} = \\sum_i \\ell_i$'],
];

it.each(formulas)('renders %s', (_name, source, expected = {}) => {
  const html = render(source);
  expect(html).toContain('class="katex"');
  expect(html).not.toContain('katex-error');
  if (expected.display) expect(html).toContain('katex-display');
  const prose = html
    .replace(/<span class="katex[\s\S]*?<\/annotation>/g, '')
    .replace(/<[^>]+>/g, ' ');
  expect(prose).not.toMatch(/\$|\\\(|\\\[|\\begin|\\frac/);
});

it('leaves code and prices alone', () => {
  const code = 'Run `echo $HOME` or:\n\n```sh\nprice=$5 \\frac{a}{b}\n```';
  expect(normalizeMathDelimiters(code)).toBe(code);
});
