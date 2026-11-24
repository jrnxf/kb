import { useEffect, useRef, useState } from "react";
import type { PageNote } from "../../../cli/wire.ts";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  empty: { text: string; hint?: React.ReactNode; action?: { label: string; run: () => void } };
  /** The list shows the trash: it says how long a note stays, and offers to empty it. */
  trash?: { days: number; onEmpty: () => void };
  /** The list shows one project: it offers to move the whole project to the trash, and to audit it. */
  project?: { onTrash?: () => void; audit?: { state: "start" | "running" | "open"; run: () => void } };
}

export function NoteList({ notes, current, q, onQ, searchRef, onOpen, empty, trash, project }: Props) {
  const rows = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (current) rows.current.get(current.id)?.scrollIntoView({ block: "nearest" });
  }, [current?.id]);
  // On a phone the filter sticks once the page scrolls past the point above it. Only then do the rows fade under it.
  const above = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = above.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className="flex min-h-0 min-w-0 flex-col border-r max-wide:block max-wide:border-r-0">
      {/* On a wide screen the filter stays above the scroll area, and the rows fade at its edges. On a phone the page
          scrolls, so the filter sticks to the top and, once it is stuck, the rows fade out under it. */}
      <div ref={above} aria-hidden />
      <div
        data-stuck={stuck || undefined}
        className="bg-background px-4 pt-6 pb-2 max-wide:sticky max-wide:top-0 max-wide:z-10 max-wide:pt-3.5 max-wide:after:pointer-events-none max-wide:after:absolute max-wide:after:inset-x-0 max-wide:after:top-full max-wide:after:h-5 max-wide:after:bg-linear-to-b max-wide:after:from-background max-wide:after:to-transparent max-wide:after:opacity-0 max-wide:after:transition-opacity max-wide:data-stuck:after:opacity-100"
      >
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
        {notes.length > 0 && (
          <div className="mt-3.5 flex min-h-[22px] items-center gap-2 text-xs/[normal] text-faint tabular-nums">
            <span>
              {notes.length === 1 ? "1 note" : `${notes.length} notes`}
              {trash && `, deleted after ${trash.days} days`}
            </span>
            {trash && (
              <Button variant="outline" size="xs" className="-my-px ml-auto text-muted-foreground hover:text-foreground" onClick={trash.onEmpty}>
                Empty trash
              </Button>
            )}
            {project?.audit && (
              <Button
                variant="outline"
                size="xs"
                data-audit-start={project.audit.state}
                disabled={project.audit.state === "running"}
                title={project.audit.state === "start" ? "A headless Claude session checks the stale notes here and proposes cards. It counts against your Claude usage." : undefined}
                className="-my-px ml-auto text-muted-foreground hover:text-foreground"
                onClick={project.audit.run}
              >
                {project.audit.state === "running" ? "Auditing…" : project.audit.state === "open" ? "Open audit" : "Audit"}
              </Button>
            )}
            {project?.onTrash && (
              <Button variant="outline" size="xs" className={cn("-my-px text-muted-foreground hover:text-foreground", !project.audit && "ml-auto")} onClick={project.onTrash}>
                Trash project
              </Button>
            )}
          </div>
        )}
      </div>
      <ScrollArea fade className="min-h-0 flex-1 max-wide:contents" viewportClassName="max-wide:contents" contentClassName="max-wide:contents">
        {notes.length === 0 ? (
          <Empty className="items-start gap-2.5 rounded-none border-0 px-4 pt-0.5 pb-6 text-left md:p-0 md:px-4">
            <EmptyTitle className="text-[13.5px] font-normal text-muted-foreground">{empty.text}</EmptyTitle>
            {empty.hint && <EmptyDescription className="text-[13.5px] leading-normal">{empty.hint}</EmptyDescription>}
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
                  "flex w-full scroll-my-(--scroll-fade) items-baseline gap-2.5 rounded-md px-2 py-[7px] text-left text-sm leading-[1.4] hover:bg-muted aria-[current=true]:bg-muted max-wide:scroll-mt-[104px] max-wide:scroll-mb-4",
                  // The pane that has the keys marks its current item a little more.
                  "group-data-[pane=list]/page:aria-[current=true]:bg-secondary group-data-[pane=list]/page:aria-[current=true]:ring-1 group-data-[pane=list]/page:aria-[current=true]:ring-edge group-data-[pane=list]/page:aria-[current=true]:ring-inset",
                )}
              >
                <Dot className="relative -top-0.5" />
                <span className={cn("line-clamp-2 min-w-0 flex-1", note.trashed && "text-muted-foreground")}>{note.title}</span>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
