/* ============================================================
   OUR MUSIC - SETTINGS (v2, security upgrade)

   Only these two values identify your Supabase project.
   The anon key is DESIGNED to be public - it is not a secret.
   Everything sensitive (GitHub token, signing secret) now
   lives inside Supabase Edge Function secrets, server-side.

   The invite code below is only a quick client-side pre-check
   for nicer error messages. The REAL check happens in your
   database (a trigger on signup) - see SETUP-GUIDE.html.
   ============================================================ */

// From Supabase -> Settings -> API:
const SUPABASE_URL = 'https://nkupsemgqlfcacgwkset.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdXBzZW1ncWxmY2FjZ3drc2V0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQxMjA5NjIsImV4cCI6MjEwOTY5Njk2Mn0.le-_4Xi-JgQSEOR3QG4cnnIuA2AaaJhKaIVGN6tRT4k';

const APP_NAME = 'Our Music';
