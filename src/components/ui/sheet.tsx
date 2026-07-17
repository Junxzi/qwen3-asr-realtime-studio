import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "@/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export function SheetContent({
  className,
  side = "right",
  children,
  showClose = true,
  showOverlay = true,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  side?: "left" | "right" | "bottom";
  showClose?: boolean;
  showOverlay?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      {showOverlay ? <DialogPrimitive.Overlay className="sheet-overlay" /> : null}
      <DialogPrimitive.Content className={cn("sheet-content", `sheet-content--${side}`, className)} {...props}>
        {children}
        {showClose ? (
          <DialogPrimitive.Close className="sheet-close" aria-label="閉じる">
            <X />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const SheetHeader = forwardRef<
  ElementRef<"header">,
  ComponentPropsWithoutRef<"header">
>(({ className, ...props }, ref) => <header ref={ref} className={cn("sheet-header", className)} {...props} />);
SheetHeader.displayName = "SheetHeader";
