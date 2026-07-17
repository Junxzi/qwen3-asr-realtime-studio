import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva("ui-button", {
  variants: {
    variant: {
      default: "ui-button--default",
      subtle: "ui-button--subtle",
      ghost: "ui-button--ghost",
      danger: "ui-button--danger",
      icon: "ui-button--icon",
    },
    size: {
      default: "ui-button--md",
      sm: "ui-button--sm",
      lg: "ui-button--lg",
      icon: "ui-button--square",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
