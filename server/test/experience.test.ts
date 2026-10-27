import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepartmentExperience, GENERIC_EXPERIENCE, NEWBORN_EXPERIENCE, DEMO_SAMPLE_REPORT, ReportSubmission } from '@sh/shared';
import { setup, type Harness } from './helpers';
import { createServices } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { seedDemo } from '../src/seed/demo';

describe('industry-independent department configuration and contextual Mica guide', () => {
  let h: Harness;
  let department: string;
  beforeAll(async () => { h = await setup(); department = (await h.sql<{id:string}>("select id from public.departments where code='NC'"))[0]!.id; });
  afterAll(async () => h?.close());
  it('has a consistent operational newborn-care demo and no warehouse data', async () => {
    const experience = await h.call('juan','GET','/api/department/experience');
    expect(experience.body).toEqual(NEWBORN_EXPERIENCE);
    const demo = await h.sql('select title,details from public.operational_records');
    const issues = await h.sql('select title,description from public.operational_issues');
    expect(JSON.stringify([demo,issues,DEMO_SAMPLE_REPORT])).not.toMatch(/warehouse|forklift|pallet|dock|conveyor|SKU/i);
    expect(ReportSubmission.safeParse(DEMO_SAMPLE_REPORT).success).toBe(true);
    expect(JSON.stringify(DEMO_SAMPLE_REPORT)).not.toMatch(/ignore previous|0917|fever|patient_id/i);
    expect(demo.some(r => String(r.title).includes('Newborn unit readiness'))).toBe(true);
  });
  it('defaults a new organization to generic experience and accepts configurable terminology and categories', async () => {
    const created = await h.call('admin','POST','/api/admin/departments',{code:'SERV',name:'Community Services',timezone:'Asia/Manila'});
    expect(created.status).toBe(201);
    const depts = await h.call('admin','GET','/api/admin/departments');
    expect(DepartmentExperience.parse(depts.body.find((d:any) => d.id === created.body.id).experience)).toEqual(GENERIC_EXPERIENCE);
    const custom = { ...GENERIC_EXPERIENCE, industry:'Professional services', staff_label:'Consultant', supervisor_label:'Team lead', report_label:'Service handover', categories:['process','staffing'],record_types:['operations','quality'] };
    expect((await h.call('admin','PUT',`/api/admin/departments/${created.body.id}/experience`,custom)).status).toBe(200);
    expect((await h.call('juan','PUT',`/api/admin/departments/${department}/experience`,custom)).status).toBe(403);
    await expect(h.sqlAs('manager','select app.set_department_experience($1,$2::jsonb)',[department,JSON.stringify(custom)])).rejects.toThrow(/forbidden/);
    expect((await h.call('admin','PUT',`/api/admin/departments/${department}/experience`,{...custom,categories:['clinical_diagnosis']})).status).toBe(422);
  });
  it('supports new operational record types without removing older type identifiers', async () => {
    const created = await h.call('manager','POST','/api/manager/records',{record_type:'operations',reference_code:'OPS-NC-001',title:'Support team coordination',details:'Service requests reviewed during the unit briefing'});
    expect(created.status).toBe(201);
    expect((await h.call('manager','POST','/api/manager/schedule/preset',{preset:'extended_hours'})).status).toBe(200);
    expect((await h.call('juan','POST','/api/manager/schedule/preset',{preset:'extended_hours'})).status).toBe(403);
  });
  it('offers page-specific guidance for every role with role enforcement and no actions', async () => {
    const guide = (who:string|null,page:string) => h.call(who,'POST','/api/assistant/help',{page,message:'How do I use this page?'});
    expect((await guide(null,'profile')).status).toBe(401);
    expect((await guide('juan','report')).body).toMatchObject({engine:'guide',page:'report'});
    expect((await guide('juan','users')).status).toBe(403);
    expect((await guide('manager','review')).body.reply).toContain('Compare');
    expect((await guide('admin','departments')).body.reply).toContain('Customize');
    expect((await guide('admin','report')).status).toBe(403);
    expect((await h.sql('select count(*)::int as n from public.shift_reports'))[0]!.n).toBe(0);
  });
  it('keeps contextual preparations scoped to the employee report author', async () => {
    const shift = (await h.call('juan','GET','/api/employee/dashboard')).body.current_shift.id;
    const report = (await h.call('juan','POST',`/api/shifts/${shift}/report`)).body.report_id;
    expect((await h.call('ana','POST','/api/assistant/message',{message:'Prepare my report',context:{page:'report',entity_id:report}})).status).toBe(404);
    const own = await h.call('juan','POST','/api/assistant/message',{message:'Prepare my report',context:{page:'report',entity_id:report}});
    expect(own.body.shift_id).toBe(shift);
  });
  it('seeds the actual hospital presentation with continuous coverage and a realistic draft', async () => {
    const services = await createServices(loadConfig({NODE_ENV:'test',APP_MODE:'local',ENABLE_INTERNAL_SCHEDULER:'false',DEV_ANALYSIS_DELAY_MS:'0'}),{memory:true,quiet:true,manualKick:true});
    try {
      await seedDemo(services,{onlyIfEmpty:true,sampleActivity:true,presentation:true});
      const [department] = await services.db.asService(q=>q.query<{operates_24_hours:boolean}>('select operates_24_hours from public.departments'));
      expect(department!.operates_24_hours).toBe(true);
      const patterns = await services.db.asService(q=>q.query<{name:string}>('select name from public.shift_templates where is_active order by start_time'));
      expect(patterns.map(p=>p.name)).toEqual(['Day','Evening','Night']);
      const drafts = await services.db.asService(q=>q.query<{draft_content:unknown}>('select draft_content from public.shift_reports where status=\'draft\''));
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.draft_content).toEqual(DEMO_SAMPLE_REPORT);
      const night = await services.db.asService(q=>q.query<{full_name:string}>(`select distinct p.full_name from public.shift_assignments a join public.shifts s on s.id=a.shift_id join public.profiles p on p.id=a.employee_id where s.label='Night' and s.starts_at>now() and a.removed_at is null order by p.full_name`));
      expect(night.map(p=>p.full_name)).toEqual(['Carla Mendoza','Daniel Ramos']);
    } finally {await services.stop();}
  });
});
