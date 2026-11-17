import { defineStore } from 'pinia';
import { DepartmentExperience, departmentTerms, GENERIC_EXPERIENCE, ROLE_LABELS, type Role } from '@sh/shared';
import { computed, ref } from 'vue';
import type { SupabaseClient } from '@supabase/supabase-js';
import { api, ApiError, apiBase, configureApi } from '@/lib/api';
import type { AppConfig, Capability, Profile } from '@/lib/types';

const TOKEN_KEY = 'sh.session';

interface LocalSession {
  token: string;
  expires_at: string;
  /** The server that issued it. A session is never reused against another server. */
  api?: string;
}

/**
 * Device settings that are not a person's data and stay after signing out: the Android app's server
 * address and QR station keys. Everything else this app keeps in storage belongs to the signed-in
 * person and is removed on sign-out (session, Supabase session, endorsement draft backups).
 */
const DEVICE_KEYS = (key: string) => key === 'sh.apiBase' || key.startsWith('sh.station.');

function clearPersonalStorage() {
  try {
    for (const key of Object.keys(localStorage)) {
      if ((key.startsWith('sh.') && !DEVICE_KEYS(key)) || key.startsWith('sb-')) localStorage.removeItem(key);
    }
    sessionStorage.clear();
  } catch {
    /* storage unavailable */
  }
}

function readLocalSession(): LocalSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as LocalSession;
    // Only a live session from this same server counts; anything else is discarded.
    const valid = typeof s.token === 'string' && new Date(s.expires_at).getTime() > Date.now() + 30_000 && s.api === apiBase();
    if (!valid) localStorage.removeItem(TOKEN_KEY);
    return valid ? s : null;
  } catch {
    return null;
  }
}

export const useAuth = defineStore('auth', () => {
  const config = ref<AppConfig | null>(null);
  const profile = ref<Profile | null>(null);
  const experience = ref(DepartmentExperience.parse({}));
  const roleLabel = (role: Role) => role === 'employee' ? experience.value.staff_label : role === 'manager' ? experience.value.supervisor_label : ROLE_LABELS[role];
  /** The department's own words (e.g. "Head Nurse", "Shift endorsement", "Concern"), for text written into pages. */
  const terms = computed(() => departmentTerms(experience.value));
  /** Page titles that name concerns or endorsements follow the department's words for them. */
  const pageTitle = (title: string | undefined) => {
    const t = terms.value;
    if (title === 'Concerns') return t.issues;
    if (title === 'Open concerns') return `Open ${t.issuesLower}`;
    if (title === 'Concern') return t.issue;
    if (title === 'Shift endorsement') return t.report;
    if (title === 'My endorsements') return `My ${t.reportsLower}`;
    if (title === 'Endorsement history') return `${t.report} history`;
    return title;
  };
  const ready = ref(false);
  const bootError = ref<string | null>(null);
  /** Server clock minus browser clock, in ms. Countdowns use server time. */
  const clockSkew = ref(0);
  let supabase: SupabaseClient | null = null;
  let local: LocalSession | null = readLocalSession();

  async function token(): Promise<string | null> {
    if (supabase) return (await supabase.auth.getSession()).data.session?.access_token ?? null;
    return local?.token ?? null;
  }

  function clearSession() {
    local = null;
    clearPersonalStorage();
    profile.value = null;
    experience.value = DepartmentExperience.parse({});
  }

  configureApi({
    token,
    onUnauthorized: () => {
      if (profile.value) {
        clearSession();
        window.location.assign('/login?expired=1');
      }
    },
  });

  async function loadProfile() {
    try {
      const p = await api.get<Profile>('/me');
      profile.value = p;
      experience.value = p.department_id ? await api.get<DepartmentExperience>('/department/experience') : { ...GENERIC_EXPERIENCE };
      clockSkew.value = new Date(p.server_now).getTime() - Date.now();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) clearSession();
      else throw err;
    }
  }

  async function init() {
    try {
      const c = await api.get<AppConfig>('/config');
      // Only the API's own settings count: anything else means the address is wrong.
      if (!c || typeof c !== 'object' || !c.auth || !['local', 'supabase'].includes(c.auth.provider)) throw new Error('not the API');
      config.value = c;
    } catch (err) {
      bootError.value = err instanceof ApiError && err.code === 'no_server'
        ? 'Enter your hospital’s Silent Handover server address to continue.'
        : 'Silent Handover can’t reach its server right now.';
      throw new Error(bootError.value);
    }
    bootError.value = null;
    if (config.value.auth.provider === 'supabase') {
      const { createClient } = await import('@supabase/supabase-js');
      supabase = createClient(config.value.auth.supabase_url, config.value.auth.supabase_anon_key);
    }
    if (await token()) await loadProfile();
    ready.value = true;
  }

  function keepLocalSession(s: LocalSession) {
    local = { ...s, api: apiBase() };
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(local));
    } catch {
      /* session lasts for this tab only */
    }
  }

  async function signIn(email: string, password: string) {
    if (supabase) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    } else {
      keepLocalSession(await api.post<LocalSession>('/auth/login', { email, password }));
    }
    await loadProfile();
    if (!profile.value) throw new ApiError(403, 'no_profile', 'Your account has not been set up yet. Contact an administrator.');
  }

  /** After choosing a password from an invitation link: the server already signed the person in (local mode). */
  async function adoptSession(email: string, password: string, session: LocalSession | null) {
    if (session && !supabase) {
      keepLocalSession(session);
      await loadProfile();
      if (!profile.value) throw new ApiError(403, 'no_profile', 'Your account has not been set up yet. Contact an administrator.');
    } else {
      await signIn(email, password);
    }
  }

  /**
   * Ends the session on the server and removes the person's data from this device. Local mode: the
   * server records the token as signed out, so a kept or restored copy is refused. Supabase: this
   * session's refresh token is revoked (other devices of the same person stay signed in).
   */
  async function signOut() {
    try {
      if (supabase) await supabase.auth.signOut({ scope: 'local' });
      else if (local) await api.post('/auth/logout');
    } catch {
      /* offline or already ended: the device is still cleared */
    }
    clearSession();
    // Start the app fresh: no store, cached page or timer of this person may reach the next one
    // (notifications, Mica conversations and drafts, page data kept for the back button).
    window.location.replace('/login');
  }

  const role = computed(() => profile.value?.role ?? null);
  /** Holds one of these workforce duties (HR, payroll, finance, Nursing Service)? */
  const can = (...caps: Capability[]) => (profile.value?.capabilities ?? []).some((g) => caps.includes(g.capability));
  const homePath = computed(() => (role.value === 'admin' ? '/admin' : role.value === 'manager' ? '/manager' : '/'));
  const serverNow = () => Date.now() + clockSkew.value;

  return { config, profile, experience, terms, pageTitle, roleLabel, ready, bootError, role, can, homePath, clockSkew, init, signIn, adoptSession, signOut, loadProfile, serverNow };
});
