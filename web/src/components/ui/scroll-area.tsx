import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "cn"

function ScrollArea({
  className,
  viewportClassName,
  contentClassName,
  fade = false,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  viewportClassName?: string
  contentClassName?: string
  /** Fade the top and bottom edges, each only while there is more to scroll that way. */
  fade?: boolean
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          // --scroll-fade is the fade's height. Rows inside use it as their scroll margin, so a row the keys move to
          // stops clear of the fade.
          fade &&
            "[--scroll-fade:32px] mask-linear-[to_bottom,transparent_0,black_min(var(--scroll-fade),var(--scroll-area-overflow-y-start,0px)),black_calc(100%_-_min(var(--scroll-fade),var(--scroll-area-overflow-y-end,var(--scroll-fade)))),transparent_100%] mask-no-repeat",
          viewportClassName
        )}
      >
        {/* Content tells Base UI when the children change size, so the fade and the scrollbar follow a filter. */}
        <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className={contentClassName}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        // Like a macOS scrollbar, it shows only while the pointer is over the area or it scrolls.
        "opacity-0 transition-opacity duration-150 data-hovering:opacity-100 data-scrolling:opacity-100 data-scrolling:duration-0",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
