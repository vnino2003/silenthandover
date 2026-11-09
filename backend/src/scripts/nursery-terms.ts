/**
 * One-off update of the presentation data to the hospital terms, through the admin API so every
 * change goes through the same checks and audit log as the Departments and Users pages:
 *   - the Newborn Care Department (code NC) becomes "Nursery" with the Nursery wording;
 *   - job titles use hospital titles (Head Nurse, Staff Nurse, Nursing Attendant). Midwives belong
 *     to the OB-GYN Ward and Delivery Room, so the Nursery's fictional staff are nurses and
 *     nursing attendants.
 * Records (endorsements, concerns, audit entries) are left exactly as they are.
 *
 * Usage: API_URL=http://localhost:8788 ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx src/scripts/nursery-terms.ts
 */
import { NEWBORN_EXPERIENCE } from '@sh/shared';

const API = process.env.API_URL ?? 'http://localhost:8787';
const TITLES: Record<string, string> = {
  'Maria Santos': 'Head Nurse',
  'Juan Dela Cruz': 'Nursing Attendant',
  'Ana Lim': 'Staff Nurse',
  'Ben Torres': 'Staff Nurse',
  'Carla Mendoza': 'Staff Nurse',
  'Daniel Ramos': 'Staff Nurse',
  'Rosa Villanueva': 'Nursing Attendant',
  'Paolo Garcia': 'Staff Nurse',
  'Mae Santiago': 'Nursing Attendant',
  'Leo Fernandez': 'Staff Nurse',
  'Grace Aquino': 'Staff Nurse',
};

async function call<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
  const { token } = await call<{ token: string }>(null, 'POST', '/auth/login', { email, password });

  const departments = await call<{ id: string; code: string; name: string; timezone: string; experience: Record<string, unknown> }[]>(token, 'GET', '/admin/departments');
  const nc = departments.find((d) => d.code === 'NC');
  if (!nc) throw new Error('Department NC not found');
  await call(token, 'PATCH', `/admin/departments/${nc.id}`, { code: nc.code, name: 'Nursery', timezone: nc.timezone });
  await call(token, 'PUT', `/admin/departments/${nc.id}/experience`, {
    ...NEWBORN_EXPERIENCE,
    organization_name: (nc.experience.organization_name as string | undefined) || NEWBORN_EXPERIENCE.organization_name,
  });
  console.log(`Department ${nc.code}: "${nc.name}" -> "Nursery", Nursery wording applied`);

  const users = await call<{ id: string; full_name: string; department_id: string | null; job_title: string | null }[]>(token, 'GET', '/admin/users');
  for (const u of users.filter((x) => x.department_id === nc.id)) {
    const title = TITLES[u.full_name];
    if (!title || title === u.job_title) continue;
    await call(token, 'PATCH', `/admin/users/${u.id}/job-title`, { job_title: title });
    console.log(`${u.full_name}: ${u.job_title ?? '(none)'} -> ${title}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
