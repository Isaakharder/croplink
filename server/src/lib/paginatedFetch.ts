/**
 * Supabase/PostgREST returns at most 1,000 rows per query by default
 * (config.toml: api.max_rows = 1000), silently — no error, no truncation
 * flag, just fewer rows than actually match. Any `.select()` without
 * `.range()` on a query that can plausibly exceed 1,000 rows needs this.
 *
 * Confirmed live and load-bearing: Mathieu (a bell pepper variety) alone
 * has 2,259 plant_nodes under its 56 tracked stems (many nodes per stem —
 * main positions plus side-shoots accumulated over the season). A plain, unpaginated
 * `plant_nodes.select().in('measurement_stem_id', stemIds)` silently
 * returned only 1,000 of them. Confirmed against a `count: 'exact'` query
 * (2,259) vs. the plain select's actual row count (1,000).
 *
 * Ordering matters, not just batching: Postgres makes no row-order
 * guarantee for a query without ORDER BY, including across repeated
 * requests for the same query. Paging with `.range()` alone can silently
 * skip or duplicate rows between pages if the server re-plans or
 * re-orders between calls. This helper enforces a stable, unique sort
 * (primary key `id` ascending by default) by applying `.order()` itself,
 * inside the same builder chain as `.range()`, on every page — callers
 * cannot construct an unordered paginated query through this API.
 *
 * Memory: every page is accumulated into one in-memory array and returned
 * only once the full result is assembled — there is no streaming/cursor
 * mode. Acceptable at today's volumes (the largest confirmed table this
 * is used against is ~2,300 rows for one variety's plant_nodes; a whole
 * farm across every tracked variety is still a small multiple of that,
 * not an order-of-magnitude jump). This stops being acceptable if a
 * caller ever needs a genuinely large unbounded table (hundreds of
 * thousands of rows) — at that point this helper needs a streaming/
 * generator variant instead of a documentation note.
 */

interface RangeableQuery<T> {
  order(column: string, opts: { ascending: boolean }): RangeableQuery<T>;
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}

export interface FetchAllRowsOptions {
  /** Unique column to sort by for stable pagination. Defaults to 'id' — every table this helper is used against has a UUID primary key named `id`. */
  orderColumn?: string;
  pageSize?: number;
}

/**
 * `buildQuery` must be a FACTORY — called once per page — returning a
 * fresh, unordered, unranged Supabase query builder (filters already
 * applied via .eq()/.in()/etc.). This helper appends `.order(orderColumn,
 * {ascending: true}).range(from, to)` itself, so ordering is structural,
 * not something each call site has to remember. Passing the same builder
 * instance across pages would be a bug (Supabase builders are typically
 * single-use / already-resolved after their first range/await), which is
 * exactly why this takes a factory instead of a builder.
 */
export async function fetchAllRows<T>(
  buildQuery: () => RangeableQuery<T>,
  options: FetchAllRowsOptions = {}
): Promise<T[]> {
  const orderColumn = options.orderColumn ?? 'id';
  const pageSize = options.pageSize ?? 1000;
  if (pageSize <= 0) throw new Error('fetchAllRows: pageSize must be > 0');

  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery()
      .order(orderColumn, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
