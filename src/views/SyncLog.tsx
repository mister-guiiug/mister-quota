import { useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '@mister-guiiug/dev-pwa-config/format';
import type { SkillRunRow } from '@shared/ipc';
import { useAppStore } from '../store';

export function SyncLog({ onBack }: { onBack: () => void }): JSX.Element {
  const [runs, setRuns] = useState<SkillRunRow[] | null>(null);
  const [filterOk, setFilterOk] = useState<'all' | 'ok' | 'fail'>('all');
  const skills = useAppStore((s) => s.skills);

  // Le journal est vide, ou plein d'échecs, quand des comptes sont branchés sur
  // un connecteur squelette. Le dire ici évite de chercher une panne réseau.
  const stubs = useMemo(() => skills.filter((s) => !s.implemented), [skills]);
  const isStub = (skillId: string): boolean => stubs.some((s) => s.id === skillId);

  useEffect(() => {
    window.api.listSkillRuns({ limit: 200 }).then(setRuns);
  }, []);

  if (!runs) return <div className="empty">Chargement…</div>;
  const filtered = runs.filter((r) => filterOk === 'all' || (filterOk === 'ok' ? r.ok : !r.ok));

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <button className="ghost" onClick={onBack}>
          ← Dashboard
        </button>
        <select value={filterOk} onChange={(e) => setFilterOk(e.target.value as 'all' | 'ok' | 'fail')}>
          <option value="all">Toutes</option>
          <option value="ok">Succès uniquement</option>
          <option value="fail">Échecs uniquement</option>
        </select>
      </div>
      <h2 style={{ margin: '0 0 12px' }}>Journal des synchronisations</h2>
      {stubs.length > 0 && (
        <p className="notice warn">
          {stubs.length === 1 ? 'Connecteur squelette' : 'Connecteurs squelettes'} —{' '}
          {stubs.map((s) => s.label).join(', ')} : aucun appel n&apos;est fait, donc aucune donnée n&apos;est
          collectée. Les comptes qui en dépendent doivent être saisis à la main.
        </p>
      )}
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
                <td className="mono">{formatDateTime(r.startedAt)}</td>
                <td className="mono">{r.accountId}</td>
                <td>
                  {r.skillId}
                  {isStub(r.skillId) && (
                    <span className="status period_ended" style={{ marginLeft: 6 }}>
                      squelette
                    </span>
                  )}
                </td>
                <td>
                  <span className={`status ${r.ok ? 'on_track' : 'over_quota'}`}>
                    {r.ok ? 'OK' : 'Échec'}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: 12, maxWidth: 400, whiteSpace: 'pre-wrap' }}>
                  {r.error ??
                    (r.reportJson
                      ? `${r.reportJson.slice(0, 120)}${r.reportJson.length > 120 ? '…' : ''}`
                      : '')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
