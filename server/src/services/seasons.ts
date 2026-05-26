import { supabase } from '../lib/supabase';

export async function getOrCreateSeasonByYear(year: number, organizationId?: string | null) {
  const { data: existing, error: existingError } = await supabase
    .from('seasons')
    .select('*')
    .eq('year', year)
    .order('created_at', { ascending: true })
    .limit(1);

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (existing && existing.length > 0) {
    return existing[0];
  }

  const { data, error } = await supabase
    .from('seasons')
    .insert({
      name: String(year),
      year,
      organization_id: organizationId ?? null,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}