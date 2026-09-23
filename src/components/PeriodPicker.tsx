import React, { useId, useMemo } from 'react';
import { DateRange } from '../types';
import { inputClass } from './ui';
import {
  adToBs, bsMonthRange, BS_MONTHS, fiscalYearOf, isIsoDate, recentFiscalYears, todayNpt,
} from '../lib/nepaliDate';

/**
 * Period selection for reports.
 *
 * Every statement in this app takes an explicit range. The old build printed
 * "Financial Period ending September 2026" above figures that covered all time.
 */
export const PeriodPicker: React.FC<{
  value: DateRange; onChange: (r: DateRange) => void;
  fiscalStartMonth: number; calendar: 'BS' | 'AD';
}> = ({ value, onChange, fiscalStartMonth, calendar }) => {
  const presetId = useId();
  const today = todayNpt();

  const fiscalYears = useMemo(
    () => recentFiscalYears(4, fiscalStartMonth, today),
    [fiscalStartMonth, today],
  );

  const bsMonths = useMemo(() => {
    const now = adToBs(today);
    const out: { key: string; label: string; range: DateRange }[] = [];
    for (let i = 0; i < 6; i += 1) {
      let m = now.month - i;
      let y = now.year;
      while (m < 1) { m += 12; y -= 1; }
      const r = bsMonthRange(y, m);
      out.push({
        key: `${y}-${m}`, label: `${BS_MONTHS[m - 1]} ${y}`,
        range: { from: r.startAd, to: r.endAd > today ? today : r.endAd, label: r.label },
      });
    }
    return out;
  }, [today]);

  const applyPreset = (key: string) => {
    if (key === 'custom') return;
    if (key.startsWith('fy:')) {
      const fy = fiscalYears.find((f) => String(f.bsYear) === key.slice(3));
      if (fy) {
        onChange({ from: fy.startAd, to: fy.endAd > today ? today : fy.endAd, label: `FY ${fy.label}` });
      }
      return;
    }
    if (key.startsWith('m:')) {
      const month = bsMonths.find((m) => m.key === key.slice(2));
      if (month) onChange(month.range);
      return;
    }
    if (key === 'today') onChange({ from: today, to: today, label: 'Today' });
    if (key === 'all') onChange({ from: '1943-04-13', to: today, label: 'Since you started' });
  };

  const currentFy = fiscalYearOf(today, fiscalStartMonth);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label htmlFor={presetId} className="block text-[11px] font-medium text-zinc-500">Period</label>
        <select id={presetId} className={`${inputClass} min-w-[13rem]`} value="custom"
          onChange={(e) => applyPreset(e.target.value)}>
          <option value="custom">{value.label}</option>
          <optgroup label="Fiscal year (Shrawan–Ashadh)">
            {fiscalYears.map((fy) => (
              <option key={fy.bsYear} value={`fy:${fy.bsYear}`}>
                FY {fy.label}{fy.bsYear === currentFy.bsYear ? ' (current)' : ''}
              </option>
            ))}
          </optgroup>
          <optgroup label="Nepali month">
            {bsMonths.map((m) => <option key={m.key} value={`m:${m.key}`}>{m.label}</option>)}
          </optgroup>
          <optgroup label="Other">
            <option value="today">Today</option>
            <option value="all">Since you started</option>
          </optgroup>
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor={`${presetId}-from`} className="block text-[11px] font-medium text-zinc-500">From</label>
        <input id={`${presetId}-from`} type="date" className={inputClass} value={value.from} max={value.to}
          onChange={(e) => onChange({ ...value, from: e.target.value, label: 'Custom period' })} />
      </div>

      <div className="space-y-1">
        <label htmlFor={`${presetId}-to`} className="block text-[11px] font-medium text-zinc-500">To</label>
        <input id={`${presetId}-to`} type="date" className={inputClass} value={value.to} min={value.from} max={today}
          onChange={(e) => onChange({ ...value, to: e.target.value, label: 'Custom period' })} />
      </div>

      {/* The BS equivalent of a custom range, shown only while both ends are
          real dates: a cleared date input is `''`, and there is no BS month to
          name for a date that does not exist yet. */}
      {calendar === 'BS' && isIsoDate(value.from) && isIsoDate(value.to) && (
        <p className="text-[11px] text-zinc-400 pb-2">
          BS {(() => { const a = adToBs(value.from!); const b = adToBs(value.to!);
            return `${a.year}-${String(a.month).padStart(2, '0')}-${String(a.day).padStart(2, '0')} to ${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`; })()}
        </p>
      )}
    </div>
  );
};
