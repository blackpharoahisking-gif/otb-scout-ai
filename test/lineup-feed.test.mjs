import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/^import\s+\{\s*WorkflowEntrypoint\s*\}\s+from\s+'cloudflare:workers';\s*/m,'')
  .replace(/export class FreshReviewWorkflow/, 'class FreshReviewWorkflow')
  .replace(/export default\s*\{/, 'const workerDefault = {')
  +'\n;globalThis.__lineupTest={fplLiveSelectionEvents,pulseTeamListForRoster,announcedXiEvents,recentFinishedEvents,STRUCTURED_PROVIDER_CATALOG};';
class WorkflowEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}}
const context={URL,Date,Map,Set,RegExp,Object,Array,String,Number,Math,JSON,console,crypto:globalThis.crypto,WorkflowEntrypoint};
vm.createContext(context);
vm.runInContext(source,context,{filename:'worker.js'});
const {fplLiveSelectionEvents,pulseTeamListForRoster,announcedXiEvents,recentFinishedEvents,STRUCTURED_PROVIDER_CATALOG}=context.__lineupTest;

const players=[
  {id:1,name:'Verbruggen',fullName:'Bart Verbruggen',status:'a'},
  {id:2,name:'Dunk',fullName:'Lewis Dunk',status:'a'},
  {id:3,name:'Gomez',fullName:'Diego Gomez',status:'a'},
  {id:4,name:'Mitoma',fullName:'Kaoru Mitoma',status:'i'},
  {id:5,name:'Tzimas',fullName:'Charalampos Tzimas',status:'a'},
];
const live=rows=>rows.map(([id,minutes,starts])=>({id,stats:{minutes,starts}}));

test('the provider catalog now advertises selection and lineup capabilities',()=>{
  const ids=[...STRUCTURED_PROVIDER_CATALOG].map(p=>p.id);
  assert.deepEqual(ids,['fpl-bootstrap','fpl-live-starts','pl-announced-xi']);
  assert.deepEqual([...STRUCTURED_PROVIDER_CATALOG].find(p=>p.id==='fpl-live-starts').capabilities.join(),'selection');
  assert.deepEqual([...STRUCTURED_PROVIDER_CATALOG].find(p=>p.id==='pl-announced-xi').capabilities.join(),'lineup');
});

test('a start becomes observed_role and its confidence tracks minutes played',()=>{
  const full=fplLiveSelectionEvents('BHA',players,3,live([[1,90,1],[2,90,1],[3,45,1],[4,0,0],[5,0,0]]),{deadlineTime:'2026-09-05T10:00:00Z'});
  const dunk=full.events.find(e=>e.affectedApiId===2);
  const gomez=full.events.find(e=>e.affectedApiId===3);
  assert.equal(dunk.type,'observed_role');
  assert.equal(dunk.evidenceClass,'selection');
  assert.equal(dunk.confidence,.95);
  assert.equal(dunk.gameweek,3);
  assert.equal(dunk.subject,dunk.affected,'observed_role must describe the subject\'s own selection');
  assert.equal(gomez.type,'observed_role');
  assert.equal(gomez.confidence,.82,'started but withdrawn early is weaker start evidence');
});

test('a substitute appearance becomes a rotation warning, not a start',()=>{
  const out=fplLiveSelectionEvents('BHA',players,3,live([[1,90,1],[2,90,1],[3,20,0],[4,0,0],[5,0,0]]));
  const gomez=out.events.find(e=>e.affectedApiId===3);
  assert.equal(gomez.type,'rotation_warning');
  assert.equal(gomez.evidenceClass,'manager');
  assert.equal(gomez.confidence,.85);
  assert.match(gomez.reason,/came off the bench for 20 minutes/);
});

test('an available player who did not play is a weaker rotation warning',()=>{
  const out=fplLiveSelectionEvents('BHA',players,3,live([[1,90,1],[2,90,1],[3,90,1],[4,0,0],[5,0,0]]));
  const tzimas=out.events.find(e=>e.affectedApiId===5);
  assert.equal(tzimas.type,'rotation_warning');
  assert.equal(tzimas.confidence,.7);
});

test('an already-unavailable player is never given a rotation warning on top',()=>{
  const out=fplLiveSelectionEvents('BHA',players,3,live([[1,90,1],[2,90,1],[3,90,1],[4,0,0],[5,0,0]]));
  assert.equal(out.events.some(e=>e.affectedApiId===4),false,'the availability provider already fully describes an injured player');
});

test('a blank gameweek yields nothing instead of inventing a squad-wide benching',()=>{
  const out=fplLiveSelectionEvents('BHA',players,3,live([[1,0,0],[2,0,0],[3,0,0],[4,0,0],[5,0,0]]));
  assert.deepEqual([...out.events],[]);
  assert.equal(out.skipped,'no-minutes-recorded');
});

test('consecutive gameweeks accumulate as distinct observations',()=>{
  const gw2=fplLiveSelectionEvents('BHA',players,2,live([[2,90,1],[1,90,1]]));
  const gw3=fplLiveSelectionEvents('BHA',players,3,live([[2,90,1],[1,90,1]]));
  const a=gw2.events.find(e=>e.affectedApiId===2).id;
  const b=gw3.events.find(e=>e.affectedApiId===2).id;
  assert.notEqual(a,b,'the same player in different rounds must not overwrite itself');
});

test('only finished gameweeks are read, newest first',()=>{
  const bootstrap={events:[
    {id:1,finished:true,deadline_time:'2026-08-21T17:30:00Z'},
    {id:2,finished:true,deadline_time:'2026-08-28T17:30:00Z'},
    {id:3,finished:true,deadline_time:'2026-09-05T10:00:00Z'},
    {id:4,finished:false,is_next:true,deadline_time:'2026-09-12T17:30:00Z'},
  ]};
  assert.deepEqual(recentFinishedEvents(bootstrap).map(e=>e.id),[3,2,1]);
  assert.deepEqual(recentFinishedEvents({events:[{id:1,finished:false}]}),[]);
});

const teamList=(names,subs=[])=>({lineup:names.map(n=>({name:{display:n}})),substitutes:subs.map(n=>({name:{display:n}}))});

test('our team sheet is identified by roster overlap, not by an unrelated team id',()=>{
  const ours=teamList(['Bart Verbruggen','Lewis Dunk','Diego Gomez','Kaoru Mitoma','Charalampos Tzimas','Bart Verbruggen','Lewis Dunk']);
  const theirs=teamList(['Some Keeper','Another Defender','A Third Player','Fourth Name','Fifth Name','Sixth Name','Seventh Name']);
  const {list,matched}=pulseTeamListForRoster([theirs,ours],players);
  assert.equal(list,ours);
  assert.ok(matched>=6);
});

test('a team sheet that does not match the roster is refused rather than guessed at',()=>{
  const theirs=teamList(['Some Keeper','Another Defender','A Third Player']);
  const {list}=pulseTeamListForRoster([theirs],players);
  assert.equal(list,null);
  assert.deepEqual(pulseTeamListForRoster([],players).list,null);
});

test('an announced eleven becomes confirmed_start and the bench confirmed_bench',()=>{
  const list=teamList(['Bart Verbruggen','Lewis Dunk','Diego Gomez'],['Charalampos Tzimas','Not A Real Player']);
  const events=announcedXiEvents('BHA',players,list,{fixtureId:98765,kickoff:'2026-09-12T14:00:00Z',round:4,at:Date.parse('2026-09-12T13:00:00Z'),source:'https://example.test/fixture'});
  const starters=[...events].filter(e=>e.type==='confirmed_start');
  const bench=[...events].filter(e=>e.type==='confirmed_bench');
  assert.deepEqual(starters.map(e=>e.affectedApiId).sort(),[1,2,3]);
  assert.deepEqual(bench.map(e=>e.affectedApiId),[5]);
  assert.equal(starters[0].evidenceClass,'lineup');
  assert.equal(starters[0].selectionCertainty,.99);
  assert.equal(starters[0].directAvailability,1,'a named starter is by definition available');
  assert.equal(bench[0].directAvailability,null);
  assert.equal(starters[0].fixtureId,'98765');
  assert.equal(starters[0].gameweek,4);
  assert.equal(starters[0].competition,'Premier League','must not be downgraded to friendly evidence');
});

test('a team sheet naming someone outside the roster does not invent a player',()=>{
  const list=teamList(['Nobody Weknow','Another Stranger'],[]);
  assert.deepEqual([...announcedXiEvents('BHA',players,list,{})],[]);
});

test('announced-XI evidence expires within its policy window',()=>{
  const at=Date.parse('2026-09-12T13:00:00Z');
  const [event]=announcedXiEvents('BHA',players,teamList(['Lewis Dunk']),{at,round:4});
  const hours=(Date.parse(event.expiresAt)-at)/3600000;
  assert.equal(hours,30,'confirmed_start policy ttl is 30 hours');
  assert.equal(event.halfLifeHours,18);
});
