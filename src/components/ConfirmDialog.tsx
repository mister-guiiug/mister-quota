// File d'attente promise-based au-dessus du ConfirmDialog du socle.
//
// Le socle livre un composant CONTRÔLÉ (`open` / `onConfirm` / `onCancel`) ;
// les deux appelants de cette app sont des gestionnaires `async` qui attendent
// un booléen. On garde donc la file — elle n'a pas d'équivalent dans le socle —
// et on lui fait rendre le composant du socle au lieu du balisage maison.
//
// Ce que la bascule corrige, et qui était réel ici :
//  - `role="dialog"` sans aucun nom accessible → `role="alertdialog"` étiqueté
//    par le titre et décrit par le message ;
//  - `autoFocus` sur le bouton DESTRUCTIF : une frappe sur Entrée supprimait le
//    compte → le focus initial va sur Annuler ;
//  - ni piège de focus, ni Échap, ni verrou de défilement → les trois arrivent
//    avec le composant.

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@mister-guiiug/dev-pwa-config/react/confirm-dialog';

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
    <ConfirmDialog
      // `key` : deux demandes successives doivent remonter la boîte, sinon le
      // focus initial et l'animation d'entrée ne rejouent pas.
      key={top.id}
      open
      title={top.title}
      message={top.message}
      confirmLabel={top.confirmLabel}
      destructive={top.destructive}
      onConfirm={() => answer(top, true)}
      onCancel={() => answer(top, false)}
    />
  );
}
