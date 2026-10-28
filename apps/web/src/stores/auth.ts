import { defineStore } from 'pinia';
import { DepartmentExperience, GENERIC_EXPERIENCE, ROLE_LABELS, type Role } from '@sh/shared';
import { computed, ref } from 'vue';
import type { SupabaseClient } from '@supabase/supabase-js';
import { api, ApiError, configureApi } from '@/lib/api';
import type { AppConfig, Profile } from '@/lib/types';

const TOKEN_KEY = 'sh.session';

interface LocalSession {
  token: string;
  expires_at: string;
}

function readLocalSession(): LocalSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as LocalSession;
    return new Date(s.expires_at).getTime() > Date.now() + 30_000 ? s : null;
  } catch {
    return null;
  }
}

export const useAuth = defineStore('auth', () => {
  const config = ref<AppConfig | null>(null);
  const profile = ref<Profile | null>(null);
  const experience = ref(DepartmentExperience.parse({}));
  const roleLabel = (role: Role) => role === 'employee' ? experience.value.staff_label : role === 'manager' ? experience.value.supervisor_label : ROLE_LABELS[role];
  /** The department's own words (e.g. "Operational concern" for an issue), for text written into pages. */
  const terms = computed(() => {
    const e = experience.value;
    const plural = (s: string) => (/s$/i.test(s) ? s : `${s}s`);
    return { issue: e.issue_label, issues: plural(e.issue_label), aIssue: `${/^[aeiou]/i.test(e.issue_label) ? 'an' : 'a'} ${e.issue_label.toLowerCase()}`, report: e.report_label, reports: plural(e.report_label), staff: e.staff_label, staffPlural: plural(e.staff_label), supervisor: e.supervisor_label };
  });
  /** Page titles that name issues follow the department's word for them. */
  const pageTitle = (title: string | undefined) =>
    title === 'Issues' || title === 'Open issues' ? terms.value.issues : title === 'Issue' ? terms.value.issue : title;
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
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
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
      config.value = await api.get<AppConfig>('/config');
    } catch {
      bootError.value = 'Silent Handover can’t reach its server right now.';
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

  async function signIn(email: string, password: string) {
    if (supabase) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    } else {
      local = await api.post<LocalSession>('/auth/login', { email, password });
      try {
        localStorage.setItem(TOKEN_KEY, JSON.stringify(local));
      } catch {
        /* session lasts for this tab only */
      }
    }
    await loadProfile();
    if (!profile.value) throw new ApiError(403, 'no_profile', 'Your account has not been set up yet. Contact an administrator.');
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    clearSession();
  }

  const role = computed(() => profile.value?.role ?? null);
  const homePath = computed(() => (role.value === 'admin' ? '/admin' : role.value === 'manager' ? '/manager' : '/'));
  const serverNow = () => Date.now() + clockSkew.value;

  return { config, profile, experience, terms, pageTitle, roleLabel, ready, bootError, role, homePath, clockSkew, init, signIn, signOut, loadProfile, serverNow };
});
