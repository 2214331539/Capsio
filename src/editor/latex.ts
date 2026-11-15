import { StreamLanguage } from '@codemirror/language';
import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, showTooltip, ViewPlugin, type Tooltip } from '@codemirror/view';

type LatexState = { math: boolean; pending: 'env' | 'key' | null; argument: 'env' | 'key' | null };
const KEY_COMMANDS =
  /^\\(?:cite[a-zA-Z]*|nocite|ref|eqref|autoref|[cC]ref|pageref|nameref|label|input|include|includegraphics|bibliography|bibliographystyle|usepackage|documentclass)\*?/;

/** LaTeX highlighting: commands, environment names, keys and labels, math and comments. */
export const latexLanguage = StreamLanguage.define<LatexState>({
  name: 'latex',
  startState: () => ({ math: false, pending: null, argument: null }),
  token(stream, state) {
    if (state.argument) {
      const kind = state.argument;
      state.argument = null;
      if (stream.match(/^[^}\n]+/)) return kind === 'env' ? 'typeName' : 'string';
    }
    if (stream.match(/^%.*/)) return 'comment';
    if (stream.match(/^\\(?:begin|end)\b/)) {
      state.pending = 'env';
      return 'keyword';
    }
    if (stream.match(/^\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?/))
      return 'heading';
    if (stream.match(KEY_COMMANDS)) {
      state.pending = 'key';
      return 'keyword';
    }
    if (stream.match(/^\\[a-zA-Z@]+\*?/)) return 'keyword';
    if (stream.match(/^\\./)) return state.math ? 'number' : null;
    if (stream.match(/^\$\$?|^\\[[\]()]/)) {
      state.math = !state.math;
      return 'number';
    }
    if (state.pending && stream.peek() === '[') {
      stream.match(/^\[[^\]\n]*\]/);
      return null;
    }
    if (state.pending && stream.peek() === '{') {
      stream.next();
      state.argument = state.pending;
      state.pending = null;
      return null;
    }
    state.pending = null;
    stream.next();
    return state.math ? 'number' : null;
  },
  languageData: { commentTokens: { line: '%' } },
});

/** BibTeX highlighting: entry types, keys, field names and values. */
export const bibtexLanguage = StreamLanguage.define<{ key: boolean; depth: number }>({
  name: 'bibtex',
  startState: () => ({ key: false, depth: 0 }),
  token(stream, state) {
    if (state.depth === 0 && stream.match(/^%.*/)) return 'comment';
    if (state.depth === 0 && stream.match(/^@\w+/)) {
      state.key = true;
      return 'keyword';
    }
    if (state.key && stream.match(/^\s*[{(]\s*/)) return null;
    if (state.key && stream.match(/^[^,\s]+/)) {
      state.key = false;
      return 'typeName';
    }
    if (state.depth === 0 && stream.match(/^\s*\w+(?=\s*=)/)) return 'propertyName';
    if (stream.match(/^"[^"]*"/)) return 'string';
    if (stream.peek() === '{') {
      stream.next();
      state.depth++;
      return state.depth > 1 ? 'string' : null;
    }
    if (stream.peek() === '}') {
      stream.next();
      state.depth = Math.max(0, state.depth - 1);
      return state.depth > 0 ? 'string' : null;
    }
    stream.next();
    return state.depth > 1 ? 'string' : null;
  },
  languageData: { commentTokens: { line: '%' } },
});

/** What the completion list can offer, read fresh each time it opens. */
export type LatexSource = {
  labels(): string[];
  citations(): { key: string; detail?: string }[];
  files(kind: 'image' | 'tex'): string[];
};
type Option = { label: string; detail?: string; insert: string; cursor?: number };
type Completion = { from: number; to: number; options: Option[]; selected: number };

const COMMANDS: [string, string?][] = [
  ['section', '{}'],
  ['subsection', '{}'],
  ['subsubsection', '{}'],
  ['paragraph', '{}'],
  ['textbf', '{}'],
  ['textit', '{}'],
  ['emph', '{}'],
  ['texttt', '{}'],
  ['underline', '{}'],
  ['cite', '{}'],
  ['citep', '{}'],
  ['citet', '{}'],
  ['ref', '{}'],
  ['eqref', '{}'],
  ['autoref', '{}'],
  ['label', '{}'],
  ['footnote', '{}'],
  ['url', '{}'],
  ['href', '{}{}'],
  ['includegraphics', '[width=\\linewidth]{}'],
  ['caption', '{}'],
  ['centering'],
  ['begin', '{}'],
  ['end', '{}'],
  ['item'],
  ['input', '{}'],
  ['include', '{}'],
  ['usepackage', '{}'],
  ['documentclass', '{}'],
  ['title', '{}'],
  ['author', '{}'],
  ['maketitle'],
  ['bibliography', '{}'],
  ['bibliographystyle', '{}'],
  ['tableofcontents'],
  ['newcommand', '{}{}'],
  ['frac', '{}{}'],
  ['sqrt', '{}'],
  ['sum'],
  ['prod'],
  ['int'],
  ['mathbb', '{}'],
  ['mathcal', '{}'],
  ['mathrm', '{}'],
  ['text', '{}'],
  ['left'],
  ['right'],
  ['cdot'],
  ['times'],
  ['infty'],
  ['alpha'],
  ['beta'],
  ['gamma'],
  ['delta'],
  ['epsilon'],
  ['theta'],
  ['lambda'],
  ['mu'],
  ['sigma'],
  ['phi'],
  ['omega'],
  ['leq'],
  ['geq'],
  ['neq'],
  ['approx'],
  ['in'],
  ['rightarrow'],
  ['Rightarrow'],
  ['toprule'],
  ['midrule'],
  ['bottomrule'],
  ['hline'],
  ['newline'],
  ['noindent'],
  ['vspace', '{}'],
  ['hspace', '{}'],
  ['linewidth'],
  ['textwidth'],
];
const ENVIRONMENTS = [
  'figure',
  'figure*',
  'table',
  'table*',
  'tabular',
  'equation',
  'equation*',
  'align',
  'align*',
  'itemize',
  'enumerate',
  'description',
  'abstract',
  'center',
  'minipage',
  'quote',
  'verbatim',
  'theorem',
  'lemma',
  'proof',
  'definition',
  'algorithm',
  'algorithmic',
  'frame',
  'document',
];

const setCompletion = StateEffect.define<Completion | null>();
const completionField = StateField.define<Completion | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setCompletion)) return effect.value;
    if (!value) return value;
    if (transaction.docChanged)
      return {
        ...value,
        from: transaction.changes.mapPos(value.from),
        to: transaction.changes.mapPos(value.to),
      };
    return transaction.selection ? null : value;
  },
});

const rank = (options: Option[], prefix: string) => {
  const lower = prefix.toLowerCase();
  return options
    .filter((option) => option.label.toLowerCase().includes(lower))
    .sort(
      (a, b) =>
        Number(!b.label.toLowerCase().startsWith(lower)) -
          Number(!a.label.toLowerCase().startsWith(lower)) || a.label.localeCompare(b.label),
    )
    .slice(0, 50);
};

/** The completion that fits the text before the cursor, if any. */
export function completionAt(state: EditorState, source: LatexSource): Completion | null {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const before = state.sliceDoc(line.from, head);
  if (/(^|[^\\])%/.test(before)) return null;
  const argument = (pattern: RegExp) => {
    const match = pattern.exec(before);
    if (!match) return null;
    const text = match[match.length - 1];
    const token = text.split(',').at(-1)!.trimStart();
    return { from: head - token.length, token };
  };
  const make = (at: { from: number; token: string }, options: Option[]): Completion | null => {
    const ranked = rank(options, at.token);
    return ranked.length ? { from: at.from, to: head, options: ranked, selected: 0 } : null;
  };
  let at = argument(/\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/);
  if (at)
    return make(
      at,
      source
        .citations()
        .map((item) => ({ label: item.key, detail: item.detail, insert: item.key })),
    );
  at = argument(/\\(?:ref|eqref|autoref|[cC]ref|pageref|nameref)\{([^}]*)$/);
  if (at)
    return make(
      at,
      source.labels().map((label) => ({ label, insert: label })),
    );
  at = argument(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/);
  if (at)
    return make(
      at,
      source.files('image').map((path) => ({ label: path, insert: path })),
    );
  at = argument(/\\(?:input|include|subfile)\{([^}]*)$/);
  if (at)
    return make(
      at,
      source.files('tex').map((path) => ({ label: path, insert: path.replace(/\.tex$/, '') })),
    );
  const environment = /\\(begin|end)\{([a-zA-Z*]*)$/.exec(before);
  if (environment) {
    const after = state.sliceDoc(head, line.to);
    const closed = after.startsWith('}');
    const options = ENVIRONMENTS.map((name) =>
      environment[1] === 'begin' && !closed
        ? { label: name, insert: `${name}}\n  \n\\end{${name}}`, cursor: name.length + 4 }
        : { label: name, insert: closed ? name : `${name}}` },
    );
    return make({ from: head - environment[2].length, token: environment[2] }, options);
  }
  const command = /\\([a-zA-Z]+)$/.exec(before);
  if (command)
    return make(
      { from: head - command[1].length, token: command[1] },
      COMMANDS.map(([name, args]) => ({
        label: name,
        insert: name + (args ?? ''),
        cursor: args ? name.length + args.indexOf('{') + 1 : undefined,
      })),
    );
  return null;
}

function apply(view: EditorView, completion: Completion, option: Option) {
  view.dispatch({
    changes: { from: completion.from, to: completion.to, insert: option.insert },
    selection: { anchor: completion.from + (option.cursor ?? option.insert.length) },
    effects: setCompletion.of(null),
    userEvent: 'input.complete',
  });
  view.focus();
}

/** A small completion list for LaTeX, opened while typing and driven by the keyboard. */
export function latexCompletion(source: LatexSource): Extension {
  const watcher = ViewPlugin.fromClass(
    class {
      update(update: import('@codemirror/view').ViewUpdate) {
        const typed = update.transactions.some(
          (tr) => tr.isUserEvent('input.type') || tr.isUserEvent('delete.backward'),
        );
        if (!typed) return;
        const next = completionAt(update.state, source);
        queueMicrotask(() => update.view.dispatch({ effects: setCompletion.of(next) }));
      }
    },
  );
  const tooltip = showTooltip.compute([completionField], (state): Tooltip | null => {
    const completion = state.field(completionField);
    if (!completion) return null;
    return {
      pos: completion.from,
      above: false,
      create: (view) => {
        const dom = document.createElement('div');
        dom.className = 'sf-latex-completion';
        dom.setAttribute('role', 'listbox');
        completion.options.forEach((option, index) => {
          const item = document.createElement('div');
          item.className = 'sf-latex-option';
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', String(index === completion.selected));
          item.textContent = option.label;
          if (option.detail) {
            const detail = document.createElement('span');
            detail.textContent = option.detail;
            item.append(detail);
          }
          item.addEventListener('mousedown', (event) => {
            event.preventDefault();
            apply(view, completion, option);
          });
          dom.append(item);
        });
        queueMicrotask(() =>
          dom.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }),
        );
        return { dom };
      },
    };
  });
  const move = (step: number) => (view: EditorView) => {
    const completion = view.state.field(completionField);
    if (!completion) return false;
    const count = completion.options.length;
    view.dispatch({
      effects: setCompletion.of({
        ...completion,
        selected: (completion.selected + step + count) % count,
      }),
    });
    return true;
  };
  const accept = (view: EditorView) => {
    const completion = view.state.field(completionField);
    if (!completion) return false;
    apply(view, completion, completion.options[completion.selected]);
    return true;
  };
  return [
    completionField,
    watcher,
    tooltip,
    Prec.highest(
      keymap.of([
        { key: 'ArrowDown', run: move(1) },
        { key: 'ArrowUp', run: move(-1) },
        { key: 'Enter', run: accept },
        { key: 'Tab', run: accept },
        {
          key: 'Escape',
          run: (view) => {
            if (!view.state.field(completionField)) return false;
            view.dispatch({ effects: setCompletion.of(null) });
            return true;
          },
        },
      ]),
    ),
    EditorView.domEventHandlers({
      blur: (_event, view) => {
        if (view.state.field(completionField)) view.dispatch({ effects: setCompletion.of(null) });
      },
    }),
  ];
}
