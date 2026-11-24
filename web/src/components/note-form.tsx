import { useEffect, useRef, useState } from "react";
import type { NoteEdit, PageNote } from "../../../cli/wire.ts";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MAC } from "@/hooks/use-media";
import { Combo } from "./bits";

interface Props {
  note: PageNote;
  kinds: string[];
  onCancel: () => void;
  /** Throws with the reason when the server refuses the edit. */
  onSave: (edit: NoteEdit) => Promise<void>;
}

const CONFIDENCES = ["high", "medium", "low"];

type Problems = { title?: string; body?: string; other?: string };

/** The server says "invalid note: title: required; body: required". Each problem goes to its own field. */
export function problems(message: string): Problems {
  const out: Problems = {};
  const add = (key: keyof Problems, text: string) => (out[key] = out[key] ? `${out[key]} ${text}` : text);
  for (const part of message.replace(/^invalid note:\s*/, "").split(/;\s*/)) {
    const field = /^(title|body):\s*(.*)$/.exec(part);
    if (field) add(field[1] as "title" | "body", `${field[1] === "title" ? "The title" : "The body"} ${field[2] === "required" ? "is required" : field[2]}.`);
    else if (part) add("other", part);
  }
  return out;
}

const label = "text-xs font-normal text-muted-foreground";

/** Esc cancels and ⌘↵ saves, from any field. */
export function NoteForm({ note, kinds, onCancel, onSave }: Props) {
  const [edit, setEdit] = useState<NoteEdit>({ title: note.title, kind: note.kind, confidence: note.confidence, body: note.body });
  const [error, setError] = useState<Problems>({});
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  // The caret starts at the end of the body, where an edit most often goes.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // Escape cancels also when the focus is outside the form, as after a failed save. Inside the form
  // the form's own handler takes it, as the phone's drawer stops the key before the document.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || form.current?.contains(event.target as Node) || (event.target as HTMLElement).closest?.("[role=listbox]")) return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onCancel]);
  const set = (key: keyof NoteEdit) => (value: string | null) => setEdit((e) => ({ ...e, [key]: value ?? "" }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await onSave(edit);
    } catch (problem) {
      const found = problems((problem as Error).message);
      setError(found);
      setSaving(false);
      // The Save button is off while it saves, so the focus fell to the page. It goes to the field to fix.
      (found.title ? title.current : body.current)?.focus();
    }
  }

  return (
    <form
      ref={form}
      onSubmit={submit}
      onKeyDown={(event) => {
        // An open list of a select keeps its own Escape.
        if ((event.target as HTMLElement).closest("[role=listbox]")) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && (MAC ? event.metaKey : event.ctrlKey)) {
          event.preventDefault();
          form.current?.requestSubmit();
        }
      }}
    >
      <FieldGroup className="gap-3.5">
        <Field data-invalid={error.title ? true : undefined}>
          <FieldLabel className={label} htmlFor="edit-title">Title</FieldLabel>
          <Input
            ref={title}
            id="edit-title"
            autoComplete="off"
            value={edit.title}
            onChange={(e) => set("title")(e.target.value)}
            aria-invalid={error.title ? true : undefined}
            aria-describedby={error.title ? "edit-title-error" : undefined}
            className="max-wide:text-base"
          />
          {error.title && <FieldError id="edit-title-error">{error.title}</FieldError>}
        </Field>
        <div className="grid grid-cols-2 gap-3.5">
          <Field>
            <FieldLabel className={label}>Kind</FieldLabel>
            <Select items={kinds.map((k) => ({ value: k, label: k }))} value={edit.kind} onValueChange={set("kind")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {kinds.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {kind}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel className={label}>Confidence</FieldLabel>
            <Select items={CONFIDENCES.map((c) => ({ value: c, label: c }))} value={edit.confidence} onValueChange={set("confidence")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {CONFIDENCES.map((confidence) => (
                    <SelectItem key={confidence} value={confidence}>
                      {confidence}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field data-invalid={error.body ? true : undefined}>
          <FieldLabel className={label} htmlFor="edit-body">Body</FieldLabel>
          <Textarea
            ref={body}
            id="edit-body"
            spellCheck
            value={edit.body}
            onChange={(e) => set("body")(e.target.value)}
            aria-invalid={error.body ? true : undefined}
            aria-describedby={error.body ? "edit-body-error" : undefined}
            className="min-h-[260px] font-mono text-[13.5px] leading-[1.6] max-wide:text-base"
          />
          {error.body && <FieldError id="edit-body-error">{error.body}</FieldError>}
        </Field>
        <div className="flex items-center justify-end gap-2">
          {error.other && <FieldError className="mr-auto">{error.other}</FieldError>}
          <Button type="button" variant="outline" className="pr-1 text-muted-foreground hover:text-foreground" onClick={onCancel}>
            Cancel <Kbd>esc</Kbd>
          </Button>
          <Button type="submit" className="pr-1" disabled={saving}>
            Save <Combo keyName={MAC ? "↵" : "enter"} />
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
