// StreamText — port of the beautiful StreamText atom. Receives the FULL
// accumulated string from the parent — never per-token props.
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { TextResponse } from "../aicss";
import { CodeBlock } from "../bui";
import styles from "./TurnView.module.css";
import caretStyles from "./StreamText.module.css";

type Block = { kind: "prose"; text: string; start: number } | { kind: "code"; lang: string; code: string; start: number };

function splitFenced(text: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) blocks.push({ kind: "prose", text: text.slice(last, m.index), start: last });
    blocks.push({ kind: "code", lang: m[1] ?? "", code: (m[2] ?? "").replace(/\n$/, ""), start: m.index });
    last = m.index + m[0].length;
  }
  if (last < text.length) blocks.push({ kind: "prose", text: text.slice(last), start: last });
  if (blocks.length === 0) blocks.push({ kind: "prose", text, start: 0 });
  return blocks;
}

// One blank-line-delimited section of a prose block. Memoized on text so a
// streaming append re-parses only the tail section; earlier sections keep
// their ReactMarkdown output mounted.
const ProseSection = memo(function ProseSection({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

function splitSections(text: string): Array<{ text: string; start: number }> {
  const sections: Array<{ text: string; start: number }> = [];
  const re = /\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) sections.push({ text: text.slice(last, m.index), start: last });
    last = m.index + m[0].length;
  }
  if (last < text.length) sections.push({ text: text.slice(last), start: last });
  return sections;
}

function Prose({ text, start }: { text: string; start: number }) {
  // Trailing newlines render as blank paragraphs and read as spacing bugs;
  // they're never meaningful content, so drop them for display.
  const trimmed = text.replace(/\n+$/, "");
  const sections = useMemo(() => splitSections(trimmed), [trimmed]);
  return (
    <TextResponse>
      <div className={styles.prose}>
        {sections.map((section) => (
          <ProseSection key={`${start}:${section.start}`} text={section.text} />
        ))}
      </div>
    </TextResponse>
  );
}

export function StreamText({ text, streaming, caret = true }: { text: string; streaming: boolean; caret?: boolean }) {
  const visible = text;
  const blocks = useMemo(() => splitFenced(visible), [visible]);
  const showCaret = caret && streaming && !/\n$/.test(visible);
  return (
    <div className={styles.streamText}>
      {blocks.map((block) =>
        block.kind === "code" ? (
          <CodeBlock key={`code:${block.start}`} code={block.code} lang={block.lang} />
        ) : (
          <Prose key={`prose:${block.start}`} text={block.text} start={block.start} />
        ),
      )}
      {showCaret && <span aria-hidden="true" className={`${caretStyles["stream-caret"]} ${caretStyles["is-streaming"]}`} />}
    </div>
  );
}
