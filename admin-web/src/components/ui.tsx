import React from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const cx = (...xs: Array<string | false | null | undefined>) => twMerge(clsx(...xs));

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cx("rounded-xl border border-border bg-card shadow-sm", className)}>{children}</div>;
}
export function CardHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="border-b border-border/60 px-5 py-3.5">
      <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
      {desc && <p className="mt-0.5 text-[11px] text-muted-foreground">{desc}</p>}
    </div>
  );
}
export function CardBody({ children }: { children: React.ReactNode }) {
  return <div className="space-y-3 px-5 py-4">{children}</div>;
}

type BtnVariant = "default" | "secondary" | "ghost" | "destructive";
export function Button({
  variant = "default",
  size = "default",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "default" | "sm" }) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-[12px]" : "px-4 py-2 text-[13px]",
        variant === "default" && "bg-primary text-white hover:brightness-110",
        variant === "secondary" && "border border-border bg-muted text-foreground hover:brightness-125",
        variant === "ghost" && "text-muted-foreground hover:bg-muted hover:text-foreground",
        variant === "destructive" && "bg-destructive text-white hover:brightness-110",
        className,
      )}
      {...rest}
    />
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-primary",
        props.className,
      )}
    />
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[12px] font-medium text-muted-foreground">{children}</div>;
}

type BadgeVariant = "default" | "success" | "warning" | "destructive" | "outline" | "info";
export function Badge({ variant = "default", children, title }: { variant?: BadgeVariant; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        variant === "default" && "bg-primary/15 text-emerald-300",
        variant === "success" && "bg-emerald-500/15 text-emerald-300",
        variant === "warning" && "bg-amber-500/15 text-amber-300",
        variant === "destructive" && "bg-red-500/15 text-red-300",
        variant === "outline" && "border border-border text-muted-foreground",
        variant === "info" && "bg-sky-500/15 text-sky-300",
      )}
    >
      {children}
    </span>
  );
}

export function Switch({ checked, onCheckedChange, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("inline-flex rounded-lg border border-border bg-muted/40 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
            o.value === value ? "bg-card text-foreground shadow" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx("inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary", className)}
    />
  );
}

export function EmptyState({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {desc && <p className="mt-1 text-[12px] text-muted-foreground">{desc}</p>}
    </div>
  );
}
