// Pile de notifications — état souscriptible, HORS React : `store.ts` (zustand)
// l'appelle depuis ses actions, où aucun contexte n'est accessible. C'est la
// raison pour laquelle on garde la file ici plutôt que de prendre le
// `ToastProvider` du socle, qui suppose un `useToast()` dans un composant.
//
// L'AFFICHAGE, lui, est celui du socle (`ToastViewport`) : c'est exactement le
// cas pour lequel il est exporté — « les apps qui gèrent la file ailleurs ».
//
// Les minuteries sont SUSPENDABLES (WCAG 2.2.1) : `ToastViewport` signale le
// survol et le focus, on retient alors le temps restant au lieu de le perdre.
// Un message qu'on n'a pas eu le temps de lire n'a servi à rien.

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastEntry {
  id: string;
  tone: ToastTone;
  message: string;
}

type Listener = (toasts: ToastEntry[]) => void;

const TTL_MS = 4500;
let toasts: ToastEntry[] = [];
const listeners = new Set<Listener>();

/** id → temps restant + minuterie en cours (`null` quand elle est suspendue). */
const timers = new Map<
  string,
  { remaining: number; startedAt: number; timer: ReturnType<typeof setTimeout> | null }
>();
let paused = false;

function emit(): void {
  for (const l of listeners) l(toasts);
}

function arm(id: string, remaining: number): void {
  timers.set(id, {
    remaining,
    startedAt: Date.now(),
    timer: paused ? null : setTimeout(() => dismiss(id), remaining),
  });
}

function push(tone: ToastTone, message: string): void {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, tone, message }];
  emit();
  arm(id, TTL_MS);
}

function dismiss(id: string): void {
  const entry = timers.get(id);
  if (entry?.timer) clearTimeout(entry.timer);
  timers.delete(id);
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
  return () => {
    listeners.delete(l);
  };
}

export function dismissToast(id: string): void {
  dismiss(id);
}

/** Suspend ou relance le compte à rebours de toute la pile. */
export function setToastsPaused(next: boolean): void {
  if (next === paused) return;
  paused = next;
  for (const [id, entry] of timers) {
    if (paused) {
      if (!entry.timer) continue;
      clearTimeout(entry.timer);
      timers.set(id, {
        remaining: Math.max(0, entry.remaining - (Date.now() - entry.startedAt)),
        startedAt: Date.now(),
        timer: null,
      });
    } else if (!entry.timer) {
      arm(id, entry.remaining);
    }
  }
}
