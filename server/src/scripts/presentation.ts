// npm run presentation:prepare — LOCAL ONLY.
// Builds a clean presentation database next to the current one:
//   - copies the configuration exactly: the Newborn Care Department's wording and guidance, shift
//     patterns and minimum staffing, leave types, rules and email templates, the connected AI
//     (still encrypted) and the organization rules;
//   - creates the fictional Starlight Community Hospital team with @gmail.com sign-ins;
//   - creates a small amount of activity by running the real workflows through the app's own API
//     (supervisor overrides, report submission, Mica's analysis, review, delivery, acknowledgment,
//     leave), so every record and audit entry is genuine output of the system.
// The current database is not touched; server/.env is switched to the new one (and DEMO_MODE off).
// Every person and event is fictional. No patient information is involved.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AiHandoverDraft, ReportDraftContent } from '@sh/shared';
import { createApp } from '../app';
import { createServices, DEFAULT_LOCAL_DIR } from '../bootstrap';
import { loadConfig } from '../config';
import { DEMO_PASSWORD } from '../seed/demo';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig({ ...process.env, ENABLE_INTERNAL_SCHEDULER: 'false' });
if (config.APP_MODE !== 'local') throw new Error('The presentation database is for the local app only');
const sourceDir = config.LOCAL_DB_DIR ? resolve(config.LOCAL_DB_DIR) : DEFAULT_LOCAL_DIR;
const targetDir = join(DEFAULT_LOCAL_DIR, 'presentation');
if (existsSync(join(targetDir, 'local-db.tar.gz')) && !process.argv.includes('--replace')) {
  throw new Error(`${targetDir} already exists. Run with --replace to build it again.`);
}

const PEOPLE = [
  { key: 'admin', name: 'Alex Reyes', role: 'admin', title: null },
  { key: 'maria', name: 'Maria Santos', role: 'manager', title: 'Shift lead' },
  { key: 'juan', name: 'Juan Dela Cruz', role: 'employee', title: 'Nursing attendant' },
  { key: 'ana', name: 'Ana Lim', role: 'employee', title: 'Staff nurse' },
  { key: 'ben', name: 'Ben Torres', role: 'employee', title: 'Staff nurse' },
  { key: 'carla', name: 'Carla Mendoza', role: 'employee', title: 'Midwife' },
  { key: 'daniel', name: 'Daniel Ramos', role: 'employee', title: 'Staff nurse' },
  { key: 'rosa', name: 'Rosa Villanueva', role: 'employee', title: 'Midwife' },
  { key: 'paolo', name: 'Paolo Garcia', role: 'employee', title: 'Staff nurse' },
  { key: 'mae', name: 'Mae Santiago', role: 'employee', title: 'Nursing attendant' },
  { key: 'leo', name: 'Leo Fernandez', role: 'employee', title: 'Staff nurse' },
  { key: 'grace', name: 'Grace Aquino', role: 'employee', title: 'Midwife' },
] as const;
type Key = (typeof PEOPLE)[number]['key'];
const emailOf = (name: string) => `${name.toLowerCase().replace(/\s+/g, '.')}.starlight@gmail.com`;
// Who works which shift, and their weekly rest days (ISO weekday, Mon = 1).
const CREW: Partial<Record<Key, { shift: string; rest: number[] }>> = {
  ana: { shift: 'Day', rest: [6, 7] }, juan: { shift: 'Day', rest: [1, 2] }, rosa: { shift: 'Day', rest: [3, 4] }, paolo: { shift: 'Day', rest: [5, 6] },
  ben: { shift: 'Evening', rest: [7, 1] }, mae: { shift: 'Evening', rest: [3, 4] }, grace: { shift: 'Evening', rest: [5, 6] },
  carla: { shift: 'Night', rest: [1, 2] }, daniel: { shift: 'Night', rest: [4, 5] }, leo: { shift: 'Night', rest: [6, 7] },
};

// ---- 1. Read the configuration to keep -------------------------------------------------------
const source = await createServices(config, { manualKick: true, quiet: true });
const kept = await source.db.asService(async (q) => {
  const [department] = await q.query<{ code: string; name: string; timezone: string; experience: unknown }>(
    `select code, name, timezone, experience from public.departments where code = 'NC'`,
  );
  if (!department) throw new Error('The Newborn Care Department (NC) was not found in the current database');
  return {
    department,
    templates: await q.query<{ name: string; start_time: string; end_time: string; window_open_minutes: number; grace_minutes: number; allow_early_draft: boolean; is_active: boolean; weekdays: number[]; min_staff: number }>(
      `select t.name, to_char(t.start_time, 'HH24:MI') as start_time, to_char(t.end_time, 'HH24:MI') as end_time, t.window_open_minutes, t.grace_minutes,
              t.allow_early_draft, t.is_active, t.weekdays, t.min_staff
         from public.shift_templates t join public.departments d on d.id = t.department_id where d.code = 'NC' order by t.start_time`,
    ),
    leaveTypes: await q.query<{ name: string; description: string; requires_reason: boolean; max_days: number | null; is_active: boolean; sort_order: number }>(
      'select name, description, requires_reason, max_days, is_active, sort_order from public.leave_types order by sort_order',
    ),
    settings: await q.query<{ key: string; value: unknown }>('select key, value from public.app_settings'),
    emailTemplates: await q.query<{ key: string; subject: string; body: string }>('select key, subject, body from public.notification_templates'),
    ai: (await q.query<{ provider: string; model: string | null; api_key_ciphertext: string | null; api_key_hint: string | null }>(
      'select provider, model, api_key_ciphertext, api_key_hint from internal.ai_provider_config',
    ))[0],
    rules: (await q.query<{ version: number; policy_rules: string[]; negative_constraints: string[] }>(
      'select version, policy_rules, negative_constraints from public.ai_rule_versions order by version desc limit 1',
    ))[0],
  };
});
await source.stop();

// ---- 2. A fresh database with the same encryption key (so the saved AI key still works) ------
mkdirSync(targetDir, { recursive: true });
if (existsSync(join(sourceDir, 'local-secrets-key')) && !config.SECRETS_ENCRYPTION_KEY) {
  copyFileSync(join(sourceDir, 'local-secrets-key'), join(targetDir, 'local-secrets-key'));
}
if (process.argv.includes('--replace')) for (const f of ['local-db.tar.gz', 'local-db.tar.gz.lock']) rmSync(join(targetDir, f), { force: true });
const services = await createServices({ ...config, LOCAL_DB_DIR: targetDir, DEMO_MODE: false }, { manualKick: true, quiet: true });
const app = createApp(services);
const { db, auth } = services;
const val = async <T>(q: { query: <R>(s: string, p?: unknown[]) => Promise<R[]> }, sql: string, p: unknown[] = []) => (await q.query<{ v: T }>(sql, p))[0]!.v;

try {
  const ids = {} as Record<Key, string>;
  for (const p of PEOPLE) ids[p.key] = await auth.createUser(emailOf(p.name), DEMO_PASSWORD);
  await db.asService((q) => q.query(`insert into public.profiles (id, full_name, email, role) values ($1, $2, $3, 'admin')`, [ids.admin, 'Alex Reyes', emailOf('Alex Reyes')]));

  // Administrator: department, people, configuration.
  let departmentId = '';
  await db.asUser(ids.admin, async (q) => {
    const d = kept.department;
    departmentId = await val<string>(q, 'select app.admin_upsert_department(null, $1, $2, $3) as v', [d.code, d.name, d.timezone]);
    await q.query('select app.set_department_experience($1, $2::jsonb)', [departmentId, JSON.stringify(d.experience)]);
    for (const p of PEOPLE) {
      if (p.role === 'admin') continue;
      await q.query('select app.admin_create_profile($1, $2, $3, $4, $5, null, null)', [ids[p.key], p.name, emailOf(p.name), p.role, departmentId]);
      if (p.title) await q.query('select app.admin_set_job_title($1, $2)', [ids[p.key], p.title]);
    }
    for (const s of kept.settings) await q.query('select app.admin_set_setting($1, $2::jsonb)', [s.key, JSON.stringify(s.value)]);
    for (const t of kept.emailTemplates) await q.query('select app.admin_set_template($1, $2, $3)', [t.key, t.subject, t.body]);
    const existing = await q.query<{ id: string; name: string }>('select id, name from public.leave_types');
    for (const t of kept.leaveTypes) {
      const id = existing.find((e) => e.name === t.name)?.id ?? null;
      await q.query('select app.admin_upsert_leave_type($1, $2, $3, $4, $5, $6, $7)', [id, t.name, t.description, t.requires_reason, t.max_days, t.is_active, t.sort_order]);
    }
    if (kept.rules && kept.rules.version > 1) await q.query('select app.admin_save_ai_rules($1::text[], $2::text[])', [kept.rules.policy_rules, kept.rules.negative_constraints]);
  });
  if (kept.ai?.api_key_ciphertext) {
    await db.asService((q) =>
      q.query('update internal.ai_provider_config set provider = $1, model = $2, api_key_ciphertext = $3, api_key_hint = $4, updated_at = now()', [kept.ai!.provider, kept.ai!.model, kept.ai!.api_key_ciphertext, kept.ai!.api_key_hint]),
    );
  }

  // Supervisor: the same shift patterns, two weeks of shifts, rest days and the rotation.
  const today = await db.asService((q) => val<string>(q, `select (now() at time zone $1)::date::text as v`, [kept.department.timezone]));
  const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const last = addDays(today, 13);
  const isoWeekday = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  await db.asUser(ids.maria, async (q) => {
    await q.query(`select app.apply_schedule_preset('continuous_24h')`);
    const current = await q.query<{ id: string; name: string }>('select id, name from public.shift_templates where department_id = app.my_department()');
    for (const t of kept.templates) {
      const id = current.find((c) => c.name === t.name)?.id ?? null;
      const saved = await val<string>(q, 'select app.upsert_shift_template($1, null, $2, $3::time, $4::time, $5, $6, $7, $8, $9::smallint[]) as v', [
        id, t.name, t.start_time, t.end_time, t.window_open_minutes, t.grace_minutes, t.allow_early_draft, t.is_active, t.weekdays,
      ]);
      await q.query('select app.set_pattern_min_staff($1, $2)', [saved, t.min_staff]);
    }
    const active = await q.query<{ id: string }>('select id from public.shift_templates where department_id = app.my_department() and is_active');
    for (const t of active) await q.query('select app.generate_shifts($1, $2::date, $3::date, $4)', [t.id, today, last, ids.maria]);
    for (const [key, c] of Object.entries(CREW)) await q.query('select app.set_rest_days($1, $2::date, $3::date, $4::smallint[])', [ids[key as Key], today, last, c!.rest]);
    const shifts = await q.query<{ id: string; label: string; shift_date: string }>(
      `select id, label, shift_date::text as shift_date from public.shifts where department_id = app.my_department() and status = 'scheduled' order by starts_at`,
    );
    for (const s of shifts) {
      for (const [key, c] of Object.entries(CREW)) {
        if (c!.shift === s.label && !c!.rest.includes(isoWeekday(s.shift_date))) await q.query('select app.assign_to_shift($1, $2)', [s.id, ids[key as Key]]);
      }
    }
    // Source records and two open concerns, as the shift lead recorded them.
    await q.query(`select app.add_operational_record('policy', 'POL-NC-01', 'Operational handover and equipment escalation', 'Use approved service references in operational handovers; report equipment faults to the shift lead and the authorized engineering team. Clinical information stays in the approved clinical record.', now() - interval '30 days')`);
    await q.query(`select app.add_operational_record('quality', 'NC-READY-01', 'Newborn unit readiness checklist', 'Rooms 1–4 prepared; emergency supply seals checked against the local checklist. No patient information is included.', now() - interval '9 hours')`);
    await q.query(`select app.add_operational_record('maintenance', 'BIO-NC-020', 'Unit equipment readiness review', 'Biomedical engineering completed the scheduled inspection of the spare equipment set. NB-02 is excluded pending a separate wheel-lock inspection.', now() - interval '11 hours')`);
    await q.query(`select app.add_operational_record('staffing', 'NC-ROSTER-01', 'Care-team coverage and incoming briefing', 'Incoming briefing covers open service requests and unit-readiness references.', now() - interval '7 hours')`);
    const bassinet = await val<{ id: string }>(q, `select app.raise_issue('Bassinet NB-02 wheel lock needs inspection', 'Removed from use in the preparation room. Biomedical engineering request BIO-NC-021 is awaiting inspection.', 'high', true) as v`);
    const bell = await val<{ id: string }>(q, `select app.raise_issue('Family consultation room call bell intermittent', 'Facilities request FAC-NC-014 is open. Shift lead has been informed.', 'medium', false) as v`);
    await q.query(`select app.transition_issue($1, 'in_progress', 'Facilities acknowledged FAC-NC-014; inspection is in progress.')`, [bell.id]);
    await q.query('select app.assign_issue($1, $2)', [bassinet.id, ids.juan]);
  });

  // ---- 3. Activity through the app's own API ----------------------------------------------------
  const tokens = {} as Record<Key, string>;
  const call = async (who: Key, method: string, path: string, body?: unknown) => {
    if (!tokens[who]) {
      const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailOf(PEOPLE.find((p) => p.key === who)!.name), password: DEMO_PASSWORD }) });
      tokens[who] = ((await res.json()) as { token: string }).token;
    }
    const res = await app.request(`/api${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (res.status >= 400) throw new Error(`${method} ${path} as ${who}: ${res.status} ${json?.error?.message ?? text}`);
    return json;
  };
  const dayShift = await db.asService((q) => val<string>(q, `select id as v from public.shifts where label = 'Day' and shift_date = $1::date`, [today]));
  const drain = async () => {
    for (let i = 0; i < 8; i++) {
      const a = await services.analysis.runDue();
      const n = await services.notifications.runDue();
      if (!a && !n) break;
    }
  };
  const submit = async (who: Key, reason: string, content: Partial<ReportDraftContent>) => {
    await call('maria', 'POST', `/manager/shifts/${dayShift}/override`, { employee_id: ids[who], minutes: 120, reason });
    const { report_id } = await call(who, 'POST', `/shifts/${dayShift}/report`);
    await call(who, 'POST', `/reports/${report_id}/submit`, {
      content: { completed_work: '', problems: [], unresolved_issues: '', no_unresolved_issues: false, pending_tasks: '', no_pending_tasks: false, operational_concerns: '', handover_notes: '', evidence_refs: '', issue_updates: [], ...content },
    });
    return report_id as string;
  };

  // Juan's Day report: reviewed, approved, delivered to the Evening crew, and read by Ben.
  const juanReport = await submit('juan', 'Report delayed by the end-of-shift supply count', {
    completed_work: 'Prepared rooms 1–4 for the day: bassinets cleaned and made up, warming station checked, and the readiness checklist NC-READY-01 completed. Restocked the supply cart with 12 swaddle packs and 2 boxes of diaper sets. Helped Ana Lim with the 10:00 equipment round.',
    unresolved_issues: 'Bassinet NB-02 is still out of use; the wheel lock is waiting for biomedical inspection (ISS-000001). The supply room label printer jams on every third label.',
    pending_tasks: 'Confirm the 15:00 linen delivery and put it away. Follow up with biomedical engineering on BIO-NC-021 before the end of the evening.',
    handover_notes: 'The room 3 wall thermometer reads about 0.5 degrees higher than the warming station display; I told the shift lead.',
    evidence_refs: 'NC-READY-01, BIO-NC-021',
  });
  // Paolo's Day report: waiting for the supervisor's review (to review live).
  await submit('paolo', 'Late report agreed with the shift lead', {
    completed_work: 'Completed the noon stock count of the newborn supply room and matched it against the order sheet. Checked the oxygen and suction set-ups in rooms 1 and 2 with the shift lead. Fixed the loose shelf bracket in the linen store myself, should be okay now.',
    unresolved_issues: 'The stock count shows 18 glove boxes but the order sheet says 20; needs a recount. The family consultation room call bell still cuts out (FAC-NC-014).',
    pending_tasks: 'Recount the gloves before the 16:00 order cut-off tomorrow. Ask facilities for an update on FAC-NC-014.',
    handover_notes: 'Sir Ramos from facilities said he would come back after 3 PM.',
  });
  // A busy AI model is retried with a delay, as in normal use; wait for it (up to 10 minutes).
  for (let waited = 0; ; waited += 15) {
    await drain();
    const pending = await db.asService((q) => val<number>(q, `select count(*)::int as v from public.shift_reports where status in ('submitted', 'processing')`));
    if (!pending || waited >= 600) break;
    if (waited % 60 === 0) console.log(`Waiting for Mica to finish ${pending} report(s)…`);
    await new Promise((r) => setTimeout(r, 15_000));
  }

  const detail = await call('maria', 'GET', `/manager/reports/${juanReport}`);
  const run = (detail.runs as { status: string; draft: AiHandoverDraft; flags: unknown[] }[]).find((r) => r.status === 'succeeded');
  if (run) {
    const issueByCode = new Map((detail.open_issues as { id: string; code: string }[]).map((i) => [i.code, i.id]));
    await call('maria', 'POST', `/manager/reports/${juanReport}/decision`, {
      decision: 'approved',
      content: {
        summary: run.draft.summary,
        completed_tasks: run.draft.completed_tasks.map((t) => ({ description: t.description.slice(0, 500) })),
        unresolved_issues: run.draft.unresolved_issues.map((i) => ({
          title: i.title.slice(0, 160), description: i.description.slice(0, 1000), severity: i.severity, is_safety_concern: i.is_safety_concern,
          link_issue_id: (i.related_issue_code && issueByCode.get(i.related_issue_code)) || null, initial_status: 'open',
        })).filter((i) => i.title.length >= 3),
        pending_actions: run.draft.pending_actions.map((a) => ({ description: a.description.slice(0, 500) })),
        notes_for_incoming: 'Bassinet NB-02 stays out of use until biomedical engineering signs off BIO-NC-021.',
      },
      flag_resolutions: run.flags.map((_f, i) => ({ flag_index: i, resolution: 'accepted_as_unverified', note: 'Checked against NC-READY-01 at handover.' })),
      note: 'Checked against the readiness checklist NC-READY-01.',
    });
    await drain();
    const incoming = (await call('ben', 'GET', '/handovers/incoming')) as { delivery_id: string }[];
    if (incoming[0]) await call('ben', 'POST', `/handovers/${incoming[0].delivery_id}/acknowledge`, { note: 'Read at turnover.' });
  } else {
    console.warn('Mica could not prepare a draft for the first report, so it was left for review.');
  }

  // Leave: approved, declined and two pending (one would leave a night short).
  const types = (await call('maria', 'GET', '/leave-types')) as { id: string; name: string }[];
  const type = (name: string) => types.find((t) => t.name === name)!.id;
  const leave = async (who: Key, kind: string, from: number, to: number, reason: string) =>
    (await call(who, 'POST', '/leave', { leave_type_id: type(kind), start_date: addDays(today, from), end_date: addDays(today, to), reason })).id as string;
  const paolo = await leave('paolo', 'Vacation leave', 4, 4, 'Family event in the province');
  await call('maria', 'POST', `/manager/leave/${paolo}/decision`, { decision: 'approved', note: 'Approved. Please hand over the supply count to Rosa.' });
  const ben = await leave('ben', 'Vacation leave', 6, 6, 'Personal errand');
  await call('maria', 'POST', `/manager/leave/${ben}/decision`, { decision: 'rejected', note: 'Two evening staff are already off that day. Could you take the following week?' });
  await leave('leo', 'Sick leave', 2, 2, 'Medical appointment');
  await leave('mae', 'Vacation leave', 8, 9, '');
  await drain();

  // ---- 4. Switch the local app to the presentation database --------------------------------------
  const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  const set = (text: string, key: string, value: string) => (new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`);
  writeFileSync('.env', set(set(env, 'LOCAL_DB_DIR', `"${targetDir.replaceAll('\\', '/')}"`), 'DEMO_MODE', 'false'));

  console.log(`Presentation database ready at ${targetDir}`);
  console.log(`The previous database is unchanged at ${sourceDir} (set LOCAL_DB_DIR back to return to it).`);
  console.log('Sign-ins (all use the local demo password):');
  for (const p of PEOPLE) console.log(`  ${p.role.padEnd(8)} ${p.name.padEnd(16)} ${emailOf(p.name)}`);
} finally {
  await services.stop();
}
