// Synara-pattern tool trace (refs/synara apps/web chat/): while the turn
// runs, each call is an individually visible row the moment it starts
// (verbal label + mono target + spinner); when the turn settles, runs of 2+
// fold into one verbal summary line ("Ran 2 commands, Edited 2 files") that
// expands back to the rows — toolCallGroup.logic.ts summarizeToolCallGroup.
// File tools show their end output directly (auto-expanded, height-capped);
// write/edit show the written content. Group with a running call never
// presents as settled.
import { useState } from "react";
import { Check, ChevronDown, FileText, Pencil, Search, Terminal } from "lucide-react";
import type { ToolCallView } from "../thread/types";
import { CodeBlock } from "./CodeBlock";
import styles from "./ToolChips.module.css";

type Category = "command" | "edit" | "read" | "search";

function argsRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function pathOf(call: ToolCallView): string {
  const args = argsRecord(call.args);
  return typeof args["path"] === "string" ? args["path"] : "";
}

function targetOf(call: ToolCallView): string {
  const args = argsRecord(call.args);
  if (typeof args["path"] === "string" && args["path"].length > 0) return args["path"];
  if (call.tool === "bash" && typeof args["command"] === "string") {
    return args["command"].replace(/\s+/g, " ").trim().slice(0, 60);
  }
  if ((call.tool === "grep" || call.tool === "find") && typeof args["pattern"] === "string") {
    return args["pattern"];
  }
  return "";
}

function categoryOf(call: ToolCallView): Category {
  if (call.tool === "bash") return "command";
  if (call.tool === "write" || call.tool === "edit") return "edit";
  if (call.tool === "read") return "read";
  return "search";
}

/** Synara summaryPartLabel: "Ran 2 commands, Edited 2 files, Read 1 file". */
function groupLabel(calls: ToolCallView[]): string {
  const counts = new Map<Category, Set<string>>();
  for (const call of calls) {
    const category = categoryOf(call);
    const keys = counts.get(category) ?? counts.set(category, new Set()).get(category)!;
    keys.add(pathOf(call) || targetOf(call) || call.id);
  }
  const n = (c: Category) => counts.get(c)?.size ?? 0;
  const files = (label: string, c: Category) => {
    const k = n(c);
    return `${label} ${k} file${k === 1 ? "" : "s"}`;
  };
  const parts: string[] = [];
  if (n("command") > 0) {
    const k = n("command");
    parts.push(`Ran ${k} command${k === 1 ? "" : "s"}`);
  }
  if (n("edit") > 0) parts.push(files("Edited", "edit"));
  if (n("read") > 0) parts.push(files("Read", "read"));
  if (n("search") > 0) parts.push(files("Searched", "search"));
  return parts.join(", ");
}

/* Verbal per-row labels (synara deriveReadableCommandDisplay): running form
   while in flight, past form once done. */
function rowLabel(call: ToolCallView): string {
  const done = call.done;
  switch (call.tool) {
    case "read":
      return done ? "Read" : "Reading";
    case "write":
      return done ? "Created" : "Creating";
    case "edit":
      return done ? "Edited" : "Editing";
    case "ls":
    case "list":
      return done ? "Listed" : "Listing";
    case "find":
    case "grep":
      return done ? "Searched" : "Searching";
    case "bash":
      return done ? "Ran" : "Running";
    default:
      return call.tool;
  }
}

/** File tools: read/ls/list/find/grep reveal the tool output directly;
 * write/edit reveal what was written (args.content). */
const FILE_TOOLS = new Set(["read", "ls", "list", "find", "grep"]);

function detailOf(call: ToolCallView): string | null {
  const args = argsRecord(call.args);
  if ((call.tool === "write" || call.tool === "edit") && typeof args["content"] === "string") {
    return args["content"];
  }
  if (FILE_TOOLS.has(call.tool) || call.tool === "bash") {
    return typeof call.output === "string" && call.output.length > 0 ? call.output : null;
  }
  return null;
}

/** Highlight language for the detail view: the file's extension when the
 * call is path-bound, else the tool name (CodeBlock 18 tints any label). */
function detailLang(call: ToolCallView): string {
  const path = pathOf(call);
  const dot = path.lastIndexOf(".");
  if (dot >= 0 && dot < path.length - 1) return path.slice(dot + 1);
  return call.tool;
}

const AUTO_EXPAND = new Set(["read", "write", "edit", "ls", "list", "find", "grep"]);

function ToolIcon({ tool }: { tool: string }) {
  if (tool === "read") return <FileText size={13} aria-hidden="true" />;
  if (tool === "write" || tool === "edit") return <Pencil size={13} aria-hidden="true" />;
  if (tool === "bash") return <Terminal size={13} aria-hidden="true" />;
  return <Search size={13} aria-hidden="true" />;
}

function CallRow({ call }: { call: ToolCallView }) {
  // null = no user choice yet: file tools auto-expand their output once done.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const detail = detailOf(call);
  const expanded = toggled ?? (call.done && detail !== null && AUTO_EXPAND.has(call.tool));
  const target = targetOf(call);
  const hasDetail = detail !== null;
  return (
    <div className={styles.rowWrap}>
      <button
        type="button"
        className={styles.row}
        onClick={hasDetail ? () => setToggled(!expanded) : undefined}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <span className={styles.iconSlot}>
          <ToolIcon tool={call.tool} />
        </span>
        <span className={styles.rowLabel}>{rowLabel(call)}</span>
        {target.length > 0 && <span className={styles.rowTarget}>{target}</span>}
        {call.done ? (
          <span className={styles.rowDone}>
            <Check size={12} aria-hidden="true" />
          </span>
        ) : (
          <span className={styles.rowSpinner} aria-label="running" />
        )}
      </button>
      {hasDetail && (
        <div className={styles.detail + (expanded ? "" : ` ${styles.detailClosed}`)}>
          <div className={styles.detailInner}>
            <div className={styles.detailBody}>
              <CodeBlock code={detail} lang={detailLang(call)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ToolChips({ calls, streaming }: { calls: ToolCallView[]; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const anyRunning = streaming || calls.some((c) => !c.done);
  // Synara: individual rows while anything runs; a settled run of 2+ folds
  // into the verbal summary. A single settled row stays visible as-is.
  const batch = !anyRunning && calls.length >= 2;

  if (!batch) {
    return (
      <div className={styles.tools}>
        {calls.map((call) => (
          <CallRow key={call.id} call={call} />
        ))}
      </div>
    );
  }
  return (
    <div className={styles.tools}>
      <button
        type="button"
        className={styles.head}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.spark}>
          <ToolIcon tool={calls[0]?.tool ?? ""} />
        </span>
        <span className={styles.headLabel}>{groupLabel(calls)}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={open ? styles.chevronOpen : styles.chevron}
        />
      </button>
      <div className={styles.collapsible + (open ? "" : ` ${styles.collapsibleClosed}`)}>
        <div className={styles.collapsibleInner}>
          <div className={styles.rows}>
            {calls.map((call) => (
              <CallRow key={call.id} call={call} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
