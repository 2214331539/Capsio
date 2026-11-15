import { expect, it } from 'vitest';
import {
  bibKeys,
  citations,
  countWords,
  dependencies,
  detectCompiler,
  hint,
  isArtifact,
  isMainDocument,
  labels,
  missingFiles,
  networkFailure,
  outline,
  parseLog,
  sourcePath,
} from './latex';
import { backwardSearch, forwardSearch, parseSynctex } from './synctex';

const LOG =
  String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2025) (preloaded format=pdflatex 2025.3.8)
entering extended mode
(./main.tex
LaTeX2e <2024-11-01> patch level 2
(/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
(/usr/local/texlive/2025/texmf-dist/tex/latex/base/size10.clo))
(./sections/intro.tex
Overfull \hbox (12.41pt too wide) in paragraph at lines 4--5
[]\OT1/cmr/m/n/10 A very long line that will overflow the box|

LaTeX Warning: Citation ` +
  '`' +
  String.raw`yang2025' on page 1 undefined on input line 3.

)
./main.tex:15: Undefined control sequence.
l.15 Undefined command here: \cmark
                                    .
Package natbib Warning: Citation ` +
  '`' +
  String.raw`missingkey' on page 1 undefined on input
(natbib)                line 11.

LaTeX Warning: There were undefined references.

)
Output written on /cache/main.pdf (2 pages, 51234 bytes).`;

it('reads errors, warnings and bad boxes with the file and line they belong to', () => {
  const entries = parseLog(LOG, '', '/home/me/paper');
  expect(entries).toContainEqual({
    kind: 'error',
    file: 'main.tex',
    line: 15,
    message: 'Undefined control sequence.',
    detail: 'l.15 Undefined command here: \\cmark\n                                    .',
  });
  expect(entries).toContainEqual({
    kind: 'box',
    file: 'sections/intro.tex',
    line: 4,
    message: 'Overfull \\hbox (12.41pt too wide)',
  });
  expect(entries).toContainEqual({
    kind: 'warning',
    file: 'sections/intro.tex',
    line: 3,
    message: "Citation `yang2025' on page 1 undefined",
  });
  expect(entries).toContainEqual({
    kind: 'warning',
    file: 'main.tex',
    line: 11,
    message: "Citation `missingkey' on page 1 undefined",
  });
  expect(entries.some((entry) => entry.message === 'There were undefined references.')).toBe(true);
});

it('reads classic "!" errors and Tectonic output, and strips the manuscript folder', () => {
  const classic = parseLog(
    "(./main.tex\n(./chapters/one.tex\n! LaTeX Error: File `missing.sty' not found.\n\nType X to quit.\nl.3 \\usepackage\n               {missing}\n",
  );
  expect(classic[0]).toMatchObject({
    kind: 'error',
    file: 'chapters/one.tex',
    line: 3,
    message: "File `missing.sty' not found.",
  });
  const tectonic = parseLog(
    '',
    "note: Running TeX ...\nerror: F:/Paper/sections/intro.tex:16: Undefined control sequence\nwarning: F:/Paper/main.tex:2: LaTeX Warning: Label `a' multiply defined.\nerror: halted on potentially-recoverable error as specified\n",
    'F:\\Paper',
  );
  expect(tectonic).toEqual([
    { kind: 'error', file: 'sections/intro.tex', line: 16, message: 'Undefined control sequence' },
    { kind: 'warning', file: 'main.tex', line: 2, message: "Label `a' multiply defined." },
  ]);
  expect(sourcePath('\\\\?\\F:\\Paper\\fig\\a.tex', 'F:\\Paper')).toBe('fig/a.tex');
  expect(hint('Undefined control sequence.')).toContain('未定义的命令');
});

it('outlines headings, counts words and collects labels, keys and citations', () => {
  const text = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Introduction} % opening',
    'We study \\emph{proactive} agents \\cite{yang2025, lu2024}.',
    '% \\section{Hidden}',
    '\\subsection*[short]{Why \\textbf{timing} matters}',
    '\\label{sec:why} 研究时机 $x^2$',
    '\\end{document}',
  ].join('\n');
  expect(outline(text)).toEqual([
    { level: 2, title: 'Introduction', line: 3 },
    { level: 3, title: 'Why timing matters', line: 6 },
  ]);
  expect(countWords(text)).toBe(4 + 1 + 3 + 4);
  expect(labels(text)).toEqual(['sec:why']);
  expect(citations(text)).toEqual([
    { key: 'yang2025', line: 4 },
    { key: 'lu2024', line: 4 },
  ]);
  expect(
    bibKeys('@string{x = "y"}\n@article{yang2025,\n title={A}}\n@InProceedings{ lu2024 ,'),
  ).toEqual(['yang2025', 'lu2024']);
  expect(isMainDocument(text)).toBe(true);
  expect(isMainDocument('% \\documentclass{article}\n\\section{A}')).toBe(false);
});

const SYNCTEX = [
  'SyncTeX Version:1',
  'Input:1:/home/me/paper/main.tex',
  'Input:2:/home/me/paper/./sections/intro.tex',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'X Offset:0',
  'Y Offset:0',
  'Content:',
  '!100',
  '{1',
  '[1,5:4736286,4736286:26214400,40049754,0',
  '(2,3:4736286,9437184:26214400,655360,196608',
  'x2,3:4736286,9437184',
  ')',
  '(2,4:4736286,10223616:26214400,655360,196608',
  ')',
  '(1,9:4736286,13631488:20000000,655360,196608',
  ')',
  ']',
  '}1',
  '{2',
  '(1,15:4736286,6553600:26214400,655360,196608',
  ')',
  '}2',
].join('\n');

it('maps source lines to PDF positions and back with SyncTeX', () => {
  const data = parseSynctex(SYNCTEX, '/home/me/paper');
  expect([...data.inputs.values()]).toEqual(['main.tex', 'sections/intro.tex']);
  const spot = forwardSearch(data, 'sections/intro.tex', 3)!;
  expect(spot.page).toBe(1);
  // 4736286 sp is one inch from the left edge: 72 PDF points.
  expect(spot.x).toBeCloseTo(72, 1);
  expect(spot.y).toBeCloseTo(((9437184 - 655360) / 65536) * (72 / 72.27), 1);
  expect(forwardSearch(data, 'main.tex', 12)).toMatchObject({ page: 2 });
  expect(forwardSearch(data, 'other.tex', 1)).toBeNull();
  const lineTwo = (10223616 / 65536) * (72 / 72.27) - 2;
  expect(backwardSearch(data, 1, 100, lineTwo)).toEqual({ file: 'sections/intro.tex', line: 4 });
  expect(backwardSearch(data, 2, 90, 80)).toEqual({ file: 'main.tex', line: 15 });
  expect(backwardSearch(data, 3, 10, 10)).toBeNull();
});

it('finds the files a manuscript uses for its source package', () => {
  const texts = new Map([
    [
      'main.tex',
      String.raw`\documentclass{neurips}
\usepackage{graphicx}
\graphicspath{{figures/}}
\input{sections/intro}
\include{sections/method.tex}
% \input{sections/old}
\includegraphics[width=\linewidth]{plot}
\includegraphics{assets/logo.png}
\lstinputlisting[language=Python]{code/train.py}
\bibliographystyle{plainnat}
\bibliography{refs,extra}`,
    ],
    ['sections/intro.tex', String.raw`\input sections/table`],
    ['sections/method.tex', String.raw`\subimport{parts/}{appendix}`],
    ['sections/table.tex', ''],
    ['sections/parts/appendix.tex', String.raw`\includegraphics{diagram}`],
    ['sections/old.tex', ''],
  ]);
  const paths = [
    ...texts.keys(),
    'figures/plot.pdf',
    'figures/diagram.png',
    'figures/unused.png',
    'assets/logo.png',
    'code/train.py',
    'refs.bib',
    'notes.bib',
    'neurips.sty',
    'plainnat.bst',
    'main.bbl',
    'README.md',
  ];
  expect([...dependencies('main.tex', texts, paths)].sort()).toEqual([
    'assets/logo.png',
    'code/train.py',
    'figures/diagram.png',
    'figures/plot.pdf',
    'main.bbl',
    'main.tex',
    'neurips.sty',
    'plainnat.bst',
    'refs.bib',
    'sections/intro.tex',
    'sections/method.tex',
    'sections/parts/appendix.tex',
    'sections/table.tex',
  ]);
  expect(isArtifact('main.aux')).toBe(true);
  expect(isArtifact('build/main.synctex.gz')).toBe(true);
  expect(isArtifact('figures/.DS_Store')).toBe(true);
  expect(isArtifact('main.bbl')).toBe(false);
  expect(isArtifact('main.tex')).toBe(false);
});

it('recognises missing packages and an engine that could not download them', () => {
  expect(
    missingFiles(
      [
        "LaTeX Error: File `nicematrix.sty' not found.",
        "I can't find file `chapter3'.",
        'Font \\T1/ptm/m/n/10=ptmr8t at 10.0pt not loadable: Metric (TFM) file not found.',
        'Package fontspec Error: The font "Source Han Serif" cannot be found.',
        "LaTeX Error: File `nicematrix.sty' not found.",
      ].join('\n'),
    ),
  ).toEqual(['nicematrix.sty', 'chapter3', 'ptmr8t', 'Source Han Serif']);
  expect(missingFiles('! Undefined control sequence.')).toEqual([]);
  expect(
    networkFailure('error: error sending request for url (https://relay.fullyjustified.net)'),
  ).toBe(true);
  expect(networkFailure('dns error: No such host is known.')).toBe(true);
  expect(networkFailure("! LaTeX Error: File `x.sty' not found.")).toBe(false);
});

it('guesses the compiler an imported document needs', () => {
  expect(detectCompiler(String.raw`\documentclass{article}`)).toBe('pdflatex');
  expect(detectCompiler(String.raw`\documentclass[UTF8]{ctexart}`)).toBe('xelatex');
  expect(detectCompiler(String.raw`\usepackage[UTF8]{ctex}`)).toBe('xelatex');
  expect(detectCompiler(String.raw`\usepackage{amsmath,fontspec}`)).toBe('xelatex');
  expect(detectCompiler(String.raw`% \usepackage{fontspec}`)).toBe('pdflatex');
  expect(detectCompiler(String.raw`\usepackage{luacode}`)).toBe('lualatex');
  expect(detectCompiler(String.raw`\usepackage{fontspec}`, '$pdf_mode = 4;')).toBe('lualatex');
  expect(detectCompiler(String.raw`\usepackage{fontspec}`, '$pdf_mode = 1;')).toBe('pdflatex');
});
