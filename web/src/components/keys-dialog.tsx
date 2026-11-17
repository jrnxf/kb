import { Fragment } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { MAC } from "@/hooks/use-media";

const KEYS = (kinds: number): [string[], string][] => [
  [["↑", "↓"], "move"],
  [["←", "→"], "sidebar or list"],
  [["enter"], "pick in the sidebar"],
  [["1", String(kinds)], "kinds on or off"],
  [["/"], "filter"],
  [["space"], "scroll the note"],
  [["enter"], "open the note on a narrow screen, as space does"],
  [["e"], "edit"],
  [["⌫"], "trash, or in the trash delete for good"],
  [["⌫"], "on a project in the sidebar, trash the project"],
  [["r"], "restore from the trash"],
  [[MAC ? "⌘" : "ctrl", "Z"], "undo a trash"],
  [["t"], "theme"],
  [["?"], "this list"],
];

export function KeysDialog({ open, onOpenChange, kinds }: { open: boolean; onOpenChange: (open: boolean) => void; kinds: number }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="w-[340px] gap-3 px-5 pt-[18px] pb-5 sm:max-w-[340px]">
        <DialogHeader className="flex-row items-baseline justify-between">
          <DialogTitle className="font-mono text-[13px] font-semibold">keys</DialogTitle>
          <Kbd>esc</Kbd>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-[9px] text-[13.5px]">
          {KEYS(kinds).map(([names, what], i) => (
            <Fragment key={i}>
              <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                {names.map((name, j) => (
                  <Fragment key={j}>
                    {j > 0 && names[0] === "1" && <span className="text-faint">to</span>}
                    <Kbd>{name}</Kbd>
                  </Fragment>
                ))}
              </dt>
              <dd className="text-muted-foreground">{what}</dd>
            </Fragment>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
