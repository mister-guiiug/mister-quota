import { useEffect, useState } from 'react';
import { fmtDate } from '../format';
import type { SkillRunRow } from '@shared/ipc';

export function SyncLog({ onBack }: { onBack: () => void }): JSX.Element {
  const [runs, setRuns] = useState<SkillRunRow[] | null>(null);
  const [filterOk, setFilterOk] = useState<'all' | 'ok' | 'fail'>('all');

  useEffect(() => {
    window.api.listSkillRuns({ limit: 200 }).then(setRuns);
  }, []);

  if (!runs) return <div className="empty">Chargement…</div>;
  const filtered = runs.filter((r) => filterOk === 'all' || (filterOk === 'ok' ? r.ok : !r.ok));

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <button className="ghost" onClick={onBack}>← Dashboard</button>
        <select value={filterOk} onChange={(e) => setFilterOk(e.target.value as 'all' | 'ok' | 'fail')}>
          <option value="all">Toutes</option>
          <option value="ok">Succès uniquement</option>
          <option value="fail">Échecs uniquement</option>
        </select>
      </div>
      <h2 style={{ margin: '0 0 12px' }}>Journal des synchronisations</h2>
      {filtered.length === 0 ? (
        <p className="muted">Aucune synchronisation enregistrée.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Démarrée</th>
              <th>Compte</th>
              <th>Skill</th>
              <th>Statut</th>
              <th>Détail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td className="mono">{fmtDate(r.startedAt)}</td>
                <td className="mono">{r.accountId}</td>
                <td>{r.skillId}</td>
                <td>
                  <span className={`status ${r.ok ? 'on_track' : 'over_quota'}`}>{r.ok ? 'OK' : 'Échec'}</span>
                </td>
                <td className="muted" style={{ fontSize: 12, maxWidth: 400, whiteSpace: 'pre-wrap' }}>
                  {r.error ?? (r.reportJson ? `${r.reportJson.slice(0, 120)}${r.reportJson.length > 120 ? '…' : ''}` : '')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
