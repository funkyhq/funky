// Renders assistant message text as Markdown (GitHub-flavored: tables, lists,
// strikethrough, autolinks). react-markdown renders to React elements and does
// NOT render raw HTML, so model output can't inject markup — no XSS surface.
// Element styling lives under `.markdown` in styles.css.

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  // Links open in a new tab so following one never navigates away from the chat.
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
