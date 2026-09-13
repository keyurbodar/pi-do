// components/chat/ChatMarkdown.tsx — markdown for chat bubbles, using the
// existing react-markdown + remark-gfm + remark-breaks setup (same plugins
// as thread/StreamText). Styling is scoped to this container so composer and
// thread markdown stay independent.
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="block w-full min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere] [word-break:break-word] [&_a]:text-[var(--info-foreground)] [&_a]:underline [&_a]:underline-offset-2 [&_a]:[overflow-wrap:anywhere] [&_code]:rounded [&_code]:bg-[var(--code-background)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:[overflow-wrap:anywhere] [&_h1,h2,h3]:mb-1 [&_h1,h2,h3]:mt-2 [&_h1,h2,h3]:text-base [&_h1,h2,h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--code-background)] [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[0.85em] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:[overflow-wrap:normal] [&_pre_code]:[word-break:normal] [&_strong]:font-semibold [&_table]:my-1 [&_table]:w-full [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          // Scroll container so wide tables scroll internally instead of
          // widening the bubble; the table itself never forces min-content width.
          table: ({ children }) => (
            <div className="block w-full max-w-full overflow-x-auto">
              <table className="my-1 w-full">{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
