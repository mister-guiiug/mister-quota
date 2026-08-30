import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, AccountState, EntryMode } from '@shared/types';
import { formatDateTime } from '@mister-guiiug/dev-wpa-config/format';
import { fmtDays, fmtPct, fmtUnitForAccount } from '../format';
import { useAppStore } from '../store';
import { confirmDialog } from '../components/ConfirmDialog';
import { toast } from '../toast';

interface Props {
  accountId: string;
  onBack: () => void;
  onEdit: (a: Account) => void;
}

export function AccountDetail({ accountId, onBack, onEdit }: Props): JSX.Element {
  const states = useAppStore((s) => s.states);
  const entriesMap = useAppStore((s) => s.entriesByAccount);
  const refreshOne = useAppStore((s) => s.refreshOne);
  const syncNow = useAppStore((s) => s.syncNow);
  const deleteAccount = useAppStore((s) => s.deleteAccount);

  const [showAdd, setShowAdd] = useState(false);

  const state = useMemo<AccountState | null>(
    () => states?.find((x) => x.account.id === accountId) ?? null,
    [states, accountId],
  );
  const entries = entriesMap[accountId] ?? [];

  const reload = useCallback(() => refreshOne(accountId), [refreshOne, accountId]);
  useEffect(() => {
    reload();
  }, [reload]);

  if (!state) {
    return (
      <div className="card">
        <div className="skeleton" style={{ width: '40%', height: 16, marginBottom: 12 }} />
        <div className="skeleton" style={{ width: '100%', height: 220 }} />
      </div>
    );
  }
  const a = state.account;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <button className="ghost" onClick={onBack}>
            ← Dashboard
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost" onClick={() => onEdit(a)}>
            Éditer
          </button>
          {a.skillId && (
            <button className="primary" onClick={() => syncNow(accountId)}>
              Synchroniser maintenant
            </button>
          )}
          <button
            className="danger"
            onClick={async () => {
              const ok = await confirmDialog({
                title: 'Supprimer le compte ?',
                message: `« ${a.name} » et tous ses relevés vont être supprimés définitivement.`,
                confirmLabel: 'Supprimer',
                destructive: true,
              });
              if (!ok) return;
              await deleteAccount(accountId);
              onBack();
            }}
          >
            Supprimer
          </button>
        </div>
      </div>

      <h2 style={{ margin: '0 0 4px' }}>{a.name}</h2>
      <div className="muted" style={{ marginBottom: 16 }}>
        {a.provider} · {a.collection} · période {a.periodRule.type} · timezone {a.periodRule.timezone}
      </div>

      <div className="card">
        <h3>Vue d&apos;ensemble</h3>
        <Chart state={state} />
        <div className="row" style={{ gap: 24, marginTop: 12 }}>
          <Stat label="Quota" value={fmtUnitForAccount(a.quota, a)} />
          <Stat label="Consommé" value={fmtUnitForAccount(state.consumed, a)} />
          <Stat label="Idéal à date" value={fmtUnitForAccount(state.idealToDate, a)} />
          <Stat
            label="Écart"
            value={`${state.delta >= 0 ? '+' : ''}${fmtUnitForAccount(state.delta, a)} (${fmtPct(state.deltaPct)})`}
          />
          <Stat label="Statut" value={state.status} />
        </div>
        <div className="row" style={{ gap: 24, marginTop: 12 }}>
          <Stat label="% théorique / jour" value={`${state.theoreticalDailyPct.toFixed(2)}%`} />
          <Stat label="Conso théorique / jour" value={fmtUnitForAccount(state.theoreticalDailyAmount, a)} />
          <Stat label="Requis / jour restant" value={fmtUnitForAccount(state.requiredDailyAvgRemaining, a)} />
          <Stat label="Jours restants" value={fmtDays(state.remainingDays)} />
          <Stat
            label="Vitesse vs cible"
            value={`${state.paceDeltaDailyPct >= 0 ? '+' : ''}${state.paceDeltaDailyPct.toFixed(1)}%/jour`}
          />
          <Stat label="Projection fin période" value={fmtUnitForAccount(state.projectedEndConsumption, a)} />
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Période courante : {formatDateTime(state.period.start)} → {formatDateTime(state.period.end)}
        </div>
      </div>

      {(state.previous || state.history) && (
        <div className="card">
          <h3>Comparaison inter-périodes</h3>
          <div className="row" style={{ gap: 24 }}>
            {state.previous && (
              <>
                <Stat label="Période précédente" value={fmtUnitForAccount(state.previous.consumed, a)} />
                <Stat
                  label="Δ vs période courante"
                  value={`${state.previous.deltaVsCurrentPct >= 0 ? '+' : ''}${state.previous.deltaVsCurrentPct.toFixed(1)}%`}
                />
              </>
            )}
            {state.history && state.history.sampleCount > 0 && (
              <Stat
                label={`Moyenne ${state.history.sampleCount} dern. périodes`}
                value={fmtUnitForAccount(state.history.averageConsumed, a)}
              />
            )}
            {state.projectedExhaustionDate && (
              <Stat
                label="Date prévue d'épuisement (régression)"
                value={formatDateTime(state.projectedExhaustionDate)}
              />
            )}
            <Stat
              label="Projection fin (régression)"
              value={fmtUnitForAccount(state.projectedEndConsumptionRecent, a)}
            />
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Relevés</h3>
          <div className="row" style={{ gap: 8 }}>
            <ImportCsvButton accountId={a.id} onImported={reload} />
            <button className="primary" onClick={() => setShowAdd((v) => !v)}>
              {showAdd ? 'Annuler' : '+ Saisie manuelle'}
            </button>
          </div>
        </div>
        {showAdd && (
          <AddEntryForm
            accountId={accountId}
            onAdded={() => {
              setShowAdd(false);
              reload();
            }}
          />
        )}
        {entries.length === 0 ? (
          <p className="muted">Aucun relevé pour ce compte.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Valeur</th>
                <th>Mode</th>
                <th>Source</th>
                <th>Commentaire</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{formatDateTime(e.recordedAt)}</td>
                  <td className="mono">{fmtUnitForAccount(e.value, a)}</td>
                  <td>{e.mode}</td>
                  <td>{e.source}</td>
                  <td className="muted">{e.comment ?? ''}</td>
                  <td>
                    <button
                      className="danger"
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: 'Supprimer ce relevé ?',
                          message: `${formatDateTime(e.recordedAt)} — ${fmtUnitForAccount(e.value, a)}`,
                          confirmLabel: 'Supprimer',
                          destructive: true,
                        });
                        if (ok) await useAppStore.getState().deleteEntry(e.id, a.id);
                      }}
                    >
                      Suppr.
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="col">
      <span className="label">{label}</span>
      <span className="value mono">{value}</span>
    </div>
  );
}

function AddEntryForm({ accountId, onAdded }: { accountId: string; onAdded: () => void }): JSX.Element {
  const [recordedAt, setRecordedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [value, setValue] = useState<number>(0);
  const [mode, setMode] = useState<EntryMode>('cumulative');
  const [comment, setComment] = useState('');

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        await useAppStore.getState().addEntry({
          id: crypto.randomUUID(),
          accountId,
          recordedAt: new Date(recordedAt).toISOString(),
          value: Number(value),
          mode,
          source: 'manual',
          comment: comment || undefined,
        });
        onAdded();
      }}
    >
      <div className="row-form">
        <label>
          Date / heure
          <input
            type="datetime-local"
            value={recordedAt}
            onChange={(e) => setRecordedAt(e.target.value)}
            required
          />
        </label>
        <label>
          Valeur
          <input
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            required
          />
        </label>
      </div>
      <label>
        Mode
        <select value={mode} onChange={(e) => setMode(e.target.value as EntryMode)}>
          <option value="cumulative">Cumulatif (total depuis début de période)</option>
          <option value="delta">Delta (ajout depuis le dernier relevé)</option>
        </select>
      </label>
      <label>
        Commentaire
        <input value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <button className="primary" type="submit">
        Ajouter
      </button>
    </form>
  );
}

function ImportCsvButton({
  accountId,
  onImported,
}: {
  accountId: string;
  onImported: () => void;
}): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="ghost" onClick={() => fileInputRef.current?.click()}>
        ↑ Importer CSV
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const text = await file.text();
          const res = await window.api.importEntriesCsv(accountId, text);
          if (res.inserted > 0) toast.success(`${res.inserted} relevés importés`);
          if (res.errors.length > 0)
            toast.error(
              `${res.errors.length} erreurs : ${res.errors.slice(0, 3).join(' · ')}${res.errors.length > 3 ? '…' : ''}`,
            );
          if (e.target) e.target.value = '';
          onImported();
        }}
      />
    </>
  );
}

// ── Tiny inline SVG chart: real cumulative reading over the period vs ideal line ──
function Chart({ state }: { state: AccountState }): JSX.Element {
  const W = 600,
    H = 220,
    P = 24;
  const startMs = new Date(state.period.start).getTime();
  const endMs = new Date(state.period.end).getTime();
  const xFor = (ms: number) => P + ((ms - startMs) / (endMs - startMs)) * (W - 2 * P);
  const yFor = (v: number) => H - P - Math.min(v / state.account.quota, 1.05) * (H - 2 * P);

  const idealPath = `M ${xFor(startMs)} ${yFor(0)} L ${xFor(endMs)} ${yFor(state.account.quota)}`;

  // Real curve: point at start (0), point at "now" (consumed), nothing else
  // unless we had per-day samples. Good enough for MVP.
  const nowMs = Math.min(Date.now(), endMs);
  const realPath = `M ${xFor(startMs)} ${yFor(0)} L ${xFor(nowMs)} ${yFor(state.consumed)}`;

  return (
    <svg className="svg-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <rect x="0" y="0" width={W} height={H} fill="transparent" />
      {/* axes */}
      <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="var(--border)" />
      <line x1={P} y1={P} x2={P} y2={H - P} stroke="var(--border)" />
      {/* ideal */}
      <path d={idealPath} stroke="var(--fg-dim)" strokeDasharray="4 4" fill="none" />
      {/* real */}
      <path d={realPath} stroke="var(--accent)" strokeWidth="2" fill="none" />
      <circle cx={xFor(nowMs)} cy={yFor(state.consumed)} r="4" fill="var(--accent)" />
      <text x={W - P} y={P} textAnchor="end" fontSize="11" fill="var(--fg-dim)">
        — idéal · — réel
      </text>
    </svg>
  );
}
