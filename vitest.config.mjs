import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The Edge Functions import Supabase from esm.sh at runtime (Deno).
// In unit tests that specifier is aliased to a local mock, so the
// REAL function code runs with a fully controllable "database".
export default defineConfig({
  resolve: {
    alias: {
      'https://esm.sh/@supabase/supabase-js@2': fileURLToPath(
        new URL('./tests/mocks/supabase-js.js', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
