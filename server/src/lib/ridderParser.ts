// Shared Ridder "Block Summary" CSV parser. Pure functions only — no DB access —
// so both the browser-upload route and (later) the Climate Agent can call the
// exact same parsing/validation logic and get identical results.

export const GREENHOUSE_TIME_ZONE = 'America/Toronto';

export interface ZoneReading {
  zoneLabel: string;
  metricName: string;
  value: number;
  unit: string;
}

export interface TimestampResolution {
  /** Resolved greenhouse-local wall-clock time, normalized to the top of the hour. */
  measuredAtUtc: Date;
  /** Full-precision filename timestamp (includes seconds), converted to UTC. */
  filenameTimestampUtc: Date | null;
  weekNumber: number | null;
  /** Date-level conflict (filename/date-row/week-number disagreement) — unrelated to the hour checks below. */
  conflict: boolean;
  warning: string | null;
  /** True when the evidence is genuinely ambiguous and this file should not be auto-imported. */
  unresolvable: boolean;
  /** Raw "System Time" cell text, preserved for audit even though the filename hour is authoritative. */
  systemTimeRaw: string | null;
  /** Raw "System Date" cell text, preserved for audit. */
  systemDateRaw: string | null;
  /**
   * Signed circular difference in minutes between the System Time row's hour
   * and the filename's hour (rowHour - filenameHour, wrapped to (-12h, 12h]).
   * Null when there is no System Time row, or no filename hour, to compare.
   */
  hourDifferenceMinutes: number | null;
  /** True only for a >1 hour discrepancy — this file must not auto-import; it needs an explicit confirmation. */
  hourConflict: boolean;
  hourResolutionReason:
    | 'agreement'
    | 'no_system_time'
    | 'no_filename_hour'
    | 'stale_one_hour_accepted'
    | 'ahead_one_hour_accepted'
    | 'large_discrepancy_requires_confirmation';
  /** Human-readable explanation of the hour resolution — null when hours agree and nothing needs saying. */
  hourWarning: string | null;
}

export interface ParsedRidderFile {
  filename: string;
  zoneLabels: string[];
  /** Zone-level readings: one per (zone, metric) — air temp, RH, CO2, EC, pH, irrigation. */
  zoneReadings: ZoneReading[];
  /** Phase/group-level readings (sparse — only present under one "anchor" zone column per group): Radiation, Drain Water %. */
  phaseLevelReadings: ZoneReading[];
  timestamp: TimestampResolution;
  ignoredRows: string[];
  errors: string[];
}

// metric_name values (see climate_readings migration comment) plus the new
// irrigation metric this pipeline introduces.
const ZONE_METRICS: { match: RegExp; metricName: string; unit: string }[] = [
  { match: /air temperature/i, metricName: 'temperature_c', unit: '°C' },
  { match: /^rh\b/i, metricName: 'relative_humidity_pct', unit: '%' },
  { match: /co2 concentration/i, metricName: 'co2_ppm', unit: 'ppm' },
  { match: /average ec/i, metricName: 'ec', unit: 'mS/cm' },
  { match: /average ph/i, metricName: 'ph', unit: '' },
  { match: /cumulative irrigation/i, metricName: 'irrigation_cumulative_ml', unit: 'ml' },
];

const PHASE_METRICS: { match: RegExp; metricName: string; unit: string }[] = [
  { match: /radiation sum/i, metricName: 'radiation_sum_j_cm2', unit: 'J/cm²' },
  { match: /drain water/i, metricName: 'drain_water_pct', unit: '%' },
];

const IGNORED_LABELS = [/group activation time/i, /weather system/i, /sunrise/i, /sunset/i];
const SYSTEM_TIME_LABEL = /^system time/i;
const SYSTEM_DATE_LABEL = /^system date/i;
const WEEK_NUMBER_LABEL = /^week number/i;
const ZONE_HEADER_CELL = /^zone\s*\d+$/i;

/** Minimal CSV line splitter — handles double-quoted fields with "" escapes. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/** ISO week number for a plain calendar date (timezone-independent). */
export function isoWeekForDate(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Converts a wall-clock date/time in `timeZone` to the correct UTC instant,
 * using Intl's IANA tz database (no external dependency). One correction
 * pass is sufficient outside of the ~1x/year DST-transition ambiguity window.
 */
export function zonedTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number, second: number,
  timeZone: string
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(guess));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hourPart = map.hour === '24' ? 0 : Number(map.hour);
  const asIfUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hourPart, Number(map.minute), Number(map.second));
  const offsetMs = asIfUtc - guess;
  return new Date(guess - offsetMs);
}

interface DateCandidate {
  label: string;
  year: number;
  month: number;
  day: number;
}

/**
 * Signed circular difference in hours between two hour-of-day values,
 * wrapped to (-12, 12] so a wrap across midnight (e.g. 23 vs 0) reads as
 * a 1-hour difference rather than 23.
 */
function circularHourDiff(a: number, b: number): number {
  let d = a - b;
  d = (((d + 12) % 24) + 24) % 24 - 12;
  return d;
}

function resolveTimestamp(filename: string, systemDateRaw: string | null, systemTimeRaw: string | null, weekNumberRaw: string | null): TimestampResolution {
  const filenameMatch = filename.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  const filenameParts = filenameMatch
    ? {
        year: Number(filenameMatch[1]), month: Number(filenameMatch[2]), day: Number(filenameMatch[3]),
        hour: Number(filenameMatch[4]), minute: Number(filenameMatch[5]), second: Number(filenameMatch[6]),
      }
    : null;

  const timeMatch = systemTimeRaw?.match(/(\d{1,2}):(\d{2})/);
  const rowHour = timeMatch ? Number(timeMatch[1]) : null;
  const rowMinute = timeMatch ? Number(timeMatch[2]) : null;

  const dateMatch = systemDateRaw?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const weekNumber = weekNumberRaw ? parseInt(weekNumberRaw, 10) : null;

  const candidates: DateCandidate[] = [];
  if (filenameParts) candidates.push({ label: 'filename', year: filenameParts.year, month: filenameParts.month, day: filenameParts.day });
  if (dateMatch) {
    candidates.push({ label: 'date-row-as-dd/mm/yyyy', year: Number(dateMatch[3]), month: Number(dateMatch[2]), day: Number(dateMatch[1]) });
    if (dateMatch[1] !== dateMatch[2]) {
      candidates.push({ label: 'date-row-as-mm/dd/yyyy', year: Number(dateMatch[3]), month: Number(dateMatch[1]), day: Number(dateMatch[2]) });
    }
  }

  if (candidates.length === 0) {
    return {
      measuredAtUtc: new Date(NaN), filenameTimestampUtc: null, weekNumber, conflict: true,
      warning: 'No usable timestamp found in filename or System date/time rows.', unresolvable: true,
      systemTimeRaw: systemTimeRaw ?? null, systemDateRaw: systemDateRaw ?? null,
      hourDifferenceMinutes: null, hourConflict: false, hourResolutionReason: 'no_filename_hour', hourWarning: null,
    };
  }

  const withWeeks = candidates.map((c) => ({ ...c, isoWeek: isoWeekForDate(c.year, c.month, c.day) }));
  const matchingWeek = weekNumber != null ? withWeeks.filter((c) => c.isoWeek === weekNumber) : withWeeks;

  let chosen: DateCandidate;
  let conflict = false;
  let warning: string | null = null;
  let unresolvable = false;

  const allAgree = withWeeks.every((c) => c.year === withWeeks[0].year && c.month === withWeeks[0].month && c.day === withWeeks[0].day);

  if (allAgree && (weekNumber == null || withWeeks[0].isoWeek === weekNumber)) {
    chosen = withWeeks[0];
  } else if (matchingWeek.length === 0) {
    // Nothing matches the reported week number at all — genuinely ambiguous.
    chosen = withWeeks[0];
    conflict = true;
    unresolvable = true;
    warning = `None of the candidate dates (${withWeeks.map((c) => `${c.label}=${c.year}-${c.month}-${c.day} (wk${c.isoWeek})`).join(', ')}) match the reported week number ${weekNumber}. Timestamp is ambiguous — not auto-imported.`;
  } else if (matchingWeek.length > 1 && !matchingWeek.every((c) => c.year === matchingWeek[0].year && c.month === matchingWeek[0].month && c.day === matchingWeek[0].day)) {
    // More than one distinct date matches the week number — still ambiguous.
    chosen = matchingWeek[0];
    conflict = true;
    unresolvable = true;
    warning = `Multiple different dates are consistent with week ${weekNumber} (${matchingWeek.map((c) => `${c.label}=${c.year}-${c.month}-${c.day}`).join(', ')}). Timestamp is ambiguous — not auto-imported.`;
  } else {
    // Exactly one distinct date (possibly named by several candidates) matches the week number.
    chosen = matchingWeek[0];
    conflict = !allAgree;
    if (conflict) {
      const disagreeing = withWeeks.filter((c) => c.year !== chosen.year || c.month !== chosen.month || c.day !== chosen.day);
      warning = `Timestamp conflict resolved using week ${weekNumber}: accepted ${chosen.label} (${chosen.year}-${String(chosen.month).padStart(2, '0')}-${String(chosen.day).padStart(2, '0')}); disagreed with ${disagreeing.map((c) => `${c.label}=${c.year}-${c.month}-${c.day}`).join(', ')}.`;
    }
  }

  // The filename hour is authoritative for the canonical bucket — it agrees
  // with System Time for the overwhelming majority of files, and in every
  // observed disagreement case the filename hour was corroborated by the
  // surrounding hourly trend while the System Time hour left a gap. System
  // Time is used only to validate, never to silently override the filename.
  const hour = filenameParts?.hour ?? rowHour ?? 0;
  const minute = rowMinute ?? filenameParts?.minute ?? 0;

  let hourDifferenceMinutes: number | null = null;
  let hourConflict = false;
  let hourResolutionReason: TimestampResolution['hourResolutionReason'];
  let hourWarning: string | null = null;

  if (rowHour == null) {
    hourResolutionReason = 'no_system_time';
  } else if (filenameParts == null) {
    hourResolutionReason = 'no_filename_hour';
  } else {
    const diff = circularHourDiff(rowHour, filenameParts.hour);
    hourDifferenceMinutes = diff * 60;
    if (diff === 0) {
      hourResolutionReason = 'agreement';
    } else if (diff === -1) {
      hourResolutionReason = 'stale_one_hour_accepted';
      hourWarning = `Ridder's internal System Time (hour ${rowHour}) was stale by 1 hour behind the filename (hour ${filenameParts.hour}). The filename hour was used.`;
    } else if (diff === 1) {
      hourResolutionReason = 'ahead_one_hour_accepted';
      hourWarning = `Ridder's internal System Time (hour ${rowHour}) was 1 hour ahead of the filename (hour ${filenameParts.hour}). The filename hour was used.`;
    } else {
      hourResolutionReason = 'large_discrepancy_requires_confirmation';
      hourConflict = true;
      hourWarning = `Ridder's internal System Time (hour ${rowHour}) differs from the filename (hour ${filenameParts.hour}) by ${Math.abs(diff)} hours — this is larger than the known 1-hour staleness quirk and needs explicit confirmation before import.`;
    }
  }

  const measuredAtUtc = unresolvable
    ? new Date(NaN)
    : zonedTimeToUtc(chosen.year, chosen.month, chosen.day, hour, 0, 0, GREENHOUSE_TIME_ZONE); // normalized to top of hour, filename-hour authoritative

  const filenameTimestampUtc = filenameParts
    ? zonedTimeToUtc(filenameParts.year, filenameParts.month, filenameParts.day, filenameParts.hour, filenameParts.minute, filenameParts.second, GREENHOUSE_TIME_ZONE)
    : null;

  return {
    measuredAtUtc, filenameTimestampUtc, weekNumber, conflict, warning, unresolvable,
    systemTimeRaw: systemTimeRaw ?? null, systemDateRaw: systemDateRaw ?? null,
    hourDifferenceMinutes, hourConflict, hourResolutionReason, hourWarning,
  };
}

export function parseRidderBlockSummary(filename: string, content: string): ParsedRidderFile {
  const errors: string[] = [];
  const ignoredRows: string[] = [];
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = lines.map(parseCsvLine);

  const headerRowIdx = rows.findIndex((r) => r.filter((c) => ZONE_HEADER_CELL.test(c)).length >= 2);
  if (headerRowIdx === -1) {
    errors.push('Could not find a zone header row (expected cells like "Zone 1", "Zone 2", ...).');
    return {
      filename, zoneLabels: [], zoneReadings: [], phaseLevelReadings: [],
      timestamp: {
        measuredAtUtc: new Date(NaN), filenameTimestampUtc: null, weekNumber: null, conflict: true, warning: null, unresolvable: true,
        systemTimeRaw: null, systemDateRaw: null, hourDifferenceMinutes: null, hourConflict: false, hourResolutionReason: 'no_system_time', hourWarning: null,
      },
      ignoredRows, errors,
    };
  }

  const headerRow = rows[headerRowIdx];
  // Column 0 is the row label; columns 1..N are zones (only where the header cell matches "Zone N").
  const zoneColumns: { index: number; label: string }[] = [];
  for (let i = 1; i < headerRow.length; i++) {
    if (ZONE_HEADER_CELL.test(headerRow[i])) zoneColumns.push({ index: i, label: headerRow[i] });
  }
  const zoneLabels = zoneColumns.map((z) => z.label);

  const zoneReadings: ZoneReading[] = [];
  const phaseLevelReadings: ZoneReading[] = [];
  let systemDateRaw: string | null = null;
  let systemTimeRaw: string | null = null;
  let weekNumberRaw: string | null = null;

  for (let r = 0; r < rows.length; r++) {
    if (r === headerRowIdx) continue;
    const row = rows[r];
    const label = (row[0] ?? '').trim();
    if (!label) continue;

    if (SYSTEM_TIME_LABEL.test(label)) { systemTimeRaw = row[1] ?? null; continue; }
    if (SYSTEM_DATE_LABEL.test(label)) { systemDateRaw = row[1] ?? null; continue; }
    if (WEEK_NUMBER_LABEL.test(label)) { weekNumberRaw = row[1] ?? null; continue; }
    if (IGNORED_LABELS.some((re) => re.test(label))) continue;

    const zoneMetric = ZONE_METRICS.find((m) => m.match.test(label));
    if (zoneMetric) {
      for (const zc of zoneColumns) {
        const value = parseNumber(row[zc.index]);
        if (value != null) zoneReadings.push({ zoneLabel: zc.label, metricName: zoneMetric.metricName, value, unit: zoneMetric.unit });
      }
      continue;
    }

    const phaseMetric = PHASE_METRICS.find((m) => m.match.test(label));
    if (phaseMetric) {
      for (const zc of zoneColumns) {
        const value = parseNumber(row[zc.index]);
        if (value != null) phaseLevelReadings.push({ zoneLabel: zc.label, metricName: phaseMetric.metricName, value, unit: phaseMetric.unit });
      }
      continue;
    }

    ignoredRows.push(label);
  }

  const timestamp = resolveTimestamp(filename, systemDateRaw, systemTimeRaw, weekNumberRaw);
  if (timestamp.unresolvable) errors.push(timestamp.warning ?? 'Timestamp could not be resolved.');

  return { filename, zoneLabels, zoneReadings, phaseLevelReadings, timestamp, ignoredRows, errors };
}
