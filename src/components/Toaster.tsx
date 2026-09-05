import { useEffect, useState } from 'react';
import { ToastViewport } from '@mister-guiiug/dev-pwa-config/react/toast';
import { dismissToast, setToastsPaused, subscribeToasts, type ToastEntry } from '../toast';

// La file reste dans `../toast` (voir son en-tête pour le pourquoi) ; seul le
// balisage change. Ce que la bascule corrige :
//  - un `onClick` posé sur un `<div>` pour fermer, donc inatteignable au
//    clavier → un vrai bouton de fermeture étiqueté ;
//  - un `role="status"` par message, inséré en même temps que son texte : la
//    plupart des lecteurs d'écran n'annoncent que les insertions dans une
//    région DÉJÀ montée → deux régions vivantes permanentes (polie pour les
//    succès et infos, assertive pour les erreurs).
export function Toaster(): JSX.Element {
  const [items, setItems] = useState<ToastEntry[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  return <ToastViewport toasts={items} onDismiss={dismissToast} onPauseChange={setToastsPaused} />;
}
