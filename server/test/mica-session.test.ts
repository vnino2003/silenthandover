import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
const fixture=vi.hoisted(()=>({post:vi.fn(),auth:null as any}));
vi.mock('../../apps/web/src/stores/auth',()=>({useAuth:()=>fixture.auth}));
vi.mock('../../apps/web/src/lib/api',()=>({api:{post:fixture.post},errorMessage:()=> 'Connection failed. Your input is kept.'}));
import { useMica } from '../../apps/web/src/stores/mica';
const answer=(page='profile',fallback=false)=>({page,reply:'Use the existing form to continue.',engine:'guide',fallback,facts:[],notices:[],checked_at:new Date().toISOString()});
function deferred(){let resolve!:(value:unknown)=>void;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
beforeEach(()=>{setActivePinia(createPinia());fixture.post.mockReset();fixture.auth=reactive({profile:{id:'person-a'}});});
describe('continuous Mica session',()=>{
  it('ignores late replies after Stop waiting and preserves unsent input',async()=>{
    const d=deferred();fixture.post.mockReturnValue(d.promise);const mica=useMica();mica.question='Keep this question';
    const pending=mica.ask({page:'profile'});expect(mica.state).toBe('processing');
    const signal=fixture.post.mock.calls[0]![2].signal as AbortSignal;
    mica.stopHelp();expect(signal.aborted).toBe(true);d.resolve(answer());await pending;
    expect(mica.turns).toHaveLength(0);expect(mica.question).toBe('Keep this question');expect(mica.helpBusy).toBe(false);
  });
  it('clears private session state on account changes and ignores an earlier account’s reply',async()=>{
    const d=deferred();fixture.post.mockReturnValue(d.promise);const mica=useMica();mica.question='First account question';
    const pending=mica.ask({page:'profile'});fixture.auth.profile={id:'person-b'};await nextTick();
    d.resolve(answer());await pending;
    expect(mica.turns).toEqual([]);expect(mica.question).toBe('');expect(mica.preparation).toBeNull();expect(mica.open).toBe(false);
  });
  it('does not erase newer typing or send the same pending request twice',async()=>{
    const d=deferred();fixture.post.mockReturnValue(d.promise);const mica=useMica();mica.question='First question';
    const pending=mica.ask({page:'profile'});mica.question='A newer follow-up';await mica.ask({page:'profile'});
    expect(fixture.post).toHaveBeenCalledTimes(1);d.resolve(answer());await pending;
    expect(mica.question).toBe('A newer follow-up');expect(mica.turns).toHaveLength(1);
  });
  it('clears an existing conversation if the same account changes role or department',async()=>{
    fixture.post.mockResolvedValue(answer());const mica=useMica();await mica.ask({page:'profile'},'Help');
    expect(mica.turns).toHaveLength(1);
    fixture.auth.profile={id:'person-a',role:'manager',department_id:'another-department'};await nextTick();
    expect(mica.turns).toHaveLength(0);expect(mica.preparation).toBeNull();
  });
  it('distinguishes source records by entity and never sends displayed facts back to the provider route',async()=>{
    fixture.post.mockResolvedValue(answer('review'));const mica=useMica();
    const context={page:'review' as const,entity_id:'00000000-0000-4000-8000-000000000001'};
    await mica.ask(context,'Explain the review');
    expect(fixture.post.mock.calls[0]![1]).toEqual({...context,message:'Explain the review'});
    expect(mica.key(context)).not.toBe(mica.key({...context,entity_id:'00000000-0000-4000-8000-000000000002'}));
  });
  it('uses an unavailable state for a fallback and reports voice phases without implying a saved result',async()=>{
    fixture.post.mockResolvedValue(answer('profile',true));const mica=useMica();mica.question='Help';await mica.ask({page:'profile'});expect(mica.state).toBe('unavailable');expect(mica.question).toBe('Help');
    mica.voice='requesting';expect(mica.state).toBe('requesting');mica.voice='listening';expect(mica.state).toBe('listening');mica.voice='transcribing';expect(mica.state).toBe('transcribing');
    expect(mica.lastEvent).not.toBe('recorded');
  });
});
