import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

export interface Confirm {
  title: string;
  description: string;
  action: string;
  run: () => void;
}

/** A question before a change that cannot be undone. Enter confirms, as the action has the focus. Escape cancels. */
export function ConfirmDialog({ confirm, onClose }: { confirm: Confirm | null; onClose: () => void }) {
  const action = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={!!confirm} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} initialFocus={action} className="w-[360px] sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{confirm?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Cancel <Kbd>esc</Kbd>
          </DialogClose>
          <Button
            ref={action}
            variant="destructive"
            size="sm"
            onClick={() => {
              confirm?.run();
              onClose();
            }}
          >
            {confirm?.action} <Kbd className="bg-transparent text-current">enter</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
