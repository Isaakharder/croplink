/**
 * A minimal, purpose-built mock of the subset of the Supabase query builder
 * these route tests actually use (.select/.eq/.in/.not/.gte/.lte/.order/
 * .single/.range, plus being directly awaitable without .range()). Not a
 * general-purpose Supabase mock — just enough surface area to drive
 * breakerLearning.ts / ripeningActuals.ts / measurementSummary.ts through
 * their real code paths with synthetic data.
 *
 * Faithful to production behavior in the two ways that matter for these
 * tests: awaiting a query directly (no .range()) caps at 1,000 rows, same
 * as Supabase's real default (config.toml api.max_rows = 1000) — and
 * .range() pagination only returns correct, complete, non-duplicated pages
 * when the query is ordered, exactly like the real system.
 */

type Row = Record<string, unknown>;

interface MockResult<T> { data: T[] | null; error: { message: string } | null }

export interface MockTableOptions {
  /** 1-indexed .range() call (across the whole test, not per query) to fail on. */
  errorOnRangeCall?: number;
  /** Default cap applied when a query is awaited without .range() — matches Supabase's real unpaginated behavior. */
  defaultCap?: number;
}

export class MockSupabase {
  private tables = new Map<string, Row[]>();
  private rangeCallCount = 0;
  private errorOnRangeCall?: number;
  private defaultCap: number;

  constructor(options: MockTableOptions = {}) {
    this.errorOnRangeCall = options.errorOnRangeCall;
    this.defaultCap = options.defaultCap ?? 1000;
  }

  seed(table: string, rows: Row[]): void {
    this.tables.set(table, rows);
  }

  from(table: string) {
    const allRows = this.tables.get(table) ?? [];
    return new MockQueryBuilder(allRows, this);
  }

  /** Called by MockQueryBuilder on every .range() invocation — tracks a single global counter so `errorOnRangeCall` can target "the Nth range() call across the whole test", matching how a real intermediate-page failure would look regardless of which query issues it. */
  _nextRangeCall(): { shouldError: boolean } {
    this.rangeCallCount++;
    return { shouldError: this.rangeCallCount === this.errorOnRangeCall };
  }

  _defaultCap(): number {
    return this.defaultCap;
  }
}

// Not formally `implements PromiseLike<...>` — `await` only needs a
// structurally-compatible `.then()`, and the real return shape varies by
// mode (single row vs. array), which PromiseLike's single type param can't
// express cleanly. TypeScript already checks the actual method signature.
class MockQueryBuilder<T extends Row> {
  private filters: ((row: T) => boolean)[] = [];
  private orderColumn: string | null = null;
  private orderAscending = true;
  private singleMode: 'none' | 'single' | 'maybeSingle' = 'none';

  constructor(private rows: T[], private client: MockSupabase) {}

  select(_cols?: string) { return this; }

  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  in(col: string, vals: unknown[]) {
    const set = new Set(vals);
    this.filters.push((r) => set.has(r[col]));
    return this;
  }

  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.filters.push((r) => r[col] != null);
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push((r) => (r[col] as string) >= (val as string));
    return this;
  }

  lte(col: string, val: unknown) {
    this.filters.push((r) => (r[col] as string) <= (val as string));
    return this;
  }

  order(col: string, opts?: { ascending: boolean }) {
    this.orderColumn = col;
    this.orderAscending = opts?.ascending ?? true;
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  private matched(): T[] {
    let result = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderColumn) {
      const col = this.orderColumn;
      result = [...result].sort((a, b) => {
        const av = a[col], bv = b[col];
        const cmp = av! < bv! ? -1 : av! > bv! ? 1 : 0;
        return this.orderAscending ? cmp : -cmp;
      });
    } else {
      // No ORDER BY specified — Postgres makes no ordering guarantee. To
      // actually exercise "does this route rely on unordered page-return
      // order", shuffle deterministically-but-non-sequentially (reverse)
      // rather than preserving insertion order by accident.
      result = [...result].reverse();
    }
    return result;
  }

  async range(from: number, to: number): Promise<MockResult<T>> {
    const { shouldError } = this.client._nextRangeCall();
    if (shouldError) {
      return { data: null, error: { message: 'simulated intermediate-page error' } };
    }
    const matched = this.matched();
    return { data: matched.slice(from, to + 1), error: null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    const matched = this.matched();
    let result: { data: unknown; error: { message: string } | null };
    if (this.singleMode === 'single') {
      result = matched.length === 1
        ? { data: matched[0], error: null }
        : { data: null, error: { message: matched.length === 0 ? 'no rows found' : 'multiple rows found' } };
    } else if (this.singleMode === 'maybeSingle') {
      result = { data: matched[0] ?? null, error: null };
    } else {
      // Un-ranged await — same default cap Supabase applies for real.
      result = { data: matched.slice(0, this.client._defaultCap()), error: null };
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}
