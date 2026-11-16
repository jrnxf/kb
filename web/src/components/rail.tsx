import { KeyboardIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import type { Theme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { scopeName } from "@/lib/view";
import { Dot } from "./bits";

export type RailItem = { key: string } & ({ type: "scope"; scope: string } | { type: "kind"; kind: string; n: number } | { type: "archived" });

interface Props {
  items: RailItem[];
  pressed: (item: RailItem) => boolean;
  count: (item: RailItem) => number;
  /** The item the keys are on while the sidebar has them. */
  cursor: string | null;
  onPick: (item: RailItem) => void;
  theme: Theme;
  onTheme: () => void;
  onKeys: () => void;
}

const THEME_ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };

/** The sidebar: scopes, kinds and the archive. On a phone the scopes and the kinds are two rows that scroll sideways. */
export function Rail({ items, pressed, count, cursor, onPick, theme, onTheme, onKeys }: Props) {
  const ThemeIcon = THEME_ICON[theme];
  const scopes = items.filter((i) => i.type === "scope");
  const rest = items.filter((i) => i.type !== "scope");
  const item = (it: RailItem) => {
    const n = count(it);
    const name = it.type === "scope" ? (it.scope === "*" ? "all" : scopeName(it.scope)) : it.type === "kind" ? it.kind : "archived";
    return (
      <button
        key={it.key}
        type="button"
        tabIndex={-1}
        data-rail={it.key}
        aria-pressed={pressed(it)}
        title={it.type === "scope" && it.scope !== "*" ? it.scope : undefined}
        onClick={() => onPick(it)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13.5px] text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:font-[550] aria-pressed:text-foreground",
          "max-wide:w-auto max-wide:flex-none max-wide:scroll-mx-4 max-wide:rounded-full max-wide:border max-wide:px-3",
          it.type === "kind" && `k-${it.kind}`,
          it.type !== "archived" && n === 0 && "opacity-40",
          cursor === it.key && "group-data-[pane=rail]/page:bg-secondary group-data-[pane=rail]/page:text-foreground group-data-[pane=rail]/page:ring-1 group-data-[pane=rail]/page:ring-edge group-data-[pane=rail]/page:ring-inset",
        )}
      >
        {it.type === "kind" && <Dot />}
        <span className={cn("min-w-0 truncate", it.type === "kind" ? "flex-initial" : "flex-1", "max-wide:overflow-visible")}>{name}</span>
        {/* The key of a kind sits next to its name, so the count at the right edge stays the only number there. */}
        {it.type === "kind" && <Kbd className="mr-auto ml-2">{it.n}</Kbd>}
        <span className="text-xs font-normal text-faint tabular-nums">{n}</span>
      </button>
    );
  };
  const heading = (text: string) => <h3 className="mt-[22px] mb-1.5 px-2 text-[11px] font-semibold tracking-wider text-faint uppercase max-wide:hidden">{text}</h3>;
  const sep = <Separator className="mx-2 my-1.5 !w-auto max-wide:hidden" />;
  // A strip runs to both edges of a phone's screen, so a chip that is cut at the edge says that there are more.
  const strip = "max-wide:-mx-4 max-wide:mt-2.5 max-wide:flex max-wide:gap-1.5 max-wide:overflow-x-auto max-wide:px-4 max-wide:[scrollbar-width:none]";
  const global = scopes.filter((s) => s.scope === "*" || s.scope === "global");
  const repos = scopes.filter((s) => s.scope !== "*" && s.scope !== "global");
  const kinds = rest.filter((i) => i.type === "kind");
  const archived = rest.find((i) => i.type === "archived");
  return (
    <aside className="flex min-w-0 flex-col overflow-y-auto border-r pt-7 pr-3 pb-4 pl-4 max-wide:relative max-wide:block max-wide:border-r-0 max-wide:border-b max-wide:px-4 max-wide:pt-5 max-wide:pb-3">
      <header className="px-2">
        <h1 className="text-xl/[1.55] font-bold tracking-[-0.01em]">kb</h1>
      </header>
      <nav>
        {heading("Scopes")}
        <div className={strip} data-strip="scopes">
          {global.map(item)}
          {repos.length > 0 && sep}
          {repos.map(item)}
        </div>
        <div className={strip}>
          {heading("Kinds")}
          {kinds.map(item)}
          {archived && sep}
          {archived && item(archived)}
        </div>
      </nav>
      <div className="mt-auto flex gap-0.5 px-0.5 pt-5 max-wide:absolute max-wide:top-3.5 max-wide:right-3 max-wide:p-0">
        <Button variant="ghost" size="icon-sm" className="size-[30px] text-muted-foreground" onClick={onTheme} title={`Theme: ${theme} (t)`} aria-label={`Theme: ${theme} (t)`}>
          <ThemeIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" className="size-[30px] text-muted-foreground" onClick={onKeys} title="Keys (?)" aria-label="Keys (?)" data-keys-only>
          <KeyboardIcon />
        </Button>
      </div>
    </aside>
  );
}
