// apps/web/src/components/Markdown.tsx
// A model's answer, rendered as what it was written as. The reading is
// lib/markdown.ts; this turns its tree into elements.
//
// Elements, never markup: nothing here takes a string of html, so a message
// cannot inject one however it is written. The only value that reaches an
// attribute is a link's href, and the parser has already refused every
// scheme but http, https and mailto — an unsafe one never becomes a link.
//
// Headings render as styled paragraphs rather than <h1>–<h6>. A heading
// inside one message of a conversation isn't a heading of the PAGE, and
// putting six levels of a model's own outline into the document's would
// leave a reader navigating by heading somewhere they didn't ask to be.
import type { ReactNode } from "react";
import { type Block, type Inline, parseBlocks } from "../lib/markdown";
import "./Markdown.css";

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          <code className="md-code" key={index}>
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{inline(node.children)}</strong>;
      case "em":
        return <em key={index}>{inline(node.children)}</em>;
      case "del":
        return <del key={index}>{inline(node.children)}</del>;
      case "link":
        // A link out of a message goes to another site by definition, so it
        // opens in its own tab — and noreferrer, because where a model's
        // link came from is nobody's business but this console's.
        return (
          <a className="md-link" href={node.href} target="_blank" rel="noreferrer" key={index}>
            {inline(node.children)}
          </a>
        );
    }
  });
}

function block(node: Block, key: number): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <p className="md-p" key={key}>
          {inline(node.content)}
        </p>
      );
    case "heading":
      return (
        <p className={`md-h md-h${node.level}`} key={key}>
          {inline(node.content)}
        </p>
      );
    case "code":
      return (
        <pre className="md-pre" key={key}>
          <code>{node.text}</code>
        </pre>
      );
    case "list": {
      const items = node.items.map((blocks, index) => (
        <li className="md-li" key={index}>
          {blocks.map(block)}
        </li>
      ));
      return node.ordered ? (
        <ol className="md-list" start={node.start} key={key}>
          {items}
        </ol>
      ) : (
        <ul className="md-list" key={key}>
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote className="md-quote" key={key}>
          {node.children.map(block)}
        </blockquote>
      );
    case "rule":
      return <hr className="md-rule" key={key} />;
  }
}

export function Markdown({ text }: { text: string }) {
  return <>{parseBlocks(text).map(block)}</>;
}
