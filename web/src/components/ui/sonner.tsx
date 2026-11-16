import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/** The theme comes from the page, which has its own switch. */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--edge)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          description: "!text-muted-foreground truncate max-w-full",
          // An action looks like the note's own outline buttons, not a light block on a dark toast.
          actionButton:
            "!h-auto !gap-1.5 !rounded-md !border !border-input !bg-transparent !py-[3px] !pr-[3px] !pl-[9px] !text-[12.5px] !font-normal !text-foreground hover:!bg-muted",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
