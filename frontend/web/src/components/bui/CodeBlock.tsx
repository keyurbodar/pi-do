// Port of the beautiful-ui CodeBlock primitive (18) — Code and Diff variants.
// Header (file icon + lang + copy), line numbers with gutter rule, regex
// syntax tinting (strings/numbers orange, keywords accent, calls bold ink),
// and the diff view: tinted rows, accent bar (hatched for dels), word-level
// changed pieces. parseDiff moves here from thread/CodeBlock (same DiffRow
// shape upstream's diff variant consumes). No highlighter dependency.
import { useState } from "react";
import { Check, Copy, FileCode2 } from "lucide-react";
import styles from "./CodeBlock.module.css";

/** A single run of code within a diff row; `change` tints it as an add/del. */
export type CodePiece = { text: string; change?: "add" | "del" };

/** One row of a unified diff: old/new line numbers, its kind, and its pieces. */
export type DiffRow = {
  old: number | null;
  cur: number | null;
  type: "ctx" | "add" | "del";
  pieces: CodePiece[];
};

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string, prefix: number): number {
  let i = 0;
  while (
    i < a.length - prefix &&
    i < b.length - prefix &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i++;
  }
  return i;
}

/** Split a paired del/add body into shared ctx + changed middle pieces. */
function pairPieces(delBody: string, addBody: string): { del: CodePiece[]; add: CodePiece[] } {
  const prefix = commonPrefix(delBody, addBody);
  const suffix = commonSuffix(delBody, addBody, prefix);
  const delMid = delBody.slice(prefix, delBody.length - suffix);
  const addMid = addBody.slice(prefix, addBody.length - suffix);
  const head = delBody.slice(0, prefix);
  const tail = suffix > 0 ? delBody.slice(delBody.length - suffix) : "";
  if (delMid.length === 0 && addMid.length === 0) return { del: [{ text: delBody }], add: [{ text: addBody }] };
  // Whole-line rewrite with no shared edge: keep single-tint rows instead of
  // marking every character changed.
  if (head.length === 0 && tail.length === 0) {
    return { del: [{ text: delBody, change: "del" }], add: [{ text: addBody, change: "add" }] };
  }
  const del: CodePiece[] = [];
  const add: CodePiece[] = [];
  if (head.length > 0) {
    del.push({ text: head });
    add.push({ text: head });
  }
  if (delMid.length > 0) del.push({ text: delMid, change: "del" });
  if (addMid.length > 0) add.push({ text: addMid, change: "add" });
  if (tail.length > 0) {
    del.push({ text: tail });
    add.push({ text: tail });
  }
  return { del, add };
}

/**
 * Parse a unified-diff body into DiffRow entries with word-level pieces.
 * Returns null when the body is not a recognizable diff (caller falls back
 * to the plain view). Never throws.
 */
export function parseDiff(code: string): DiffRow[] | null {
  try {
    const lines = code.split("\n");
    const body = lines[0]?.startsWith("```") ? lines.slice(1) : lines;
    const rows: DiffRow[] = [];
    const dels: { old: number; body: string }[] = [];
    const adds: { cur: number; body: string }[] = [];
    let old = 1;
    let cur = 1;
    let seenSign = false;

    const flushPair = () => {
      const n = Math.min(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        const { del, add } = pairPieces(dels[i].body, adds[i].body);
        rows.push({ old: dels[i].old, cur: null, type: "del", pieces: del });
        rows.push({ old: null, cur: adds[i].cur, type: "add", pieces: add });
      }
      for (let i = n; i < dels.length; i++) {
        rows.push({ old: dels[i].old, cur: null, type: "del", pieces: [{ text: dels[i].body }] });
      }
      for (let i = n; i < adds.length; i++) {
        rows.push({ old: null, cur: adds[i].cur, type: "add", pieces: [{ text: adds[i].body }] });
      }
      dels.length = 0;
      adds.length = 0;
    };

    for (const line of body) {
      if (line.startsWith("@@")) {
        flushPair();
        const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) {
          old = Number(m[1]);
          cur = Number(m[2]);
        }
        rows.push({ old: null, cur: null, type: "ctx", pieces: [{ text: line }] });
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---")) {
        flushPair();
        rows.push({ old: null, cur: null, type: "ctx", pieces: [{ text: line }] });
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        seenSign = true;
        adds.push({ cur: cur++, body: line.slice(1) });
        continue;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        seenSign = true;
        dels.push({ old: old++, body: line.slice(1) });
        continue;
      }
      flushPair();
      rows.push({ old: old++, cur: cur++, type: "ctx", pieces: [{ text: line }] });
    }
    flushPair();
    if (!seenSign) return null;
    return rows;
  } catch {
    return null;
  }
}

/* Regex syntax tinting, verbatim token classes from upstream 18: strings and
   numbers → orange, keywords → accent, identifier-before-paren calls → ink. */
const TOKEN_RE =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined)\b|[A-Za-z_$][\w$]*(?=\s*\())/g;

const KEYWORDS = new Set([
  "import", "from", "export", "default", "async", "function", "const", "let",
  "var", "await", "return", "if", "else", "for", "while", "new", "throw",
  "try", "catch", "null", "true", "false", "undefined",
]);

function Highlighted({ line }: { line: string }) {
  const spans: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) spans.push(line.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) {
      spans.push(
        <span key={spans.length} className={styles.tokString}>
          {tok}
        </span>,
      );
    } else if (/^\d/.test(tok)) {
      spans.push(
        <span key={spans.length} className={styles.tokString}>
          {tok}
        </span>,
      );
    } else if (KEYWORDS.has(tok)) {
      spans.push(
        <span key={spans.length} className={styles.tokKeyword}>
          {tok}
        </span>,
      );
    } else {
      spans.push(
        <span key={spans.length} className={styles.tokCall}>
          {tok}
        </span>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < line.length) spans.push(line.slice(last));
  return <>{spans}</>;
}

function Pieces({ pieces }: { pieces: CodePiece[] }) {
  return (
    <>
      {pieces.map((p, i) =>
        p.change === "add" ? (
          <span key={i} className={styles.pieceAdd}>
            {p.text}
          </span>
        ) : p.change === "del" ? (
          <span key={i} className={styles.pieceDel}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const isDiff = lang.toLowerCase() === "diff";
  const label = lang.length > 0 ? lang : "code";
  const rows = isDiff ? parseDiff(code) : null;
  const copy = () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) return;
      navigator.clipboard.writeText(code).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }, () => {});
    } catch {
      return;
    }
  };
  return (
    <div className={styles.cb}>
      <div className={styles.head}>
        <span className={styles.fileWrap}>
          <FileCode2 size={15} className={styles.fileIcon} aria-hidden="true" />
          <span className={styles.fileName}>{label}</span>
        </span>
        <button type="button" className={styles.copy + (copied ? ` ${styles.copyDone}` : "")} onClick={copy} aria-label={copied ? "Copied" : "Copy code"}>
          {copied ? (
            <Check size={11} aria-hidden="true" />
          ) : (
            <Copy size={11} aria-hidden="true" />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {rows !== null ? (
        <div className={styles.body}>
          <span className={styles.gutterRule} aria-hidden="true" />
          {rows.map((row, i) => (
            <div
              key={i}
              className={
                row.type === "add"
                  ? `${styles.diffRow} ${styles.diffRowAdd}`
                  : row.type === "del"
                    ? `${styles.diffRow} ${styles.diffRowDel}`
                    : styles.diffRow
              }
            >
              {(row.type === "add" || row.type === "del") && (
                <span className={row.type === "add" ? styles.accentAdd : styles.accentDel} aria-hidden="true" />
              )}
              <span className={`${styles.ln} ${row.type === "add" ? styles.lnAdd : row.type === "del" ? styles.lnDel : ""}`}>
                {row.type === "del" ? (row.old ?? "") : (row.cur ?? "")}
              </span>
              <code className={styles.code}>
                <Pieces pieces={row.pieces} />
                {row.pieces.length === 1 && row.pieces[0].text.length === 0 ? " " : null}
              </code>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.body}>
          <span className={styles.gutterRule} aria-hidden="true" />
          {code.split("\n").map((line, i) => (
            <div className={styles.row} key={i}>
              <span className={styles.ln}>{i + 1}</span>
              <code className={styles.code}>
                {line.length > 0 ? <Highlighted line={line} /> : " "}
              </code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
