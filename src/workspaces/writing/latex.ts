import { t } from '../../i18n';

export type LogEntry = {
  kind: 'error' | 'warning' | 'box';
  /** Relative to the manuscript folder, when the log names the file. */
  file?: string;
  line?: number;
  message: string;
  detail?: string;
};

const SOURCE = /\.(?:tex|ltx|sty|cls|bbl|bib|clo|def|cfg|fd)$/i;

/** A path from a log or SyncTeX file, relative to the manuscript folder when it is inside it. */
export function sourcePath(path: string, root?: string) {
  let value = path
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\//, '');
  if (root) {
    const base = root
      .replace(/\\/g, '/')
      .replace(/^\/\/\?\//, '')
      .replace(/\/+$/, '');
    if (value.toLowerCase().startsWith(base.toLowerCase() + '/'))
      value = value.slice(base.length + 1);
  }
  while (value.startsWith('./')) value = value.slice(2);
  return value;
}

/** TeX wraps its log at 79 characters; joins those pieces back into whole lines. */
function logicalLines(log: string) {
  const lines: string[] = [];
  let carry = '';
  for (const raw of log.replace(/\r/g, '').split('\n')) {
    const joined = carry + raw;
    if (raw.length === 79) carry = joined;
    else {
      lines.push(joined);
      carry = '';
    }
  }
  if (carry) lines.push(carry);
  return lines;
}

const HINTS: [RegExp, string][] = [
  [/Undefined control sequence/i, '未定义的命令：检查拼写，或在导言区引入定义它的宏包。'],
  [/File `[^']+' not found/i, '找不到文件：检查文件名和路径，或宏包是否已安装。'],
  [/Missing \$ inserted/i, '数学符号写在了数学环境外，或 $ 不配对。'],
  [/Missing \\begin\{document\}/i, '正文写在了 \\begin{document} 之前，或导言区有多余的文字。'],
  [/\\begin\{([^}]*)\} .*ended by \\end/i, '环境的 \\begin 和 \\end 不配对。'],
  [/Emergency stop|Fatal error/i, '编译在这里停止了，先修正上面的第一个错误。'],
  [/Citation .* undefined/i, '参考文献里没有这个条目，或者需要再编译一次。'],
  [/Reference .* undefined/i, '没有找到这个 \\label，或者需要再编译一次。'],
  [
    /There were undefined references/i,
    '有未定义的引用，再编译一次通常就好；仍然存在时检查 \\label 和 \\cite。',
  ],
  [/Label .* multiply defined/i, '同一个 \\label 用了不止一次。'],
  [/Overfull \\hbox/i, '这一行太宽，超出了版心。可以改写句子，或允许断行。'],
  [/Underfull \\hbox/i, '这一行太松，单词间距被拉大了。'],
];
/** A short explanation for common messages, or nothing. */
export function hint(message: string) {
  const found = HINTS.find(([pattern]) => pattern.test(message));
  return found ? t(found[1]) : '';
}

/**
 * Errors, warnings and bad boxes from a LaTeX log (and from Tectonic's own output), each with
 * the file and line when the log says where. Files are tracked through TeX's "(file ... )" marks.
 */
export function parseLog(log: string, output = '', root?: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: LogEntry) => {
    const key = [entry.kind, entry.file, entry.line, entry.message].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  for (const line of output.replace(/\r/g, '').split('\n')) {
    const match = /^(error|warning): (?:(.+?):(\d+): )?(.+)$/.exec(line.trim());
    if (!match || /^(?:Halted|.*halted on potentially-recoverable error)/i.test(match[4])) continue;
    const kind =
      match[1] === 'error' ? 'error' : /full \\[hv]box/.test(match[4]) ? 'box' : 'warning';
    add({
      kind,
      file: match[2] ? sourcePath(match[2], root) : undefined,
      line: match[3] ? Number(match[3]) : undefined,
      message: match[4].replace(/^(?:LaTeX|Package \S+) Warning: /, ''),
    });
  }
  const lines = logicalLines(log);
  const stack: string[] = [];
  const current = () => stack.at(-1);
  const track = (text: string) => {
    const pattern =
      /\(([^()\s]*\.(?:tex|ltx|sty|cls|bbl|aux|clo|def|cfg|fd|toc|out|bib)\b)|\(|\)/gi;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) stack.push(sourcePath(match[1], root));
      else if (match[0] === '(') stack.push('');
      else stack.pop();
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const located = /^(.+?\.(?:tex|ltx|sty|cls|bbl)):(\d+): (.*)$/.exec(text);
    if (located && !/Warning:/.test(located[3])) {
      let detail = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        if (/^l\.\d+/.test(lines[j])) {
          detail = lines[j] + (lines[j + 1]?.trim() ? '\n' + lines[j + 1] : '');
          break;
        }
      }
      add({
        kind: 'error',
        file: sourcePath(located[1], root),
        line: Number(located[2]),
        message: located[3].replace(/^LaTeX Error: /, ''),
        detail: detail || undefined,
      });
      continue;
    }
    if (text.startsWith('! ')) {
      let line: number | undefined;
      let detail = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const at = /^l\.(\d+)/.exec(lines[j]);
        if (at) {
          line = Number(at[1]);
          detail = lines[j] + (lines[j + 1]?.trim() ? '\n' + lines[j + 1] : '');
          break;
        }
      }
      const file = current() || undefined;
      add({
        kind: 'error',
        file: file && SOURCE.test(file) ? file : undefined,
        line,
        message: text.slice(2).replace(/^LaTeX Error: /, ''),
        detail: detail || undefined,
      });
      continue;
    }
    const warning = /^(?:LaTeX|Package ([\w-]+)|Class ([\w-]+)|LaTeX Font) Warning: (.*)$/.exec(
      text,
    );
    if (warning) {
      const owner = warning[1] ?? warning[2];
      let message = warning[3];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() &&
        (owner ? lines[i + 1].startsWith(`(${owner})`) : /^\s{2,}/.test(lines[i + 1]))
      ) {
        i++;
        message += ' ' + lines[i].replace(/^\([\w-]+\)\s*/, '').trim();
      }
      const at = /on input line (\d+)\.?/.exec(message);
      const file = current() || undefined;
      add({
        kind: 'warning',
        file: file && SOURCE.test(file) ? file : undefined,
        line: at ? Number(at[1]) : undefined,
        message: message.replace(/\s*on input line \d+\.?/, '').trim(),
      });
      continue;
    }
    const box = /^((?:Over|Under)full \\[hv]box \([^)]*\)).*?(?:at lines? (\d+)(?:--\d+)?)?$/.exec(
      text,
    );
    if (box && /full \\[hv]box/.test(text)) {
      const file = current() || undefined;
      add({
        kind: 'box',
        file: file && SOURCE.test(file) ? file : undefined,
        line: box[2] ? Number(box[2]) : undefined,
        message: box[1],
      });
      continue;
    }
    track(text);
  }
  return entries;
}

export type OutlineItem = { level: number; title: string; line: number };
const LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};
/** Text up to the first unescaped %. */
const uncommented = (line: string) => line.replace(/(^|[^\\])%.*$/, '$1');

/** \section-like headings with their level and line, as Overleaf's file outline shows. */
export function outline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = uncommented(raw);
    const match =
      /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(
        line,
      );
    if (!match) return;
    let depth = 1;
    let title = '';
    for (const char of line.slice(match.index + match[0].length)) {
      if (char === '{') depth++;
      if (char === '}' && --depth === 0) break;
      title += char;
    }
    items.push({
      level: LEVELS[match[1]],
      title:
        title
          .replace(/\\[a-zA-Z]+\s*/g, '')
          .replace(/[{}]/g, '')
          .trim() || '…',
      line: index + 1,
    });
  });
  return items;
}

/** Roughly what texcount reports: words of running text plus CJK characters. */
export function countWords(text: string) {
  let body = text.split('\n').map(uncommented).join('\n');
  const start = body.indexOf('\\begin{document}');
  if (start >= 0) body = body.slice(start + '\\begin{document}'.length);
  body = body
    .replace(/\\end\{document\}[\s\S]*$/, '')
    .replace(
      /\\begin\{(equation|align|gather|multline|eqnarray|displaymath)\*?\}[\s\S]*?\\end\{\1\*?\}/g,
      ' ',
    )
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$]*\$|\\\([\s\S]*?\\\)/g, ' ')
    .replace(
      /\\(?:label|ref|eqref|autoref|cref|cite\w*|input|include|includegraphics|bibliography\w*|usepackage|documentclass|begin|end)\*?(?:\[[^\]]*\])*\{[^}]*\}(?:\[[^\]]*\])*/g,
      ' ',
    )
    // A command's optional argument (a short title, a placement) is not running text.
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}[\]&~\\]/g, ' ');
  const latin = body.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  const cjk = body.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  return latin + cjk;
}

/** \label{...} keys in a TeX file. */
export const labels = (text: string) =>
  [...text.matchAll(/\\label\{([^}]+)\}/g)].map((match) => match[1].trim());

/** Entry keys in a .bib file. */
export const bibKeys = (text: string) =>
  [...text.matchAll(/@(\w+)\s*[{(]\s*([^,\s]+)\s*,/g)]
    .filter((match) => !/^(?:string|comment|preamble)$/i.test(match[1]))
    .map((match) => match[2]);

/** Keys used by \cite-like commands, each with the line it first appears on. */
export function citations(text: string) {
  const found: { key: string; line: number }[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = uncommented(raw);
    for (const match of line.matchAll(/\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g))
      for (const key of match[1].split(',').map((k) => k.trim()))
        if (key && key !== '*') found.push({ key, line: index + 1 });
  });
  return found;
}

/** The main document of a folder: the .tex file with \documentclass, preferring main.tex. */
export function isMainDocument(text: string) {
  return text.split('\n').some((line) => /^\s*\\documentclass/.test(uncommented(line)));
}

/** Packages, classes and fonts TeX looked for and did not find, from log messages and output. */
export function missingFiles(text: string) {
  const found = new Set<string>();
  const pattern =
    /File `([^']+)' not found|I can't find file `([^']+)'|=(\S+?)(?: at \S+)? not loadable: Metric \(TFM\) file not found|The font "([^"]+)" cannot be found/g;
  for (const match of text.matchAll(pattern))
    found.add(match[1] ?? match[2] ?? match[3] ?? match[4]);
  return [...found];
}

/** Whether the bundled engine could not reach its package server. */
export function networkFailure(output: string) {
  return /error sending request|dns error|failed to lookup address|could not resolve|connection refused|connection reset|operation timed out|network is unreachable|no such host is known/i.test(
    output,
  );
}

/** The compiler a document most likely needs: XeLaTeX for fontspec and Chinese, LuaLaTeX for Lua. */
export function detectCompiler(text: string, latexmkrc = ''): 'pdflatex' | 'xelatex' | 'lualatex' {
  const mode = /\$pdf_mode\s*=\s*([145])/.exec(latexmkrc.split('\n').map(uncommented).join('\n'));
  if (mode) return mode[1] === '5' ? 'xelatex' : mode[1] === '4' ? 'lualatex' : 'pdflatex';
  const body = text.split('\n').map(uncommented).join('\n');
  const uses = (names: string) =>
    new RegExp(
      String.raw`\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:${names})\b`,
    ).test(body);
  if (uses('luatexja|luacode|luaotfload') || /\\directlua/.test(body)) return 'lualatex';
  if (
    uses('fontspec|xeCJK|ctex|unicode-math|polyglossia') ||
    /\\documentclass(?:\[[^\]]*\])?\{ctex/.test(body)
  )
    return 'xelatex';
  return 'pdflatex';
}

/** Styles, classes and bibliography styles in the folder; templates load them by name. */
const SUPPORT = /\.(?:cls|sty|clo|bst|bbx|cbx|dbx|lbx|cfg|def|fd)$/i;
const GRAPHICS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.ps', '.svg', '.gif', '.tif'];
/** What compiling and the system leave behind; it never goes into a source package. */
const ARTIFACT =
  /\.(?:aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex|synctex\.gz|bcf|blg|run\.xml|nav|snm|vrb|xdv|idx|ilg|ind|glg|glo|gls|ist|loa|spl)$|(?:^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
export const isArtifact = (path: string) => ARTIFACT.test(path);

const clean = (path: string) =>
  path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.\/)+/, '');

/**
 * The files the main document uses: what `\input` and `\include` reach, figures, listings,
 * bibliographies, and every local style, class and bibliography style. Paths are relative to
 * the manuscript folder, which is where LaTeX resolves them from.
 */
export function dependencies(main: string, texts: Map<string, string>, paths: string[]) {
  const have = new Map(paths.map((path) => [path.toLowerCase(), path]));
  const find = (candidates: string[]) =>
    candidates.map((path) => have.get(clean(path).toLowerCase())).find(Boolean);
  const used = new Set(paths.filter((path) => SUPPORT.test(path)));
  const add = (found: string | undefined) => found && used.add(found);
  const figures: string[] = [];
  const graphicspath = new Set(['']);
  const queue = [main];
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    used.add(file);
    const here = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    const body = (texts.get(file) ?? '').split('\n').map(uncommented).join('\n');
    const each = (pattern: string) =>
      [...body.matchAll(new RegExp(pattern, 'g'))].map((match) => clean(match[1]));
    const input = (name: string) => {
      const found = find(/\.tex$/i.test(name) ? [name] : [`${name}.tex`, name]);
      if (found && /\.(?:tex|ltx)$/i.test(found)) queue.push(found);
      else add(found);
    };
    each(String.raw`\\(?:input|include|subfile|InputIfFileExists)\*?\{([^}]+)\}`).forEach(input);
    each(String.raw`\\input\s+([^\s{}\\]+)`).forEach(input);
    for (const match of body.matchAll(
      /\\(sub)?(?:import|inputfrom|includefrom)\*?\{([^}]*)\}\{([^}]+)\}/g,
    ))
      input(clean(`${match[1] ? here : ''}${match[2]}/${match[3]}`));
    for (const match of body.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g))
      for (const dir of match[1].matchAll(/\{([^}]*)\}/g))
        graphicspath.add(clean(dir[1]) ? clean(dir[1]).replace(/\/?$/, '/') : '');
    figures.push(
      ...each(String.raw`\\(?:includegraphics|includepdf|includesvg)\*?(?:\[[^\]]*\])*\{([^}]+)\}`),
    );
    each(String.raw`\\(?:lstinputlisting|verbatiminput|VerbatimInput)(?:\[[^\]]*\])*\{([^}]+)\}`)
      .concat(each(String.raw`\\inputminted(?:\[[^\]]*\])?\{[^}]*\}\{([^}]+)\}`))
      .concat(each(String.raw`\\addbibresource(?:\[[^\]]*\])?\{([^}]+)\}`))
      .forEach((name) => add(find([name])));
    for (const list of each(String.raw`\\bibliography\{([^}]+)\}`))
      for (const name of list.split(',')) add(find([`${clean(name)}.bib`, clean(name)]));
  }
  for (const name of figures)
    add(find([...graphicspath].flatMap((dir) => GRAPHICS.map((ext) => dir + name + ext))));
  add(find([main.replace(/\.tex$/i, '.bbl')]));
  return used;
}
