
import { createClient } from '@supabase/supabase-js';

const getEnv = (key: string): string | undefined => {
  let value: string | undefined;
  try {
    // @ts-ignore
    if (typeof process !== 'undefined' && process.env) {
      value = process.env[key];
    }
    // @ts-ignore
    if (!value && typeof import.meta !== 'undefined' && (import.meta as any).env) {
      value = (import.meta as any).env[key];
    }
  } catch (e) {
    console.debug(`Nu s-a putut accesa variabila ${key}:`, e);
  }
  return value;
};

const supabaseUrl = getEnv('VITE_SUPABASE_URL');
const supabaseAnonKey = getEnv('VITE_SUPABASE_ANON_KEY');

const isConfigured = !!supabaseUrl && !!supabaseAnonKey;

export const supabase = isConfigured 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

/**
 * Recuperează TOATE conversațiile salvate, ordonate cronologic.
 */
export async function fetchAllConversations(): Promise<{date: string, content: string}[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('daily_conversations')
      .select('conversation_date, content')
      .order('conversation_date', { ascending: true });

    if (error) throw error;
    return data?.map(d => ({ date: d.conversation_date, content: d.content })) || [];
  } catch (err) {
    console.error('Eroare la recuperarea istoricului complet:', err);
    return [];
  }
}

/**
 * Recuperează conversația salvată pentru ziua curentă.
 */
export async function fetchTodayConversation(): Promise<string | null> {
  if (!supabase) return null;

  const today = new Date().toISOString().split('T')[0];

  try {
    const { data, error } = await supabase
      .from('daily_conversations')
      .select('content')
      .eq('conversation_date', today)
      .maybeSingle();

    if (error) throw error;
    return data?.content || null;
  } catch (err) {
    console.error('Eroare la recuperarea conversației de azi:', err);
    return null;
  }
}

/**
 * Salvează o NOUĂ conversație în baza de date.
 * Folosește .insert() pentru a evita suprascrierea (upsert).
 */
export async function saveConversation(content: string) {
  if (!content || !supabase) return;

  // Folosim timestamp complet pentru a evita conflictele de dată dacă sunt mai multe sesiuni pe zi
  const timestamp = new Date().toISOString();

  try {
    const { error } = await supabase
      .from('daily_conversations')
      .insert({ 
        conversation_date: timestamp, 
        content: content,
        updated_at: timestamp
      });

    if (error) {
      if (error.code === '401' || error.message.includes('Invalid API key')) {
        (window as any).SUPABASE_DISABLED = true;
      }
      throw error;
    }
  } catch (err) {
    console.error('Eroare la inserarea în DB:', err);
  }
}
