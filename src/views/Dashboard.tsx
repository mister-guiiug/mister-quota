import { useEffect, useMemo, useState } from 'react';
import type { Account, AccountState } from '@shared/types';
import { fmtDays, fmtPct, fmtUnitForAccount } from '../format';

type SortKey = 'name' | 'most_behind' | 'most_ahead';

interface Props {
  onOpen: (id: string) => void;
  onEdit: (a: Account) => void;
}

export function Dashboard({ onOpen, onEdit }: Props): JSX.Element {
  const [states, setStates] = useState<AccountState[] | null>(null);
  const [sort, setSort] = useState<SortKey>('most_behind');
  const [filterProvider, setFilterProvider] = useState<string>('all');
  const [filterCollection, setFilterCollection] = useState<string>('all');
  const [filterTag, setFilterTag] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    window.api.computeAllStates().then((s) => { if (!cancelled) setStates(s); });
    return () => { cancelled = true; };
  }, []);

  const allTags = useMemo(() => {
    if (!states) return [] as string[];
    return Array.from(new Set(states.flatMap((s) => s.account.tags ?? []))).sort();
  }, [states]);

  const filtered = useMemo(() => {
    if (!states) return null;
    let out = states;
    if (filterProvider !== 'all') out = out.filter((s) => s.account.provider === filterProvider);
    if (filterCollection !== 'all') out = out.filter((s) => s.account.collection === filterCollection);
    if (filterTag !== 'all') out = out.filter((s) => (s.account.tags ?? []).includes(filterTag));
    const sorted = [...out];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'name': return a.account.name.localeCompare(b.account.name);
        case 'most_behind': return b.deltaPct - a.deltaPct;
        case 'most_ahead': return a.deltaPct - b.deltaPct;
      }
    });
    return sorted;
  }, [states, sort, filterProvider, filterCollection, filterTag]);

  // Currency-budget aggregate: sum across visible currency-unit accounts.
  const budget = useMemo(() => {
    if (!filtered) return null;
    const cur = filtered.filter((s) => s.account.unit === 'currency');
    if (cur.length === 0) return null;
    const consumed = cur.reduce((s, x) => s + x.consumed, 0);
    const quota = cur.reduce((s, x) => s + x.account.quota, 0);
    const ideal = cur.reduce((s, x) => s + x.idealToDate, 0);
    return { consumed, quota, ideal, currency: cur[0].account.currency ?? 'EUR' };
  }, [filtered]);

  if (!states) return <div className="empty">Chargement…</div>;
  if (states.length === 0) {
    return (
      <div className="empty">
        Aucun compte. Clique sur <strong>+ Nouveau compte</strong> pour commencer.
      </div>
    );
  }

  return (
    <>
      <div className="toolbar">
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="most_behind">Tri : plus en retard</option>
          <option value="most_ahead">Tri : plus en avance</option>
          <option value="name">Tri : nom</option>
        </select>
        <select value={filterProvider} onChange={(e) => setFilterProvider(e.target.value)}>
          <option value="all">Tous fournisseurs</option>
          <option value="cursor">Cursor</option>
          <option value="claude">Claude</option>
          <option value="openai">OpenAI</option>
          <option value="other">Autre</option>
        </select>
        <select value={filterCollection} onChange={(e) => setFilterCollection(e.target.value)}>
          <option value="all">Tout type de collecte</option>
          <option value="manual">Manuel</option>
          <option value="auto">Automatique</option>
          <option value="hybrid">Hybride</option>
        </select>
        {allTags.length > 0 && (
          <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
            <option value="all">Tous les tags</option>
            {allTags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </select>
        )}
      </div>

      {budget && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Budget agrégé ({filtered!.filter((s) => s.account.unit === 'currency').length} comptes)</h3>
          <div className="row" style={{ gap: 24, marginTop: 8 }}>
            <Stat label="Quota total" value={new Intl.NumberFormat('fr-FR', { style: 'currency', currency: budget.currency }).format(budget.quota)} />
            <Stat label="Consommé" value={new Intl.NumberFormat('fr-FR', { style: 'currency', currency: budget.currency }).format(budget.consumed)} />
            <Stat label="Idéal à date" value={new Intl.NumberFormat('fr-FR', { style: 'currency', currency: budget.currency }).format(budget.ideal)} />
            <Stat label="Δ vs idéal" value={new Intl.NumberFormat('fr-FR', { style: 'currency', currency: budget.currency, signDisplay: 'always' }).format(budget.consumed - budget.ideal)} />
          </div>
        </div>
      )}
      <div className="grid-cards">
        {filtered!.map((s) => (
          <AccountCard key={s.account.id} state={s} onOpen={() => onOpen(s.account.id)} onEdit={() => onEdit(s.account)} />
        ))}
      </div>
    </>
  );
}

function AccountCard({ state, onOpen, onEdit }: { state: AccountState; onOpen: () => void; onEdit: () => void }): JSX.Element {
  const a = state.account;
  const consumedPct = a.quota > 0 ? (state.consumed / a.quota) * 100 : 0;
  const idealPct = a.quota > 0 ? (state.idealToDate / a.quota) * 100 : 0;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h3 style={{ cursor: 'pointer' }} onClick={onOpen}>{a.name}</h3>
          <div className="muted" style={{ fontSize: 12 }}>
            {a.provider} · {a.collection}
            {(a.tags ?? []).map((t) => (
              <span key={t} style={{ marginLeft: 6, padding: '1px 6px', background: 'var(--bg-elev-2)', borderRadius: 4, fontSize: 10 }}>#{t}</span>
            ))}
          </div>
        </div>
        <span className={`status ${state.status}`}>{statusLabel(state.status)}</span>
      </div>

      <div className="bar" style={{ marginTop: 12 }}>
        <div className="fill" style={{ width: `${Math.min(consumedPct, 100)}%`, background: barColor(state.status) }} />
        <div className="ideal" style={{ left: `${Math.min(idealPct, 100)}%` }} title={`Idéal: ${idealPct.toFixed(1)}%`} />
      </div>

      <div className="row" style={{ marginTop: 12, gap: 24 }}>
        <Stat label="Consommé" value={fmtUnitForAccount(state.consumed, a)} />
        <Stat label="Idéal à date" value={fmtUnitForAccount(state.idealToDate, a)} />
        <Stat label="Écart" value={`${state.delta >= 0 ? '+' : ''}${fmtUnitForAccount(state.delta, a)} (${fmtPct(state.deltaPct)})`} />
      </div>
      <div className="row" style={{ marginTop: 8, gap: 24 }}>
        <Stat label="% théo. / jour" value={`${state.theoreticalDailyPct.toFixed(2)}%`} />
        <Stat label="Conso théo. / jour" value={fmtUnitForAccount(state.theoreticalDailyAmount, a)} />
        <Stat label="Requis / jour restant" value={`${fmtUnitForAccount(state.requiredDailyAvgRemaining, a)} sur ${fmtDays(state.remainingDays)}`} />
      </div>
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <button className="ghost" onClick={onOpen}>Détail</button>
        <button className="ghost" onClick={onEdit}>Éditer</button>
      </div>
    </div>
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

function statusLabel(s: AccountState['status']): string {
  return ({ ahead: 'En avance', on_track: 'Dans la cible', behind: 'En retard', over_quota: 'Quota dépassé', period_ended: 'Période terminée' } as const)[s];
}

function barColor(s: AccountState['status']): string {
  return ({ ahead: 'var(--accent)', on_track: 'var(--good)', behind: 'var(--warn)', over_quota: 'var(--bad)', period_ended: 'var(--fg-dim)' } as const)[s];
}
