import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes,
  TableHTMLAttributes
} from "react";
import clsx from "clsx";
import { NavLink } from "react-router-dom";
import { LogOut } from "iconoir-react";
import * as Dialog from "@radix-ui/react-dialog";

export type WorkspaceNavItem = {
  to: string;
  label: string;
  icon?: ReactNode;
};

export type WorkspaceNavGroup = {
  title: string;
  items: WorkspaceNavItem[];
};

export function AppShell({ children }: PropsWithChildren) {
  return <div className="min-h-screen bg-slate-100 text-slate-900">{children}</div>;
}

export function WorkspaceShell({
  product,
  subtitle,
  role,
  tenantSwitcher,
  onLogout,
  navigation,
  children
}: PropsWithChildren<{
  product: string;
  subtitle?: string;
  role?: ReactNode;
  tenantSwitcher?: ReactNode;
  onLogout?: () => void;
  navigation: WorkspaceNavGroup[];
}>) {
  return (
    <AppShell>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{product}</div>
            {subtitle ? <div className="truncate text-xs text-slate-500">{subtitle}</div> : null}
          </div>
          <div className="flex items-center gap-2">
            {role}
            {tenantSwitcher}
            {onLogout ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
                onClick={onLogout}
              >
                <LogOut width={16} height={16} />
                Logout
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-6">
        <aside className="h-fit rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
          <nav className="space-y-4" aria-label="Primary">
            {navigation.map((group) => (
              <div key={group.title}>
                <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{group.title}</div>
                <ul className="space-y-1">
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        className={({ isActive }) =>
                          clsx(
                            "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition",
                            isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
                          )
                        }
                      >
                        {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
                        <span className="truncate">{item.label}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 space-y-4">{children}</main>
      </div>
    </AppShell>
  );
}

export function PageCard({ title, children, actions }: PropsWithChildren<{ title: string; actions?: ReactNode }>) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {actions}
      </div>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  );
}

export function FieldLabel({ label, htmlFor, className }: { label: string; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={clsx("mb-1 block text-sm font-medium text-slate-700", className)}>
      {label}
    </label>
  );
}

export function FormGrid({ children, className }: PropsWithChildren<{ className?: string }>) {
  return <div className={clsx("grid grid-cols-1 gap-3 md:grid-cols-2", className)}>{children}</div>;
}

export function Surface({ children, className }: PropsWithChildren<{ className?: string }>) {
  return <div className={clsx("rounded-lg border border-slate-200 bg-white p-3", className)}>{children}</div>;
}

export function DataTable({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table
        {...props}
        className={clsx("min-w-full divide-y divide-slate-200 text-sm [&_th]:text-left [&_th]:font-semibold", className)}
      />
    </div>
  );
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50",
        props.className
      )}
    />
  );
}

export function DangerButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50",
        props.className
      )}
    />
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200",
        props.className
      )}
    />
  );
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(
        "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200",
        props.className
      )}
    />
  );
}

export function Badge({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLSpanElement>>) {
  return (
    <span
      {...props}
      className={clsx(
        "inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700",
        className
      )}
    >
      {children}
    </span>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  children
}: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void; title: string }>) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
          <Dialog.Title className="mb-3 text-lg font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
