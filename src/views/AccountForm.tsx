import { useEffect, useState } from 'react';
import type {
  Account,
  CollectionMethod,
  IsoWeekday,
  PeriodRule,
  PeriodType,
  Provider,
  Skill,
  Unit,
} from '@shared/types';
import { useAppStore } from '../store';
import { toast } from '../toast';

interface Props {
  initial?: Account;
  onSaved: () => void;
  onCancel: () => void;
}

const DEFAULT_RULE: PeriodRule = { type: 'monthly', dayOfMonth: 1, timezone: 'Europe/Paris' };

export function AccountForm({ initial, onSaved, onCancel }: Props): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [provider, setProvider] = useState<Provider>(initial?.provider ?? 'cursor');
  const [periodRule, setPeriodRule] = useState<PeriodRule>(initial?.periodRule ?? DEFAULT_RULE);
  const [quota, setQuota] = useState<number>(initial?.quota ?? 0);
  const [unit, setUnit] = useState<Unit>(initial?.unit ?? 'tokens');
  const [currency, setCurrency] = useState<string>(initial?.currency ?? 'EUR');
  const [collection, setCollection] = useState<CollectionMethod>(initial?.collection ?? 'manual');
  const [skillId, setSkillId] = useState<string | undefined>(initial?.skillId);
  const [skillParams, setSkillParams] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(initial?.skillParams ?? {}).map(([k, v]) => [k, String(v)])),
  );
  const [skillSecrets, setSkillSecrets] = useState<Record<string, string>>({}); // typed but never preloaded
  const [tolerancePct, setTolerancePct] = useState<number>(initial?.tolerancePct ?? 3);
  const [tagsCsv, setTagsCsv] = useState<string>((initial?.tags ?? []).join(', '));
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState<number>(initial?.syncIntervalMinutes ?? 0);
  const [alertThresholdsCsv, setAlertThresholdsCsv] = useState<string>(
    (initial?.alertThresholdsPct ?? [80, 100]).join(', '),
  );
  const [skills, setSkills] = useState<
    Array<Pick<Skill, 'id' | 'label' | 'requiredSecrets' | 'requiredParams'>>
  >([]);

  useEffect(() => {
    window.api.listSkills().then(setSkills);
  }, []);

  const selectedSkill = skills.find((s) => s.id === skillId);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const id = initial?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const tags = tagsCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const alertThresholdsPct = alertThresholdsCsv
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    const account: Account = {
      id,
      name,
      provider,
      periodRule,
      quota: Number(quota),
      unit,
      currency: unit === 'currency' ? currency : undefined,
      collection,
      skillId,
      skillParams: Object.keys(skillParams).length ? skillParams : undefined,
      tolerancePct: Number(tolerancePct),
      tags,
      syncIntervalMinutes: syncIntervalMinutes > 0 ? Number(syncIntervalMinutes) : undefined,
      alertThresholdsPct: alertThresholdsPct.length ? alertThresholdsPct : [80, 100],
      lastAlertedThresholdPct: initial?.lastAlertedThresholdPct,
      lastAlertPeriodStart: initial?.lastAlertPeriodStart,
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
    };
    await useAppStore.getState().upsertAccount(account);
    if (selectedSkill) {
      for (const key of selectedSkill.requiredSecrets) {
        const v = skillSecrets[key];
        if (v) {
          try {
            await window.api.setSecret(id, key, v);
          } catch (err) {
            toast.error(`Secret ${key} non sauvegardé : ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
    onSaved();
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <h2>{initial ? 'Éditer le compte' : 'Nouveau compte'}</h2>

      <label>
        Nom
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      <div className="row-form">
        <label>
          Fournisseur
          <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            <option value="cursor">Cursor</option>
            <option value="claude">Claude</option>
            <option value="openai">OpenAI</option>
            <option value="other">Autre</option>
          </select>
        </label>
        <label>
          Méthode de collecte
          <select value={collection} onChange={(e) => setCollection(e.target.value as CollectionMethod)}>
            <option value="manual">Manuelle</option>
            <option value="auto">Automatique</option>
            <option value="hybrid">Hybride</option>
          </select>
        </label>
      </div>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <legend className="muted">Période / Anniversaire</legend>
        <PeriodEditor rule={periodRule} onChange={setPeriodRule} />
      </fieldset>

      <div className="row-form">
        <label>
          Quota
          <input
            type="number"
            min={0}
            step="any"
            value={quota}
            onChange={(e) => setQuota(Number(e.target.value))}
            required
          />
        </label>
        <label>
          Unité
          <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
            <option value="tokens">Tokens</option>
            <option value="credits">Crédits</option>
            <option value="requests">Requêtes</option>
            <option value="currency">Devise</option>
          </select>
        </label>
      </div>

      {unit === 'currency' && (
        <label>
          Devise
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </label>
      )}

      <label>
        Tolérance (%) — zone considérée «&nbsp;dans la cible&nbsp;»
        <input
          type="number"
          min={0}
          max={50}
          step={0.5}
          value={tolerancePct}
          onChange={(e) => setTolerancePct(Number(e.target.value))}
        />
      </label>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <legend className="muted">Tags & automatismes</legend>
        <label>
          Tags (séparés par des virgules)
          <input
            value={tagsCsv}
            onChange={(e) => setTagsCsv(e.target.value)}
            placeholder="perso, dev, client-X"
          />
        </label>
        <label>
          Sync planifiée (minutes — 0 pour désactiver)
          <input
            type="number"
            min={0}
            value={syncIntervalMinutes}
            onChange={(e) => setSyncIntervalMinutes(Number(e.target.value))}
          />
        </label>
        <label>
          Seuils d&apos;alerte (% — séparés par des virgules)
          <input
            value={alertThresholdsCsv}
            onChange={(e) => setAlertThresholdsCsv(e.target.value)}
            placeholder="50, 80, 100"
          />
        </label>
      </fieldset>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <legend className="muted">Skill / connecteur (optionnel)</legend>
        <label>
          Skill
          <select
            value={skillId ?? ''}
            onChange={(e) => {
              setSkillId(e.target.value || undefined);
              setSkillParams({});
              setSkillSecrets({});
            }}
          >
            <option value="">{'— aucune —'}</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        {selectedSkill?.requiredParams.map((p) => (
          <label key={p}>
            {p}
            <input
              value={skillParams[p] ?? ''}
              onChange={(e) => setSkillParams({ ...skillParams, [p]: e.target.value })}
            />
          </label>
        ))}
        {selectedSkill?.requiredSecrets.map((s) => (
          <label key={s}>
            {s}{' '}
            <span className="muted" style={{ fontSize: 11 }}>
              (stocké chiffré via OS keychain)
            </span>
            <input
              type="password"
              value={skillSecrets[s] ?? ''}
              onChange={(e) => setSkillSecrets({ ...skillSecrets, [s]: e.target.value })}
              placeholder={initial ? '— inchangé —' : ''}
            />
          </label>
        ))}
      </fieldset>

      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="primary">
          Enregistrer
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function PeriodEditor({
  rule,
  onChange,
}: {
  rule: PeriodRule;
  onChange: (r: PeriodRule) => void;
}): JSX.Element {
  return (
    <>
      <label>
        Type
        <select value={rule.type} onChange={(e) => onChange({ ...rule, type: e.target.value as PeriodType })}>
          <option value="weekly">Hebdomadaire</option>
          <option value="monthly">Mensuelle</option>
          <option value="yearly">Annuelle</option>
          <option value="custom">Personnalisée</option>
        </select>
      </label>

      {rule.type === 'weekly' && (
        <label>
          Jour de la semaine
          <select
            value={rule.weekday ?? 1}
            onChange={(e) => onChange({ ...rule, weekday: Number(e.target.value) as IsoWeekday })}
          >
            {['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'].map((d, i) => (
              <option key={i + 1} value={i + 1}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}

      {rule.type === 'monthly' && (
        <label>
          Jour du mois (1-31, clamp si mois plus court)
          <input
            type="number"
            min={1}
            max={31}
            value={rule.dayOfMonth ?? 1}
            onChange={(e) => onChange({ ...rule, dayOfMonth: Number(e.target.value) })}
          />
        </label>
      )}

      {rule.type === 'yearly' && (
        <div className="row-form">
          <label>
            Mois (1-12)
            <input
              type="number"
              min={1}
              max={12}
              value={rule.month ?? 1}
              onChange={(e) => onChange({ ...rule, month: Number(e.target.value) })}
            />
          </label>
          <label>
            Jour (1-31)
            <input
              type="number"
              min={1}
              max={31}
              value={rule.day ?? 1}
              onChange={(e) => onChange({ ...rule, day: Number(e.target.value) })}
            />
          </label>
        </div>
      )}

      {rule.type === 'custom' && (
        <div className="row-form">
          <label>
            Date de début
            <input
              type="date"
              value={(rule.startDate ?? new Date().toISOString()).slice(0, 10)}
              onChange={(e) => onChange({ ...rule, startDate: new Date(e.target.value).toISOString() })}
            />
          </label>
          <label>
            Longueur (jours)
            <input
              type="number"
              min={1}
              value={rule.periodLengthDays ?? 30}
              onChange={(e) => onChange({ ...rule, periodLengthDays: Number(e.target.value) })}
            />
          </label>
        </div>
      )}

      <label>
        Timezone (IANA)
        <input
          value={rule.timezone}
          onChange={(e) => onChange({ ...rule, timezone: e.target.value })}
          placeholder="Europe/Paris"
        />
      </label>
    </>
  );
}
