import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { MAC } from "@/hooks/use-media";
import { cn } from "@/lib/utils";

/** The coloured dot of a kind. The colour comes from --k, set by a k-<kind> class on it or a parent. */
export function Dot({ kind, className }: { kind?: string; className?: string }) {
  return <span aria-hidden className={cn("size-[7px] flex-none rounded-full bg-(--k)", kind && `k-${kind}`, className)} />;
}

/** A combination with the command key: ⌘ on a Mac, ctrl elsewhere. One Kbd per key. */
export function Combo({ keyName }: { keyName: string }) {
  return (
    <KbdGroup>
      <Kbd>{MAC ? "⌘" : "ctrl"}</Kbd>
      <Kbd>{keyName}</Kbd>
    </KbdGroup>
  );
}
