// Tiny toaster — pure subscribable state, no extra deps. The <Toaster />
// component subscribes and renders. toast.success/error/info push entries.

type Kind = 'success' | 'error' | 'info';
export interface ToastEntry {
  id: string;
  kind: Kind;
  message: string;
  expiresAt: number;
}

type Listener = (toasts: ToastEntry[]) => void;

const TTL_MS = 4500;
let toasts: ToastEntry[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(toasts);
}

function push(kind: Kind, message: string): void {
  const entry: ToastEntry = {
    id: crypto.randomUUID(),
    kind,
    message,
    expiresAt: Date.now() + TTL_MS,
  };
  toasts = [...toasts, entry];
  emit();
  setTimeout(() => dismiss(entry.id), TTL_MS);
}

function dismiss(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (m: string) => push('success', m),
  error: (m: string) => push('error', m),
  info: (m: string) => push('info', m),
};

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  l(toasts);
  return () => listeners.delete(l);
}

export function dismissToast(id: string): void {
  dismiss(id);
}
