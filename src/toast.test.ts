import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissToast, setToastsPaused, subscribeToasts, toast, type ToastEntry } from './toast';

// La file est le seul morceau que l'app garde en propre : `ToastViewport` du
// socle rend ce qu'elle contient et lui renvoie survol, focus et fermeture.
// Ce sont donc ces contrats-là qui sont testés — pas le balisage, qui est
// couvert chez le socle.

function current(): ToastEntry[] {
  let seen: ToastEntry[] = [];
  subscribeToasts((list) => {
    seen = list;
  })();
  return seen;
}

describe('pile de notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setToastsPaused(false);
    for (const t of current()) dismissToast(t.id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('empile un message avec son ton et l’efface à l’échéance', () => {
    toast.success('Relevé ajouté');
    expect(current()).toHaveLength(1);
    expect(current()[0].tone).toBe('success');
    expect(current()[0].message).toBe('Relevé ajouté');

    vi.advanceTimersByTime(4500);
    expect(current()).toHaveLength(0);
  });

  it('suspend le compte à rebours tant que la pile est survolée (WCAG 2.2.1)', () => {
    toast.error('Sync échouée');
    vi.advanceTimersByTime(3000);

    setToastsPaused(true);
    vi.advanceTimersByTime(60_000);
    expect(current()).toHaveLength(1);

    // À la reprise, c'est le temps RESTANT qui repart, pas la durée entière.
    setToastsPaused(false);
    vi.advanceTimersByTime(1400);
    expect(current()).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(current()).toHaveLength(0);
  });

  it('retire la minuterie avec le message quand on le ferme à la main', () => {
    toast.info('Export terminé');
    const [entry] = current();

    dismissToast(entry.id);
    expect(current()).toHaveLength(0);

    // La minuterie ne doit plus rien avoir à retirer ensuite.
    vi.advanceTimersByTime(10_000);
    expect(current()).toHaveLength(0);
  });

  it('garde les messages arrivés pendant une suspension', () => {
    setToastsPaused(true);
    toast.info('Premier');
    toast.info('Second');

    vi.advanceTimersByTime(30_000);
    expect(current()).toHaveLength(2);

    setToastsPaused(false);
    vi.advanceTimersByTime(4500);
    expect(current()).toHaveLength(0);
  });
});
