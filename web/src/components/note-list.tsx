import { useEffect, useRef } from "react";
import type { PageNote } from "../../../cli/wire.ts";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { Dot } from "./bits";

interface Props {
  notes: PageNote[];
  current: PageNote | undefined;
  q: string;
  onQ: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onOpen: (note: PageNote) => void;
  /** Why the list is empty, and the shortest way back to notes. */
  empty: { text: string; action?: { label: string; run: () => void } };
}

export function NoteList({ notes, current, q, onQ, searchRef, onOpen, empty }: Props) {
  const rows = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (current) rows.current.get(current.id)?.scrollIntoView({ block: "nearest" });
  }, [current?.id]);
  return (
    <div className="min-w-0 overflow-y-auto border-r max-wide:border-r-0">
      <div className="sticky top-0 z-10 bg-background px-4 pt-6 pb-2 max-wide:pt-3.5">
        <InputGroup className="group/search h-9 bg-card dark:bg-card">
          <InputGroupInput
            ref={searchRef}
            id="q"
            type="search"
            placeholder="Filter notes"
            autoComplete="off"
            value={q}
            onChange={(event) => onQ(event.target.value)}
            className="max-wide:text-base [&::-webkit-search-cancel-button]:hidden"
          />
          <InputGroupAddon align="inline-end" className="group-focus-within/search:hidden">
            <Kbd>/</Kbd>
          </InputGroupAddon>
        </InputGroup>
        {notes.length > 0 && <div className="mt-3.5 font-mono text-xs/[normal] text-faint">{notes.length === 1 ? "1 note" : `${notes.length} notes`}</div>}
      </div>
      {notes.length === 0 ? (
        <Empty className="items-start gap-2.5 rounded-none border-0 px-4 pt-0.5 pb-6 text-left md:p-0 md:px-4">
          <EmptyTitle className="text-[13.5px] font-normal text-muted-foreground">{empty.text}</EmptyTitle>
          {empty.action && (
            <EmptyContent className="items-start">
              <Button variant="outline" size="xs" onClick={empty.action.run}>
                {empty.action.label}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="px-2 pb-6">
          {notes.map((note) => (
            <button
              key={note.id}
              ref={(el) => {
                if (el) rows.current.set(note.id, el);
                else rows.current.delete(note.id);
              }}
              type="button"
              tabIndex={-1}
              data-id={note.id}
              aria-current={note === current}
              onClick={() => onOpen(note)}
              className={cn(
                `k-${note.kind}`,
                "flex w-full scroll-mt-[104px] scroll-mb-4 items-baseline gap-2.5 rounded-md px-2 py-[7px] text-left text-sm leading-[1.4] hover:bg-muted aria-[current=true]:bg-muted",
                // The pane that has the keys marks its current item a little more.
                "group-data-[pane=list]/page:aria-[current=true]:bg-secondary group-data-[pane=list]/page:aria-[current=true]:ring-1 group-data-[pane=list]/page:aria-[current=true]:ring-edge group-data-[pane=list]/page:aria-[current=true]:ring-inset",
              )}
            >
              <Dot className="relative -top-0.5" />
              <span className={cn("line-clamp-2 min-w-0 flex-1", note.archived && "text-muted-foreground")}>{note.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
