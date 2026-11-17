import { useState } from "react";
import type { PageNote } from "../../../cli/wire.ts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { clearsIn, day, scopeHref, scopeName } from "@/lib/view";
import { Dot } from "./bits";

interface Props {
  note: PageNote;
  onEdit: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

/** The whole note. A note in the trash is read-only until it is restored. */
export function NoteView({ note, onEdit, onTrash, onRestore, onDelete }: Props) {
  const [copied, setCopied] = useState(false);
  const href = scopeHref(note.scope);
  // The drawer on a phone sits outside the page element, so its buttons stay bright there.
  const act = "h-auto gap-1.5 py-[3px] pr-[3px] pl-[9px] text-[12.5px] text-foreground group-data-[pane=rail]/page:text-faint hover:!text-foreground";
  const meta = [
    `verified ${day(note.last_verified)}${note.verified_at_commit ? ` at ${note.verified_at_commit}` : ""}`,
    `confidence ${note.confidence}`,
    `${note.uses} ${note.uses === 1 ? "use" : "uses"}${note.last_used ? `, last ${day(note.last_used)}` : ""}`,
    note.trashed && (note.trashed_at ? `trashed ${day(note.trashed_at)}` : "in the trash"),
    note.clears_at && `deleted ${clearsIn(note.clears_at)}`,
    !note.indexed && "not indexed",
    note.promoted_to && `promoted to ${note.promoted_to}`,
  ].filter(Boolean);
  return (
    <article className={`k-${note.kind}`}>
      <div className="mb-2.5 flex min-h-9 items-center gap-2.5 text-[12.5px] text-muted-foreground">
        <Dot />
        <span className="font-[550] text-(--k)">{note.kind}</span>
        <span>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">
              {scopeName(note.scope)}
            </a>
          ) : (
            note.scope
          )}
        </span>
        <span className="ml-auto flex gap-1.5">
          {note.trashed ? (
            <>
              <Button variant="outline" size="xs" className={act} onClick={onRestore}>
                Restore <Kbd>r</Kbd>
              </Button>
              <Button variant="outline" size="xs" className={act} onClick={onDelete}>
                Delete <Kbd>⌫</Kbd>
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="xs" className={act} onClick={onEdit}>
                Edit <Kbd>e</Kbd>
              </Button>
              <Button variant="outline" size="xs" className={act} onClick={onTrash}>
                Trash <Kbd>⌫</Kbd>
              </Button>
            </>
          )}
        </span>
      </div>
      <h2 className="mb-3.5 text-2xl leading-tight font-bold tracking-[-0.015em] [overflow-wrap:anywhere]">{note.title}</h2>
      <p className="mb-5 flex flex-wrap gap-x-3.5 gap-y-1 border-b pb-4 text-[12.5px] text-muted-foreground">
        <button
          type="button"
          title="Copy the id"
          className="font-mono text-xs [overflow-wrap:anywhere] hover:text-foreground"
          onClick={() => {
            void navigator.clipboard?.writeText(note.id);
            setCopied(true);
            setTimeout(() => setCopied(false), 900);
          }}
        >
          {copied ? "copied" : note.id}
        </button>
        {meta.map((text) => (
          <span key={String(text)}>{text}</span>
        ))}
      </p>
      {note.anchors.length > 0 && (
        <p className="mb-3.5 flex flex-wrap gap-1.5">
          {note.anchors.map((anchor) => (
            <code key={anchor}>{anchor}</code>
          ))}
        </p>
      )}
      {/* The server renders the markdown with raw HTML escaped, so this is safe to insert. */}
      <div className="prose-kb" dangerouslySetInnerHTML={{ __html: note.html }} />
    </article>
  );
}
