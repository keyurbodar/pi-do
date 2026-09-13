// components/chat/MessageControls.tsx — hover toolbar on every bubble:
// react (smiley opening a base-ui Menu with the six akeru emoji), reply
// (quote icon arming the composer reply strip), and more (overflow Menu with
// copy + download-transcript-bit). Pattern follows akeru's MessageControls.
import { Menu } from "@base-ui/react/menu";
import { Check, Copy, Download, Ellipsis, Quote, Smile } from "lucide-react";

/** The six quick-reaction emoji offered by the react menu. */
export const MESSAGE_REACTION_OPTIONS: readonly string[] = ["👍", "👎", "❤️", "😂", "🎉", "😮"];

const iconButtonClass =
  "flex size-6 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70";

const menuPopupClass =
  "z-50 min-w-[10rem] rounded-[var(--control-radius)] border border-[var(--border)] bg-[var(--card)] p-1 shadow-[var(--shadow-float)]";

const menuItemClass =
  "flex w-full cursor-pointer items-center gap-2 rounded-[calc(var(--control-radius)-4px)] px-2.5 py-1.5 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:bg-[var(--accent)]";

export function MessageControls({
  messageId,
  onReact,
  onReply,
  onCopy,
  copied = false,
  onDownloadTranscript,
}: {
  messageId: string;
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  onCopy?: () => void;
  copied?: boolean;
  onDownloadTranscript?: () => void;
}) {
  return (
    <div
      data-testid={`message-actions-${messageId}`}
      className="absolute -top-3 right-1 z-10 flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--card)] p-0.5 opacity-0 shadow-[var(--shadow-float)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100"
    >
      <Menu.Root>
        <Menu.Trigger
          data-testid={`message-react-${messageId}`}
          aria-label="Add reaction"
          title="Add reaction"
          className={iconButtonClass}
        >
          <Smile aria-hidden className="size-3.5" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end">
            <Menu.Popup className={menuPopupClass} aria-label="Choose a reaction">
              <div className="flex items-center gap-0.5 p-1">
                {MESSAGE_REACTION_OPTIONS.map((emoji) => (
                  <Menu.Item
                    key={emoji}
                    data-testid={`message-react-option-${messageId}-${emoji}`}
                    aria-label={`React ${emoji}`}
                    onClick={() => onReact?.(emoji)}
                    className="flex size-8 cursor-pointer items-center justify-center rounded-full text-lg transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:bg-[var(--accent)]"
                  >
                    {emoji}
                  </Menu.Item>
                ))}
              </div>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <button
        type="button"
        data-testid={`message-reply-${messageId}`}
        aria-label="Reply to message"
        title="Reply to message"
        onClick={() => onReply?.()}
        className={iconButtonClass}
      >
        <Quote aria-hidden className="size-3.5" />
      </button>
      <Menu.Root>
        <Menu.Trigger
          data-testid={`message-more-${messageId}`}
          aria-label="More message actions"
          title="More message actions"
          className={iconButtonClass}
        >
          <Ellipsis aria-hidden className="size-3.5" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end">
            <Menu.Popup className={menuPopupClass} aria-label="More message actions">
              <Menu.Item
                data-testid={`message-copy-${messageId}`}
                onClick={() => onCopy?.()}
                className={menuItemClass}
              >
                {copied ? (
                  <Check aria-hidden className="size-3.5" />
                ) : (
                  <Copy aria-hidden className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </Menu.Item>
              <Menu.Item
                data-testid={`message-download-${messageId}`}
                onClick={() => onDownloadTranscript?.()}
                className={menuItemClass}
              >
                <Download aria-hidden className="size-3.5" />
                Download transcript
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
