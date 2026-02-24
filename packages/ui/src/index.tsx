import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes
} from "react";
import clsx from "clsx";
import * as Dialog from "@radix-ui/react-dialog";

export function AppShell({ children }: PropsWithChildren) {
  return <div className="min-h-screen bg-base-200 text-base-content">{children}</div>;
}

export function PageCard({ title, children, actions }: PropsWithChildren<{ title: string; actions?: ReactNode }>) {
  return (
    <div className="card bg-base-100 shadow-lg">
      <div className="card-body">
        <div className="flex items-center justify-between gap-3">
          <h2 className="card-title">{title}</h2>
          {actions}
        </div>
        {children}
      </div>
    </div>
  );
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={clsx("btn btn-primary", props.className)} />;
}

export function DangerButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={clsx("btn btn-error", props.className)} />;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx("input input-bordered w-full", props.className)} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx("select select-bordered w-full", props.className)} />;
}

export function Badge({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLSpanElement>>) {
  return (
    <span {...props} className={clsx("badge badge-outline", className)}>
      {children}
    </span>
  );
}

// Shadcn-style dialog primitive without framework lock-in.
export function Modal({
  open,
  onOpenChange,
  title,
  children
}: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void; title: string }>) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-box bg-base-100 p-5 shadow-xl">
          <Dialog.Title className="mb-3 text-lg font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
