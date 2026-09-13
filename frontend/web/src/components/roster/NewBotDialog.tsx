// Bot creation dialog, ported from akeru's NewBotDialog.tsx (MIT): name plus
// bloub identity pickers, extended fixture-local with persona, instructions,
// a model select, and a three-tab avatar picker (bloub pickers, image upload
import { useEffect, useRef, useState, type FormEvent } from "react";
import { BOT_MODELS, type BloubIdentity, type BotAvatarVariant, type BotModelId } from "../../lib/roster";
import BotAvatar from "./BotAvatar";
import { DialogShell } from "./DialogShell";
import { identiconDataUrl } from "./identicon";
import { BLOUB_COLORS, BLOUB_EXPRESSIONS, BLOUB_SHAPES, colorHex } from "./identity";
import { cn } from "./roster.logic";

const MAX_UPLOAD_BYTES = 200 * 1024;

export interface NewBotInput {
  name: string;
  identity: BloubIdentity;
  persona: string;
  instructions: string;
  modelId: BotModelId;
  avatarVariant: BotAvatarVariant;
  avatarImage?: string;
  identiconStyle: number;
}

type AvatarTab = "bloub" | "upload" | "identicon";

export function NewBotDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewBotInput) => void;
}) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");
  const [modelId, setModelId] = useState<BotModelId>("default");
  const [identity, setIdentity] = useState<BloubIdentity>(() => ({
    shape: "cercle",
    color: "bleu",
    expression: "neutre",
  }));
  const [avatarTab, setAvatarTab] = useState<AvatarTab>("bloub");
  const [avatarImage, setAvatarImage] = useState<string | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [identiconStyle, setIdenticonStyle] = useState(0);
  const objectUrlRef = useRef<string | null>(null);
  const trimmedName = name.trim();

  useEffect(() => {
    if (!open) return;
    setName("");
    setPersona("");
    setInstructions("");
    setModelId("default");
    setIdentity({ shape: "cercle", color: "bleu", expression: "neutre" });
    setAvatarTab("bloub");
    setAvatarImage(undefined);
    setUploadError(null);
    setIdenticonStyle(0);
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPreviewUrl(null);
  }, [open ]);

  useEffect(
    () => () => {
      if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError("Image must be under 200KB.");
      return;
    }
    setUploadError(null);
    if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current);
    const objectUrl = URL.createObjectURL(file);
    objectUrlRef.current = objectUrl;
    setPreviewUrl(objectUrl);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setAvatarImage(reader.result);
        setAvatarTab("upload");
      }
    };
    reader.onerror = () => setUploadError("Could not read that image.");
    reader.readAsDataURL(file);
  };

  const avatarVariant: BotAvatarVariant = avatarTab;
  const previewName = trimmedName.length > 0 ? trimmedName : "bot";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmedName.length === 0) return;
    onCreate({
      name: trimmedName,
      identity,
      persona: persona.trim(),
      instructions: instructions.trim(),
      modelId,
      avatarVariant,
      avatarImage: avatarVariant === "upload" ? avatarImage : undefined,
      identiconStyle,
    });
  };

  const tabs: readonly { id: AvatarTab; label: string; testId: string }[] = [
    { id: "bloub", label: "Bloub", testId: "avatar-tab-bloub" },
    { id: "upload", label: "Upload", testId: "avatar-tab-upload" },
    { id: "identicon", label: "Identicon", testId: "avatar-tab-identicon" },
  ];

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} testId="new-bot-dialog" labelledBy="new-bot-title">
      <form onSubmit={submit}>
        <header className="border-b px-6 py-5">
          <h2 id="new-bot-title" className="text-base font-semibold">
            New bot
          </h2>
        </header>

        <div className="max-h-[70vh] space-y-6 overflow-y-auto px-6 py-6">
          <div className="flex items-center gap-4">
            {avatarVariant === "upload" && (previewUrl !== null || avatarImage !== undefined) ? (
              <img
                src={previewUrl ?? avatarImage}
                alt=""
                data-testid="avatar-upload-preview"
                className="size-16 shrink-0 rounded-full object-cover"
              />
            ) : avatarVariant === "identicon" ? (
              <img
                src={identiconDataUrl(previewName, identiconStyle)}
                alt=""
                className="size-16 shrink-0 rounded-2xl"
              />
            ) : (
              <BotAvatar identity={identity} size={64} />
            )}
            <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium">
              Name
              <input
                autoFocus
                data-testid="new-bot-name-input"
                maxLength={80}
                placeholder="Bot name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-9 rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>

          <label className="flex flex-col gap-2 text-sm font-medium">
            Persona
            <textarea
              data-testid="new-bot-persona-input"
              value={persona}
              onChange={(event) => setPersona(event.target.value)}
              placeholder="How should this bot come across?"
              rows={2}
              className="min-h-16 rounded-md border border-input bg-input px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <label className="flex flex-col gap-2 text-sm font-medium">
            Instructions
            <textarea
              data-testid="new-bot-instructions-input"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="What should this bot always do?"
              rows={3}
              className="min-h-20 rounded-md border border-input bg-input px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <label className="flex flex-col gap-2 text-sm font-medium">
            Model
            <select
              data-testid="new-bot-model-select"
              value={modelId}
              onChange={(event) => setModelId(event.target.value as BotModelId)}
              className="h-9 cursor-pointer rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {BOT_MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <section aria-label="Avatar picker" className="space-y-3 border-t pt-5">
            <h3 className="text-sm font-medium">Avatar</h3>
            <div role="tablist" aria-label="Avatar source" className="flex gap-1 rounded-lg bg-muted p-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={avatarTab === tab.id}
                  data-testid={tab.testId}
                  onClick={() => setAvatarTab(tab.id)}
                  className={cn(
                    "flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    avatarTab === tab.id ? "bg-popover shadow" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {avatarTab === "bloub" ? (
              <div className="space-y-5">
                <section aria-labelledby="new-bot-shape-heading" className="space-y-3">
                  <h4 id="new-bot-shape-heading" className="text-sm font-medium">
                    Shape
                  </h4>
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                    {BLOUB_SHAPES.map((shape) => {
                      const selected = identity.shape === shape;
                      return (
                        <button
                          key={shape}
                          type="button"
                          aria-label={shape}
                          aria-pressed={selected}
                          data-testid={`new-bot-shape-${shape}`}
                          onClick={() => setIdentity((prev) => ({ ...prev, shape }))}
                          className={cn(
                            "flex aspect-square cursor-pointer items-center justify-center rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            selected ? "border-border bg-accent" : "border-transparent hover:bg-accent/60",
                          )}
                        >
                          <BotAvatar
                            identity={{ ...identity, shape }}
                            size={36}
                          />
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section aria-labelledby="new-bot-color-heading" className="space-y-3">
                  <h4 id="new-bot-color-heading" className="text-sm font-medium">
                    Color
                  </h4>
                  <div className="flex flex-wrap gap-2.5">
                    {BLOUB_COLORS.map((color) => {
                      const selected = identity.color === color;
                      return (
                        <button
                          key={color}
                          type="button"
                          aria-label={color}
                          aria-pressed={selected}
                          data-testid={`new-bot-color-${color}`}
                          title={color}
                          onClick={() => setIdentity((prev) => ({ ...prev, color }))}
                          style={{ backgroundColor: colorHex(color) }}
                          className={cn(
                            "size-8 cursor-pointer rounded-full border border-white/10 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selected && "ring-2 ring-ring ring-offset-2 ring-offset-popover",
                          )}
                        />
                      );
                    })}
                  </div>
                </section>

                <section aria-labelledby="new-bot-expression-heading" className="space-y-3">
                  <h4 id="new-bot-expression-heading" className="text-sm font-medium">
                    Expression
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {BLOUB_EXPRESSIONS.map((expression) => {
                      const selected = identity.expression === expression;
                      return (
                        <button
                          key={expression}
                          type="button"
                          aria-pressed={selected}
                          data-testid={`new-bot-expression-${expression}`}
                          onClick={() => setIdentity((prev) => ({ ...prev, expression }))}
                          className={cn(
                            "cursor-pointer rounded-full border px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border text-muted-foreground hover:bg-accent",
                          )}
                        >
                          {expression}
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            ) : null}

            {avatarTab === "upload" ? (
              <div className="space-y-3">
                <input
                  type="file"
                  accept="image/*"
                  data-testid="avatar-upload-input"
                  onChange={(event) => handleFile(event.target.files?.[0])}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:text-sm file:font-medium"
                />
                {previewUrl !== null || avatarImage !== undefined ? (
                  <img
                    src={previewUrl ?? avatarImage}
                    alt="Upload preview"
                    data-testid="avatar-upload-preview"
                    className="size-20 rounded-xl border border-border object-cover"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Choose an image to preview it here.</p>
                )}
                {uploadError !== null ? (
                  <p data-testid="avatar-upload-error" role="alert" className="text-xs text-destructive">
                    {uploadError}
                  </p>
                ) : null}
              </div>
            ) : null}

            {avatarTab === "identicon" ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Deterministic identicon from the bot name — pick a style.
                </p>
                <div className="flex gap-3">
                  {[0, 1, 2].map((variant) => {
                    const selected = identiconStyle === variant;
                    return (
                      <button
                        key={variant}
                        type="button"
                        aria-pressed={selected}
                        data-testid={`avatar-identicon-${variant}`}
                        onClick={() => setIdenticonStyle(variant)}
                        className={cn(
                          "cursor-pointer rounded-xl border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected ? "border-primary" : "border-transparent hover:border-border",
                        )}
                      >
                        <img
                          src={identiconDataUrl(previewName, variant)}
                          alt={`Identicon style ${variant + 1}`}
                          className="size-16 rounded-lg"
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <footer className="flex justify-end gap-2 border-t bg-muted px-6 py-4">
          <button
            type="button"
            data-testid="new-bot-cancel"
            onClick={() => onOpenChange(false)}
            className="h-9 cursor-pointer rounded-md border border-border px-4 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="new-bot-create"
            disabled={trimmedName.length === 0}
            className="h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create bot
          </button>
        </footer>
      </form>
    </DialogShell>
  );
}
