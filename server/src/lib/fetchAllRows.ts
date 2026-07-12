// Supabase/PostgREST caps results at a server-configured max (commonly 1000)
// regardless of the `.limit()` value a query requests — it fails silently,
// not with an error, so a batch bigger than that limit gets silently
// truncated instead of failing loudly. Anything that can plausibly exceed
// that in a large import batch must page through with `.range()`.
export async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
