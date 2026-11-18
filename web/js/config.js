// Public settings. The Supabase URL and the ANON key are meant to be public: what protects the data is Row Level Security.
// The deploy workflow overwrites this file from the repository variables SUPABASE_URL and SUPABASE_ANON_KEY.
// For local use, fill them in by hand and do not commit the change. NEVER put the service-role key here.
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
export const BUILD = 'dev';
