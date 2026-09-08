import {
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import styles from "./PromptInput.module.css";

export type PromptInputProps = {
  // v1 wires to the session WS send path; keep send() clearing behavior.
  onSubmit?: (text: string) => void;
  // While a turn streams, the send button morphs into Stop (Square) and
  // fires onAbort instead — the only brake on a stuck turn.
  running?: boolean;
  onAbort?: () => void;
};

// Shape mirrors the vendored-library anatomy (visuals only, no lib deps in
// web — every utility/animation is CSS Modules on theme.css vars):
// frame+field ≈ ai-elements PromptInput; row ≈ PromptInputFooter / chat-03
// footer (Tools left + actions right); plus ≈ ui-components actions-popover
// trigger (Plus + rotate + menu shell, still non-functional as today);
// send ≈ ui-components send/stop Button; running morph ≈ blocks
// PromptInputSubmit status ("streaming" → Square) on our running/onAbort
// contract. v1 defers: slash/skills palette, plus menu, models,
// attachments.
export function PromptInput({ onSubmit, running = false, onAbort }: PromptInputProps = {}) {
  // `value` mirrors the editor's plain text; it drives the
  // empty/placeholder + send logic.
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);

  const hasText = value.trim().length > 0;

  const syncFromEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    setValue(editor.textContent ?? "");
  };

  const onEditorInput = () => {
    syncFromEditor();
  };

  const onEditorKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      const native = e.nativeEvent;
      if (native.isComposing || native.keyCode === 229) return;
      e.preventDefault();
      send();
    }
  };

  const onEditorPaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const doc = editorRef.current?.ownerDocument ?? document;
    if (!doc.execCommand("insertText", false, text)) {
      const sel = doc.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(doc.createTextNode(text));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    syncFromEditor();
  };

  const send = () => {
    const text = value.trim();
    if (!text) return;
    const editor = editorRef.current;
    if (editor) editor.innerHTML = "";
    setValue("");
    onSubmit?.(text);
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.frame}>
        <div className={styles.editorWrap}>
          <div
            ref={editorRef}
            className={styles.field}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Ask AI Agent"
            data-empty={(!hasText && !focused) || undefined}
            data-placeholder="Ask AI Agent"
            onInput={onEditorInput}
            onKeyDown={onEditorKeyDown}
            onPaste={onEditorPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </div>

        <div className={[styles.row, styles.footer].join(" ")}>
          <div className={[styles.plusWrap, styles.tools].join(" ")}>
            <button
              type="button"
              className={[styles.iconBtn, styles.plus, styles.actionTrigger].join(" ")}
              aria-label="Add attachment or switch model"
              title="Attachments and models are not available yet"
              disabled
            >
              <span className={styles.plusIcon}>
                <Plus size={16} />
              </span>
            </button>
          </div>

          <div className={[styles.right, styles.actions].join(" ")}>
            <button
              type="button"
              className={[styles.iconBtn, styles.send, styles.submit, (hasText || running) && styles.sendActive]
                .filter(Boolean)
                .join(" ")}
              data-status={running ? "streaming" : "ready"}
              aria-label={running ? "Stop" : "Send"}
              disabled={!hasText && !running}
              onClick={running ? onAbort : send}
            >
              {running ? <Square size={12} fill="currentColor" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
