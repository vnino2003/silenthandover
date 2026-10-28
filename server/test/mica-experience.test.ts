import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssistantState, DEMO_SAMPLE_REPORT, MicaAnswer } from '@sh/shared';
import { setup, adhocShift, type Harness } from './helpers';
import { leaveDates } from '../src/automation/mica-dates';
import { micaSuggestions } from '../../apps/web/src/lib/mica-context';

describe('Folio contextual experience and safe workflow handoffs',()=>{
  let h:Harness;
  const outbound:string[]=[];
  let output:unknown={reply:'Use the existing page controls to review your work.'};
  let fail=false;
  beforeAll(async()=>{
    h=await setup({},(async (_url:unknown,init:RequestInit)=>{
      outbound.push(String(init.body));
      return fail?new Response('{}',{status:503}):new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}]}),{status:200});
    }) as typeof fetch);
  });
  afterAll(()=>h?.close());
  const guide=(who:string,page:string,message:string)=>h.call(who,'POST','/api/assistant/help',{page,message});

  it('maps employee schedules and every leave context to authorized, typed application facts',async()=>{
    for(const [who,page] of [['juan','my_schedule'],['juan','leave'],['manager','leave_requests'],['admin','pipeline']]){
      const response=await guide(who!,page!,'What do my records show?');
      expect(response.status).toBe(200);
      expect(MicaAnswer.safeParse(response.body).success).toBe(true);
    }
    expect((await guide('juan','schedule','Explain this page')).status).toBe(403);
    expect((await guide('juan','users','Show records')).status).toBe(403);
    expect(micaSuggestions('my_schedule','employee').some(s=>s.kind==='leave')).toBe(true);
    expect(micaSuggestions('departments','admin').every(s=>s.kind!=='prepare')).toBe(true);
  });

  it('keeps live records and leave reasons out of provider requests',async()=>{
    await h.call('admin','PUT','/api/admin/ai',{provider:'gemini',model:'gemini-fixture',api_key:'fake-test-key-1234567890'});
    outbound.length=0;
    const response=await guide('juan','my_schedule','When is my next shift?');
    expect(response.body.engine).toBe('records');
    expect(response.body.facts.some((g:any)=>g.title==='Your next shift')).toBe(true);
    const leave=await guide('juan','leave','I need Friday and Saturday off because of fever and medication.');
    expect(leave.status).toBe(200);
    expect(leave.body.leave_draft).toBeDefined();
    expect(JSON.stringify(leave.body)).not.toContain('medication');
    expect(outbound).toHaveLength(0);
    const [count]=await h.sql('select count(*)::int as n from public.leave_requests');
    expect(count.n).toBe(0);
  });

  it('provides an honest page guide after provider failure or a blank response',async()=>{
    fail=true;
    const failed=await guide('juan','profile','Explain notification preferences');
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({engine:'guide',fallback:true});
    expect(failed.body.notices.join(' ')).toContain('unavailable');
    fail=false;output={reply:'   '};
    expect((await guide('juan','profile','Explain notification preferences')).body.fallback).toBe(true);
    expect(outbound.join(' ')).not.toContain('Your next shift');
    expect(outbound.join(' ')).not.toContain('medication');
  });

  it('restores authorized names and rejects invented quantities in AI preparations',async()=>{
    const [ana]=await h.sql('select pseudonym from public.profiles where id=$1',[h.ids.ana]);
    output={state:AssistantState.parse({intent:'report',content:{completed_work:`Counted 12 kits with [${ana.pseudonym}].`}})};
    const p=await h.call('juan','POST','/api/assistant/message',{message:'Report: counted 12 kits with Ana Lim.'});
    expect(p.status).toBe(200);
    expect(p.body.state.content.completed_work).toContain('Ana Lim');
    expect(outbound.at(-1)).not.toContain('Ana Lim');
    expect(outbound.at(-1)).toContain('raw_input');
    expect(outbound.at(-1)).toContain('## 6. Output format');
    output={state:AssistantState.parse({intent:'report',content:{completed_work:'Counted 999 kits.'}})};
    const invented=await h.call('juan','POST','/api/assistant/message',{message:'Report: counted 12 kits.'});
    expect(invented.body.engine).toBe('guided_unavailable');
    expect(JSON.stringify(invented.body.state)).not.toContain('999');
    await h.call('admin','PUT','/api/admin/ai',{provider:'simulator',api_key:null});
  });

  it('saves a partial report draft exactly once through normal rules without submitting it',async()=>{
    const shift=await adhocShift(h,{startsSql:"now()-interval '2 hours'",endsSql:"now()+interval '15 minutes'",employee:'carla'});
    const p=(await h.call('carla','POST','/api/assistant/message',{message:'Prepare my shift report',shift_id:shift})).body;
    const edited=(await h.call('carla','PUT',`/api/assistant/preparations/${p.id}`,{version:p.version,state:{...p.state,content:DEMO_SAMPLE_REPORT}})).body;
    expect((await h.call('ana','POST',`/api/assistant/preparations/${p.id}/draft`,{version:edited.version})).status).toBe(404);
    expect((await h.call('manager','POST',`/api/assistant/preparations/${p.id}/draft`,{version:edited.version})).status).toBe(403);
    const [a,b]=await Promise.all([1,2].map(()=>h.call('carla','POST',`/api/assistant/preparations/${p.id}/draft`,{version:edited.version})));
    expect(a!.status).toBe(200);expect(b!.body.result.id).toBe(a!.body.result.id);
    const [r]=await h.sql('select status,draft_content,current_revision from public.shift_reports where id=$1',[a!.body.result.id]);
    expect(r.status).toBe('draft');expect(r.current_revision).toBe(0);
    expect(r.draft_content.completed_work).toBe(DEMO_SAMPLE_REPORT.completed_work);
    const confirmation=await h.call('carla','POST',`/api/assistant/preparations/${p.id}/confirm`,{version:edited.version,confirmed:true});
    expect(confirmation.body.result.kind).toBe('draft');
    const [revisions]=await h.sql('select count(*)::int as n from public.report_revisions where report_id=$1',[a!.body.result.id]);
    expect(revisions.n).toBe(0);
  });

  it('protects report edits made outside Mica during a draft handoff',async()=>{
    const shift=await adhocShift(h,{startsSql:"now()-interval '2 hours'",endsSql:"now()+interval '15 minutes'",employee:'daniel'});
    const p=(await h.call('daniel','POST','/api/assistant/message',{message:'Prepare my report',shift_id:shift})).body;
    const r=await h.call('daniel','POST',`/api/shifts/${shift}/report`);
    await h.call('daniel','PUT',`/api/reports/${r.body.report_id}/draft`,{content:{...DEMO_SAMPLE_REPORT,completed_work:'Newer edits from the report form'}});
    expect((await h.call('daniel','POST',`/api/assistant/preparations/${p.id}/draft`,{version:p.version})).status).toBe(409);
    expect((await h.sql('select draft_content from public.shift_reports where id=$1',[r.body.report_id]))[0].draft_content.completed_work).toBe('Newer edits from the report form');
  });

  it('resolves narrow date phrases locally and leaves ambiguity for the form',()=>{
    expect(leaveDates('Friday and Saturday off','2026-10-28')).toEqual({start_date:'2026-10-30',end_date:'2026-10-31'});
    expect(leaveDates('2026-11-02 through 2026-11-03','2026-10-28')).toEqual({start_date:'2026-11-02',end_date:'2026-11-03'});
    expect(leaveDates('Friday or Saturday','2026-10-28')).toBeUndefined();
    expect(leaveDates('next month','2026-10-28')).toBeUndefined();
    expect(leaveDates('2026-02-30','2026-01-01')).toBeUndefined();
  });
});
