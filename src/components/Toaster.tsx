import { useEffect, useState } from 'react';
import { dismissToast, subscribeToasts, type ToastEntry } from '../toast';

export function Toaster(): JSX.Element {
  const [items, setItems] = useState<ToastEntry[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  return (
    <div className="toaster">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)} role="status">
          {t.message}
        </div>
      ))}
    </div>
  );
}
