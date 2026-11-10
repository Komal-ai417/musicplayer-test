/* Test double for 'https://esm.sh/@supabase/supabase-js@2'.
   Each test file installs a factory on globalThis.__sbClientFactory
   before importing the Edge Function under test; createClient()
   then hands the function a fully mocked Supabase client built
   from that test's fixtures. */

export function createClient() {
  const factory = globalThis.__sbClientFactory;
  if (typeof factory !== 'function') {
    throw new Error('Test error: install globalThis.__sbClientFactory first.');
  }
  return factory();
}
