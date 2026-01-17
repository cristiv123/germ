
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

if (!supabase) {
  console.warn("[Supabase] Clientul Supabase nu a putut fi inițializat. Verifică variabilele de mediu.");
}

/**
 * Recuperează TOATE conversațiile salvate, ordonate cronologic.
 */
export async function fetchAllConversations(): Promise<{date: string, content: string}[]> {
  if (!supabase) return [];

  try {
    console.log("[Supabase] Executare fetchAllConversations...");
    const { data, error } = await supabase
      .from('daily_conversations')
      .select('conversation_date, content')
      .order('conversation_date', { ascending: true });

    if (error) throw error;
    return data?.map(d => ({ date: d.conversation_date, content: d.content })) || [];
  } catch (err) {
    console.error('[Supabase] Eroare la recuperarea istoricului complet:', err);
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
    console.log(`[Supabase] Căutare conversație existentă pentru data: ${today}`);
    const { data, error } = await supabase
      .from('daily_conversations')
      .select('content')
      .eq('conversation_date', today)
      .maybeSingle();

    if (error) throw error;
    return data?.content || null;
  } catch (err) {
    console.error('[Supabase] Eroare la recuperarea conversației de azi:', err);
    return null;
  }
}

/**
 * Salvează conversația prin concatenare.
 */
export async function saveConversation(content: string) {
  if (!content || !supabase) {
    console.warn("[Supabase] Ignorare salvare: conținut vid sau Supabase neconfigurat.");
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  try {
    console.log("[Supabase] Pregătire salvare sesiune...");
    const existingContent = await fetchTodayConversation();
    
    const finalContent = existingContent 
      ? `${existingContent}\n\n--- SESIUNE NOUĂ ---\n${content}` 
      : content;

    console.log(`[Supabase] Executare upsert pentru data ${today} (lungime totală: ${finalContent.length} caractere).`);
    
    const { error } = await supabase
      .from('daily_conversations')
      .upsert(
        { 
          conversation_date: today, 
          content: finalContent,
          updated_at: new Date().toISOString()
        }, 
        { onConflict: 'conversation_date' }
      );

    if (error) {
      console.error("[Supabase] Eroare de server Supabase:", error);
      if (error.code === '401' || error.message.includes('Invalid API key')) {
        (window as any).SUPABASE_DISABLED = true;
      }
      throw error;
    }
    console.log("[Supabase] Conversația a fost salvată și concatenată cu succes.");
  } catch (err) {
    console.error('[Supabase] Excepție la salvare:', err);
  }
}
