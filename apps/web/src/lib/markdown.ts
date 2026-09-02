// apps/web/src/lib/markdown.ts
// Markdown as far as a model writes it, parsed to a tree the renderer turns
// into elements (components/Markdown.tsx).
//
// Hand-rolled, because the console has no runtime dependency but React and a
// parser is not where that should change: what an assistant turn actually
// contains is code fences, inline code, bold, lists, headings and links, and
// that is what this reads. What it doesn't recognise stays as the text it
// was — an unclosed fence, a table, raw html — so nothing is ever swallowed.
//
// It emits a TREE, never a string of html, which is what makes rendering
// model output safe: the renderer builds elements from these nodes, so there
// is no markup for a message to inject. The one place a message could still
// reach the browser is a link's href, and that is filtered here (see safe).
//
// Two deliberate omissions:
// - `_` is not emphasis. snake_case is everywhere in a console, and
//   `some_var_name` reading as "some<em>var</em>name" is worse than a rare
//   underscore italic going unrendered. `*` and `**` are what models write.
// - A single newline inside a paragraph stays a line break, as it does on
//   GitHub: in a chat, a model that wrote two lines meant two lines.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "paragraph"; content: Inline[] }
  | { type: "heading"; level: number; content: Inline[] }
  | { type: "code"; language?: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "quote"; children: Block[] }
  | { type: "rule" };

// --- inline ---

/**
 * A url this console is willing to make clickable. Anything else — a
 * `javascript:` scheme most of all — is not a link at all; the caller keeps
 * the markdown as literal text, so the reader sees exactly what the model
 * wrote and nothing is hidden behind a label.
 */
function safe(href: string): string | undefined {
  const url = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : undefined;
}

const text = (value: string): Inline => ({ type: "text", text: value });

/** Each spelling this reads, in the order a tie at the same position is
 *  settled: code before anything (its content is literal), and `**` before
 *  `*` so bold isn't read as an italic wrapping an asterisk. */
const INLINE: Array<{ re: RegExp; build: (m: RegExpExecArray) => Inline }> = [
  { re: /`([^`\n]+)`/, build: (m) => ({ type: "code", text: m[1] }) },
  {
    re: /\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"\n]*")?\)/,
    build: (m) => {
      const href = safe(m[2]);
      return href === undefined ? text(m[0]) : { type: "link", href, children: parseInline(m[1]) };
    },
  },
  { re: /\*\*(\S[^\n]*?)\*\*/, build: (m) => ({ type: "strong", children: parseInline(m[1]) }) },
  { re: /\*(\S[^\n]*?)\*/, build: (m) => ({ type: "em", children: parseInline(m[1]) }) },
  // Its own node, not an em: ~~x~~ means deleted, and rendering it as
  // italics would state the opposite of what the model wrote.
  { re: /~~(\S[^\n]*?)~~/, build: (m) => ({ type: "del", children: parseInline(m[1]) }) },
];

/** One run of text, split at whichever spelling starts earliest. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let rest = source;
  while (rest !== "") {
    let best: { at: number; length: number; node: Inline } | undefined;
    for (const matcher of INLINE) {
      const match = matcher.re.exec(rest);
      // `>=` rather than `>`: a tie goes to the matcher listed first, which
      // is what keeps `**` from being read as `*`.
      if (match === null || (best !== undefined && match.index >= best.at)) continue;
      best = { at: match.index, length: match[0].length, node: matcher.build(match) };
    }
    if (best === undefined) {
      out.push(text(rest));
      break;
    }
    if (best.at > 0) out.push(text(rest.slice(0, best.at)));
    out.push(best.node);
    rest = rest.slice(best.at + best.length);
  }
  return out;
}

// --- blocks ---

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]+)?\s*$/;
// The closing run of #s is optional AND must be separated from the text:
// without that `# C#` reads as a heading called "C", and a console that
// renames a language is worse than one that leaves a stray hash.
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^(\s*)[-*+][ \t]+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/;

/** Whether a line ends the paragraph it follows by starting something else. */
function starts(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

/** How far in a list item's own content sits: past the marker and its one
 *  space, which is what a continuation line is indented by. */
const contentIndent = (indent: string, marker: string) => indent.length + marker.length + 1;

/** A continuation line, with the item's indentation taken off — no more than
 *  that, so a code block indented inside an item keeps its own. */
const dedent = (line: string, by: number) => {
  const lead = line.length - line.trimStart().length;
  return line.slice(Math.min(lead, by));
};

/**
 * How far into the line its first non-space character sits, in COLUMNS — a
 * tab is one character but advances to the next four-column stop, so
 * counting characters would read a tab-indented line as barely indented at
 * all.
 */
function indentOf(line: string): number {
  let column = 0;
  for (const glyph of line) {
    if (glyph === " ") column += 1;
    else if (glyph === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

/**
 * Whether a line closes a fence opened with `length` of `char`.
 *
 * The length matters: a four-backtick fence is how a model quotes a
 * three-backtick example, so a closer must be at least as long as its
 * opener. So does "nothing else on the line" — an inner ```js is an opening
 * fence in someone else's code block, not the end of this one — and so does
 * how far in it sits.
 */
function closesFence(line: string, char: string, length: number): boolean {
  // Three columns of indent at most, the same bound the opener has: a fence
  // indented further is a line of the block, not the end of it — which is
  // exactly how a model writes a fenced example inside a list item.
  if (indentOf(line) > 3) return false;
  const marker = line.trim();
  if (marker.length < length) return false;
  for (const glyph of marker) {
    if (glyph !== char) return false;
  }
  return true;
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    // A fence runs to its closing marker OR to the end of the text: a model
    // still streaming has an open one, and the code inside it is worth
    // showing before it closes.
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i], fence[1][0], fence[1].length)) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", language: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        content: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const inner = QUOTE.exec(lines[i]);
        if (inner === null) break;
        quoted.push(inner[1]);
        i++;
      }
      blocks.push({ type: "quote", children: parseBlocks(quoted.join("\n")) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const first = ordered ?? bullet;
      if (first === null) continue; // unreachable; narrows for the compiler
      const base = first[1].length;
      const items: string[][] = [];
      let item: string[] | undefined;

      while (i < lines.length) {
        const current = lines[i];
        const next = isOrdered ? ORDERED.exec(current) : BULLET.exec(current);
        // A marker no deeper than the list's own indent is the NEXT item;
        // one deeper belongs to the item open now, and is parsed as part of
        // it — which is where a nested list comes from.
        if (next !== null && next[1].length <= base + 1) {
          item = [isOrdered ? next[3] : next[2]];
          items.push(item);
          i++;
          continue;
        }
        if (item === undefined) break;
        if (current.trim() === "") {
          // A blank line ends the list unless what follows is still indented
          // under the item — a second paragraph, or a nested block.
          const after = lines[i + 1];
          if (after === undefined || after.trim() === "" || after.search(/\S/) <= base) break;
          item.push("");
          i++;
          continue;
        }
        // A line at the list's own indent that is not a marker has left the
        // item; anything further in is still inside it.
        if (current.search(/\S/) <= base) break;
        item.push(dedent(current, contentIndent(first[1], isOrdered ? `${first[2]}.` : "-")));
        i++;
      }

      blocks.push({
        type: "list",
        ordered: isOrdered,
        start: isOrdered ? Number(first[2]) : 1,
        items: items.map((lines) => parseBlocks(lines.join("\n"))),
      });
      continue;
    }

    // Whatever is left is a paragraph, running to the blank line or the
    // block that interrupts it.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !(paragraph.length > 0 && starts(lines[i]))
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", content: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}
