// Grower AFW Forecast editor (Projections page). Expected AFW in grams per
// ISO week, current week through pull-out. Saved forecasts feed the
// EXPERIMENTAL projections only; the legacy projection is unchanged and shown
// beside them for comparison. GrowLink actual AFW is shown read-only.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AfwForecastEditorModel, ForecastLabView, ForecastLabModelId } from '../types';
import { afwForecastsApi, forecastLabApi } from '../services/api';
import { initDraft, validateDraft, changedWeeks, isDirty, buildChanges, fillForward, previewUsed, SOURCE_SHORT, AfwDraft } from '../utils/afwForecastDraft';

const UNSAVED = 'You have unsaved AFW forecast changes. Leave without saving?';

/** Warn before losing unsaved edits: tab close/reload, and in-app link clicks (BrowserRouter has no navigation blocker). */
function useUnsavedChangesWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = UNSAVED; return UNSAVED; };
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]');
      if (!a || (a as HTMLAnchorElement).target === '_blank') return;
      if (!window.confirm(UNSAVED)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', click, true); };
  }, [dirty]);
}

const EXPERIMENTAL: ForecastLabModelId[] = ['open-fruit-d', 'interval-censored-recent'];
const MODEL_SHORT: Record<string, string> = { 'open-fruit-d': 'Open-fruit D', 'interval-censored-recent': 'Interval-censored' };
const kg = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString());
const sourceClass = (s: string | undefined) => (s?.startsWith('manual') ? 'badge badge-blue' : s === 'growlink-settled' ? 'badge badge-green' : 'badge badge-gray');

export function AfwForecastEditor({ varietyId, year, onDirtyChange }: { varietyId: string; year: number; onDirtyChange?: (dirty: boolean) => void }) {
  const [model, setModel] = useState<AfwForecastEditorModel | null>(null);
  const [draft, setDraft] = useState<AfwDraft>({});
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [savedMsg, setSavedMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [lab, setLab] = useState<ForecastLabView | null>(null);
  const [labError, setLabError] = useState('');
  const [labLoading, setLabLoading] = useState(false);

  const loadLab = useCallback(() => {
    setLabLoading(true);
    setLabError('');
    forecastLabApi.view(year, varietyId, 1)
      .then(setLab)
      .catch((e) => { setLab(null); setLabError(e instanceof Error ? e.message : 'Failed to load experimental projections'); })
      .finally(() => setLabLoading(false));
  }, [year, varietyId]);

  const load = useCallback(() => {
    setLoadError('');
    setModel(null);
    afwForecastsApi.get(varietyId)
      .then((m) => { setModel(m); setDraft(initDraft(m.weeks)); })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Failed to load AFW forecasts'));
  }, [varietyId]);

  useEffect(() => { load(); loadLab(); setSavedMsg(''); setNotices([]); setServerErrors({}); setSaveError(''); }, [load, loadLab]);

  const weeks = model?.weeks ?? [];
  const dirty = model ? isDirty(draft, weeks) : false;
  useUnsavedChangesWarning(dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const validation = useMemo(() => validateDraft(draft, weeks), [draft, weeks]);
  const preview = useMemo(() => (model ? previewUsed(draft, weeks, model.baseline) : []), [draft, weeks, model]);
  const changed = useMemo(() => new Set(changedWeeks(draft, weeks).map((w) => w.label)), [draft, weeks]);
  const hasErrors = Object.keys(validation.errors).length > 0;

  async function save() {
    if (!model || hasErrors || !dirty) return;
    setSaving(true);
    setSaveError('');
    setServerErrors({});
    setSavedMsg('');
    try {
      const r = await afwForecastsApi.save(varietyId, model.latestEntryId, buildChanges(draft, weeks));
      if (!r.ok) {
        setSaveError(r.error);
        setServerErrors(Object.fromEntries(r.errors.map((e) => [`${e.year}-W${String(e.week).padStart(2, '0')}`, e.reason])));
        return;
      }
      setModel(r.model);
      setDraft(initDraft(r.model.weeks));
      setNotices(r.model.notices ?? []);
      setSavedMsg(`Saved ${r.model.saved ?? 0} week${r.model.saved === 1 ? '' : 's'}. Experimental projections recalculated below.`);
      loadLab(); // projections recompute on the server as soon as the forecast is stored
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (model && window.confirm('Discard your unsaved AFW forecast changes?')) setDraft(initDraft(model.weeks));
  }

  if (loadError) {
    return (
      <div className="projections-card projections-card--full">
        <h3 className="projections-card-title">AFW Forecast</h3>
        <div className="alert alert-error">{loadError}</div>
      </div>
    );
  }
  if (!model) return <div className="projections-card projections-card--full"><div className="loading">Loading AFW forecasts…</div></div>;

  const futureLab = (lab?.weeks ?? []).filter((w) => !w.past).slice(0, 8);

  return (
    <div className="projections-card projections-card--full">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 className="projections-card-title" style={{ marginBottom: 0 }}>
          AFW Forecast — {model.variety.name} <span className="badge badge-yellow" title="Used by the experimental projections only">Experimental projections</span>
        </h3>
        <div style={{ fontSize: 12, color: 'var(--gray-500)' }}>
          {model.window.from} → {model.window.to}{model.window.pullOutKnown ? ` (pull-out ${model.variety.pullOutDate})` : ''}
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--gray-600)', margin: '6px 0 10px' }}>
        Expected average fruit weight (g) per packing week. A week without its own value uses the most recent earlier week's value;
        before any value, the latest settled GrowLink AFW{model.baseline ? ` (${model.baseline.grams.toFixed(1)} g, ${model.baseline.fromWeek})` : ''}.
        This never changes GrowLink actuals or the legacy projection.
      </p>
      {model.warnings.map((w) => <div key={w} className="warning-banner">⚠ {w}</div>)}

      <div style={{ overflowX: 'auto' }}>
        <table className="calc-table afw-table">
          <thead>
            <tr>
              <th>Week</th>
              <th title="Grams. Leave empty to use the carried-forward or GrowLink value.">Forecast AFW (g)</th>
              <th></th>
              <th>Projection uses</th>
              <th title="Measured in GrowLink. Read-only.">GrowLink actual</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w, i) => {
              const p = preview[i];
              const err = validation.errors[w.label] ?? serverErrors[w.label];
              const note = validation.notices[w.label];
              return (
                <tr key={w.label} style={changed.has(w.label) ? { background: 'var(--yellow-50, #fffbeb)' } : undefined}>
                  <td>
                    <strong>W{w.week}</strong> <span style={{ color: 'var(--gray-500)', fontSize: 12 }}>{w.year}</span>
                    {w.current && <span className="badge badge-gray" style={{ marginLeft: 6 }}>this week</span>}
                    {w.harvestWindow < 1 && <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>pull-out: {Math.round(w.harvestWindow * 7)}/7 days</div>}
                  </td>
                  <td>
                    <input
                      className="form-control"
                      inputMode="decimal"
                      aria-label={`Forecast AFW for ${w.label}`}
                      style={{ width: 96, borderColor: err ? 'var(--red-500, #ef4444)' : undefined }}
                      value={draft[w.label] ?? ''}
                      placeholder={p && p.source !== 'manual-exact' ? p.grams.toFixed(1) : ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [w.label]: e.target.value }))}
                    />
                    {err && <div style={{ fontSize: 11, color: 'var(--red-600, #dc2626)' }}>{err}</div>}
                    {!err && note && <div style={{ fontSize: 11, color: 'var(--yellow-700, #a16207)' }}>{note}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn btn-sm" disabled={!draft[w.label]?.trim() || i === weeks.length - 1} title="Copy to the next week" onClick={() => setDraft((d) => fillForward(d, weeks, w.label, 'next'))}>→ next</button>{' '}
                    <button type="button" className="btn btn-sm" disabled={!draft[w.label]?.trim() || i === weeks.length - 1} title="Fill later EMPTY weeks with this value (keeps weeks you already set)" onClick={() => setDraft((d) => fillForward(d, weeks, w.label, 'empty'))}>Fill empty ↓</button>{' '}
                    <button type="button" className="btn btn-sm" disabled={!draft[w.label]?.trim() || i === weeks.length - 1} title="Overwrite ALL later weeks with this value" onClick={() => setDraft((d) => fillForward(d, weeks, w.label, 'all'))}>Fill all ↓</button>{' '}
                    <button type="button" className="btn btn-sm" disabled={!draft[w.label]?.trim()} title="Remove this week's forecast (it will use the carried-forward or GrowLink value)" onClick={() => setDraft((d) => ({ ...d, [w.label]: '' }))}>Clear</button>
                  </td>
                  <td>
                    {p ? (
                      <>
                        <span className={sourceClass(p.source)}>{SOURCE_SHORT[p.source]}</span>{' '}
                        <strong>{p.grams.toFixed(1)} g</strong>
                        {p.source !== 'manual-exact' && <span style={{ fontSize: 11, color: 'var(--gray-500)' }}> from {p.fromWeek}</span>}
                      </>
                    ) : <span style={{ color: 'var(--gray-500)' }}>No AFW known</span>}
                  </td>
                  <td>{w.growlinkActual ? `${w.growlinkActual.grams.toFixed(1)} g${w.growlinkActual.settled ? '' : ' (not settled)'}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={!dirty || hasErrors || saving} onClick={save}>{saving ? 'Saving…' : 'Save AFW forecast'}</button>
        <button type="button" className="btn" disabled={!dirty || saving} onClick={discard}>Discard changes</button>
        {dirty && <span style={{ fontSize: 12, color: 'var(--yellow-700, #a16207)' }}>Unsaved changes ({changed.size} week{changed.size === 1 ? '' : 's'})</span>}
        {hasErrors && <span style={{ fontSize: 12, color: 'var(--red-600, #dc2626)' }}>Fix the highlighted weeks to save</span>}
      </div>
      {saveError && <div className="alert alert-error mt-2">{saveError}{saveError.includes('changed since') && <> <button type="button" className="btn btn-sm" onClick={load}>Reload</button></>}</div>}
      {savedMsg && <div className="alert alert-success mt-2">{savedMsg}</div>}
      {notices.map((n) => <div key={n} className="warning-banner">⚠ {n}</div>)}

      <h4 style={{ margin: '18px 0 6px' }}>Projected kg with these AFW forecasts <span className="badge badge-yellow">Experimental — not validated</span></h4>
      {labError && <div className="alert alert-error">{labError}</div>}
      {labLoading && <div className="loading">Recalculating…</div>}
      {lab && !labLoading && (
        <>
          <div style={{ fontSize: 12, color: 'var(--gray-500)', marginBottom: 6 }}>
            As of {lab.asOf.label}. Legacy is the current Projections-page forecast (it uses its own AFW series, not these forecasts) — kept for comparison.
            {!lab.freshness.snapshotsEnabled && ' Forecasts are computed live and not yet locked.'}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="calc-table">
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Legacy kg</th>
                  {EXPERIMENTAL.map((m) => <th key={m}>{MODEL_SHORT[m]} kg <span style={{ fontWeight: 400, fontSize: 11 }}>(p10–p90)</span></th>)}
                  <th>AFW used</th>
                </tr>
              </thead>
              <tbody>
                {futureLab.map((w) => {
                  const d = w.models['open-fruit-d'];
                  return (
                    <tr key={w.label}>
                      <td><strong>W{w.week}</strong> <span style={{ color: 'var(--gray-500)', fontSize: 12 }}>{w.year}</span></td>
                      <td className="num-cell">{kg(w.legacyKg)}</td>
                      {EXPERIMENTAL.map((m) => {
                        const c = w.models[m];
                        return (
                          <td key={m} className="num-cell" title={c?.warnings.join('\n')}>
                            {kg(c?.kg)}
                            {c?.low != null && c?.high != null && <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>{kg(c.low)}–{kg(c.high)}</div>}
                            {c?.lockedKg != null && <div style={{ fontSize: 10, color: 'var(--gray-500)' }} title="Locked before the AFW change; the locked value is the one scored">locked: {kg(c.lockedKg)}</div>}
                          </td>
                        );
                      })}
                      <td>
                        {d?.afwG != null ? (
                          <><span className={sourceClass(d.afwSource ?? undefined)}>{SOURCE_SHORT[(d.afwSource ?? 'croplink-manual') as keyof typeof SOURCE_SHORT] ?? d.afwSource}</span> {d.afwG.toFixed(1)} g</>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, marginTop: 6 }}><Link to="/forecast-lab">Open the Forecast Lab</Link> for history, actuals and accuracy.</div>
        </>
      )}
    </div>
  );
}
