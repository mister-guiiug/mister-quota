// Subscribable, promise-returning confirm dialog. Replaces window.confirm()
// so we can style it and (eventually) localize it.

import { useEffect, useState } from 'react';

interface ConfirmRequest {
  id: string;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  resolve: (ok: boolean) => void;
}

let queue: ConfirmRequest[] = [];
type Listener = (q: ConfirmRequest[]) => void;
const listeners = new Set<Listener>();
const emit = (): void => listeners.forEach((l) => l(queue));

export function confirmDialog(opts: Omit<ConfirmRequest, 'id' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...opts, id: crypto.randomUUID(), resolve }];
    emit();
  });
}

function answer(req: ConfirmRequest, ok: boolean): void {
  req.resolve(ok);
  queue = queue.filter((q) => q.id !== req.id);
  emit();
}

export function ConfirmHost(): JSX.Element | null {
  const [q, setQ] = useState<ConfirmRequest[]>([]);
  useEffect(() => {
    const l: Listener = (x) => setQ([...x]);
    listeners.add(l);
    l(queue);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const top = q[0];
  if (!top) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>{top.title}</h3>
        <p>{top.message}</p>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="ghost" onClick={() => answer(top, false)}>
            Annuler
          </button>
          <button
            className={top.destructive ? 'danger primary-destructive' : 'primary'}
            onClick={() => answer(top, true)}
            autoFocus
          >
            {top.confirmLabel ?? 'Confirmer'}
          </button>
        </div>
      </div>
    </div>
  );
}
