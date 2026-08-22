import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/^import\s+\{\s*WorkflowEntrypoint\s*\}\s+from\s+'cloudflare:workers';\s*/m,'')
  .replace(/export class FreshReviewWorkflow/, 'class FreshReviewWorkflow')
  .replace(/export default\s*\{/, 'const workerDefault = {')
  +'\n;globalThis.__lineupTest={fplLiveSelectionEvents,pulseTeamListForRoster,announcedXiEvents,recentFinishedEvents,recentSelectionEvents,lineupTargetEvent,teamSheetWindow,pulseSeasonForLabel,pulseGameweekForRound,pulseFixtureForFplFixture,carryForwardFailedStructuredProviders,structuredFeedCacheKey,withCurrentClubEvents,STRUCTURED_PROVIDER_CATALOG,STRUCTURED_PROVIDER_ADAPTERS,suppressDepartedCompetitorEvidence,unavailableCompetitorNames};';
class WorkflowEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}}
const context={URL,Date,Map,Set,RegExp,Object,Array,String,Number,Math,JSON,console,crypto:globalThis.crypto,WorkflowEntrypoint};
vm.createContext(context);
vm.runInContext(source,context,{filename:'worker.js'});
const {fplLiveSelectionEvents,pulseTeamListForRoster,announcedXiEvents,recentFinishedEvents,recentSelectionEvents,lineupTargetEvent,teamSheetWindow,pulseSeasonForLabel,pulseGameweekForRound,pulseFixtureForFplFixture,carryForwardFailedStructuredProviders,structuredFeedCacheKey,withCurrentClubEvents,STRUCTURED_PROVIDER_CATALOG,STRUCTURED_PROVIDER_ADAPTERS,suppressDepartedCompetitorEvidence,unavailableCompetitorNames}=context.__lineupTest;

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

test('a substitute appearance is recorded as a non-start on the same channel as a start',()=>{
  const out=fplLiveSelectionEvents('BHA',players,3,live([[1,90,1],[2,90,1],[3,20,0],[4,0,0],[5,0,0]]));
  const gomez=out.events.find(e=>e.affectedApiId===3);
  const dunk=out.events.find(e=>e.affectedApiId===2);
  assert.equal(gomez.type,'observed_bench');
  // The channel is the whole point: 'manager' retains only the latest event per
  // player, so three benchings used to count once against three starts counting
  // three times. Non-starts must accumulate exactly as starts do.
  assert.equal(gomez.evidenceClass,'selection');
  assert.equal(gomez.evidenceClass,dunk.evidenceClass,'a start and a non-start must share a channel');
  assert.equal(gomez.halfLifeHours,dunk.halfLifeHours,'and decay at the same rate');
  assert.equal(gomez.confidence,.85);
  assert.match(gomez.reason,/came off the bench for 20 minutes/);
});

test('an available player who did not play is a weaker non-start signal',()=>{
  const out=fplLiveSelectionEvents('BHA',players,3,live([[1,90,1],[2,90,1],[3,90,1],[4,0,0],[5,0,0]]));
  const tzimas=out.events.find(e=>e.affectedApiId===5);
  assert.equal(tzimas.type,'observed_bench');
  assert.equal(tzimas.evidenceClass,'selection');
  assert.equal(tzimas.confidence,.7,'weaker than an unused bench appearance: could be squad omission');
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

test('the active gameweek is selected before the future is_next gameweek',()=>{
  const bootstrap={events:[
    {id:1,is_current:true,finished:false},
    {id:2,is_next:true,finished:false},
  ]};
  assert.equal(lineupTargetEvent(bootstrap).id,1);
  assert.equal(lineupTargetEvent({events:[
    {id:1,finished:false},{id:2,is_next:true,finished:false}
  ]}).id,1,'a transiently missing is_current flag must not jump to the future round');
});

test('selection history includes the active round and excludes a future round',()=>{
  const bootstrap={events:[
    {id:1,finished:true},
    {id:2,finished:true},
    {id:3,finished:true},
    {id:4,is_current:true,finished:false},
    {id:5,is_next:true,finished:false},
  ]};
  assert.deepEqual(recentSelectionEvents(bootstrap).map(e=>e.id),[4,3,2]);
});

test('Pulse season and internal gameweek ids are resolved explicitly',()=>{
  const seasons={content:[
    {id:840,label:'English Premier League Season 2025/2026'},
    {id:841,label:'English Premier League Season 2026/2027'},
  ]};
  const gameweeks={content:[{id:19761,gameweek:1},{id:19762,gameweek:2}]};
  assert.equal(pulseSeasonForLabel(seasons,'2026/27').id,841);
  assert.equal(pulseGameweekForRound(gameweeks,1).id,19761);
});

test('Pulse fixture joining uses both teams and kickoff, never the FPL code',()=>{
  const kickoff='2026-08-22T14:00:00Z';
  const payload={content:[
    {id:128924,kickoff:{millis:Date.parse(kickoff)},teams:[{team:{id:8,name:'Leeds'}},{team:{id:9,name:'Brighton'}}]},
    {id:128925,kickoff:{millis:Date.parse(kickoff)},teams:[{team:{id:7,name:'Everton'}},{team:{id:6,name:'Crystal Palace'}}]},
  ]};
  const fixture=pulseFixtureForFplFixture(payload,{
    teamRow:{name:'Everton',short_name:'EVE',pulse_id:7},
    opponentRow:{name:'Crystal Palace',short_name:'CRY',pulse_id:6},kickoff
  });
  assert.equal(fixture.id,128925);
  assert.notEqual(fixture.id,2645197,'FPL fixture.code is not a Pulse fixture id');
});

test('team-sheet polling is bounded around kickoff',()=>{
  const kickoff='2026-08-22T14:00:00Z';
  assert.equal(teamSheetWindow(kickoff,Date.parse('2026-08-22T10:59:59Z')).open,false);
  assert.equal(teamSheetWindow(kickoff,Date.parse('2026-08-22T13:00:00Z')).open,true);
  assert.equal(teamSheetWindow(kickoff,Date.parse('2026-08-22T22:00:01Z')).open,false);
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

test('an announced eleven becomes observed selection evidence, not a next-fixture override',()=>{
  const list=teamList(['Bart Verbruggen','Lewis Dunk','Diego Gomez'],['Charalampos Tzimas','Not A Real Player']);
  const events=announcedXiEvents('BHA',players,list,{fixtureId:98765,kickoff:'2026-09-12T14:00:00Z',round:4,at:Date.parse('2026-09-12T13:00:00Z'),source:'https://example.test/fixture'});
  const starters=[...events].filter(e=>e.type==='observed_role');
  const bench=[...events].filter(e=>e.type==='observed_bench');
  assert.deepEqual(starters.map(e=>e.affectedApiId).sort(),[1,2,3]);
  assert.deepEqual(bench.map(e=>e.affectedApiId),[5]);
  assert.equal(starters[0].evidenceClass,'selection');
  assert.equal(starters[0].selectionCertainty,null,'today\'s XI must not pin the following fixture');
  assert.equal(starters[0].directImpact,false);
  assert.equal(starters[0].directAvailability,null);
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
  assert.equal(hours,720,'selection observations remain available for the rolling three-match history');
  assert.equal(event.halfLifeHours,240);
});

const evertonPlayers=[
  {id:247,name:'Pickford',fullName:'Jordan Pickford',status:'a'},
  {id:248,name:'Beto',fullName:'Norberto Bercique Gomes Betuncal',status:'a'},
  {id:249,name:'Barry',fullName:'Thierno Barry',status:'a'},
  {id:250,name:'Tarkowski',fullName:'James Tarkowski',status:'a'},
  {id:251,name:'Branthwaite',fullName:'Jarrad Branthwaite',status:'a'},
  {id:252,name:'Mykolenko',fullName:'Vitalii Mykolenko',status:'a'},
  {id:253,name:'Ndiaye',fullName:'Iliman Ndiaye',status:'a'},
];

test('Barry starting over Beto moves the two players in opposite directions',()=>{
  const events=announcedXiEvents('EVE',evertonPlayers,teamList(['Thierno Barry'],['Beto']),{
    fixtureId:3,kickoff:'2026-08-22T14:00:00Z',round:1,at:Date.parse('2026-08-22T13:02:00Z'),source:'https://example.test/128925'
  });
  const barry=events.find(e=>e.affectedApiId===249);
  const beto=events.find(e=>e.affectedApiId===248);
  assert.equal(barry.type,'observed_role');
  assert.equal(beto.type,'observed_bench');
  assert.equal(barry.confidence,.99);
  assert.equal(beto.confidence,.99);
  assert.equal(barry.evidenceClass,beto.evidenceClass);
});

test('the announced sheet and later match record share one canonical selection id',()=>{
  const sheet=announcedXiEvents('EVE',evertonPlayers,teamList(['Thierno Barry'],['Beto']),{
    fixtureId:3,kickoff:'2026-08-22T14:00:00Z',round:1,at:Date.parse('2026-08-22T13:02:00Z')
  });
  const recorded=fplLiveSelectionEvents('EVE',evertonPlayers,1,live([[249,90,1],[248,15,0]]),{
    fixtureId:3,kickoffTime:'2026-08-22T14:00:00Z'
  }).events;
  assert.equal(sheet.find(e=>e.affectedApiId===249).id,recorded.find(e=>e.affectedApiId===249).id);
  assert.equal(sheet.find(e=>e.affectedApiId===248).id,recorded.find(e=>e.affectedApiId===248).id);
});

test('cached report reads replace frozen v2 lineup evidence and its stale error',async()=>{
  const [currentBarry]=announcedXiEvents('EVE',evertonPlayers,teamList(['Thierno Barry']),{
    fixtureId:3,kickoff:'2026-08-22T14:00:00Z',round:1,at:Date.now(),source:'https://example.test/128925'
  });
  const env={ROLE_KV:{
    async get(key){
      if(key===structuredFeedCacheKey('EVE'))return {
        status:'ok',fetchedAt:new Date().toISOString(),events:[currentBarry],sources:[currentBarry.source],errors:[],unmatched:[],
        providers:[],diagnostics:{availabilityEvents:0,lineupEvents:1,selectionEvents:1}
      };
      return null;
    }
  }};
  const report={
    events:[
      {...currentBarry,id:'unsafe-v2',type:'confirmed_start',rawType:'confirmed_start',structuredFeed:true,directImpact:true,selectionCertainty:.99},
      {id:'club-selection',type:'observed_role',originType:'model',subject:'Pickford',affected:'Pickford',createdAt:Date.now()}
    ],
    sourceErrors:['Structured feed: pl-announced-xi: Pulse fixture HTTP 404','club article HTTP 503'],
    sourcesScanned:[],diagnostics:{}
  };
  const served=await withCurrentClubEvents(env,'EVE',report);
  assert.equal(served.events.some(e=>e.id==='unsafe-v2'),false);
  assert.equal(served.events.some(e=>e.id===currentBarry.id),true);
  assert.deepEqual([...served.sourceErrors],['club article HTTP 503']);
  assert.equal(served.diagnostics.structuredLineupEvents,1);
});

test('a transient provider outage carries its last valid team sheet lane',()=>{
  const now=Date.parse('2026-08-22T13:15:00Z');
  const [barry]=announcedXiEvents('EVE',evertonPlayers,teamList(['Thierno Barry']),{
    fixtureId:3,kickoff:'2026-08-22T14:00:00Z',round:1,at:now-60000,source:'https://example.test/128925'
  });
  const partial={
    status:'partial',events:[],sources:[],
    providers:[{id:'fpl-bootstrap',status:'ok'},{id:'pl-announced-xi',status:'error'}],
    diagnostics:{availabilityEvents:0,lineupEvents:0,selectionEvents:0}
  };
  const merged=carryForwardFailedStructuredProviders(partial,{events:[barry],sources:[barry.source]},now);
  assert.equal(merged.events.length,1);
  assert.equal(merged.events[0].affectedApiId,249);
  assert.equal(merged.diagnostics.carriedForwardEvents,1);
  assert.deepEqual([...merged.diagnostics.carriedForwardProviders],['pl-announced-xi']);
});

test('announced-XI adapter resolves Everton via the active Pulse gameweek',async()=>{
  const kickoff='2026-08-22T14:00:00Z';
  const bootstrap={
    events:[{id:1,is_current:true,finished:false},{id:2,is_next:true,finished:false}],
    teams:[
      {id:9,name:'Everton',short_name:'EVE',pulse_id:7},
      {id:7,name:'Crystal Palace',short_name:'CRY',pulse_id:6},
    ]
  };
  const calls=[];
  const response=data=>({ok:true,status:200,json:async()=>data});
  const fetchFn=async url=>{
    calls.push(String(url));
    if(String(url).includes('fantasy.premierleague.com/api/fixtures/?event=1'))return response([
      {id:3,code:2645197,team_h:9,team_a:7,kickoff_time:kickoff,finished:false}
    ]);
    if(String(url).includes('/competitions/1/compseasons'))return response({content:[
      {id:841,label:'English Premier League Season 2026/2027'}
    ]});
    if(String(url).includes('/compseasons/841/gameweeks'))return response({content:[
      {id:19761,gameweek:1}
    ]});
    if(String(url).includes('/football/fixtures?'))return response({content:[
      {id:128925,kickoff:{millis:Date.parse(kickoff)},teams:[{team:{id:7,name:'Everton'}},{team:{id:6,name:'Crystal Palace'}}]}
    ]});
    if(String(url).endsWith('/football/fixtures/128925'))return response({teamLists:[
      teamList(['Thierno Barry','Jordan Pickford','James Tarkowski','Jarrad Branthwaite','Vitalii Mykolenko','Iliman Ndiaye'],['Beto']),
      teamList(['Dean Henderson','Marc Guehi','Maxence Lacroix','Tyrick Mitchell','Adam Wharton','Ismaila Sarr'],[]),
    ]});
    throw new Error(`unexpected request: ${url}`);
  };
  const adapter=[...STRUCTURED_PROVIDER_ADAPTERS].find(item=>item.id==='pl-announced-xi');
  const result=await adapter.collect({
    env:{SEASON:'2026/27'},team:'EVE',players:evertonPlayers,bootstrap,
    fetchedAt:'2026-08-22T13:02:00Z',fetchFn
  });
  assert.equal(result.status,'ok');
  assert.equal(result.diagnostics.gameweek,1,'is_current must beat is_next');
  assert.equal(result.diagnostics.pulseId,128925);
  assert.equal(result.diagnostics.fplFixtureId,3);
  assert.equal(result.events.find(e=>e.affectedApiId===249).type,'observed_role');
  assert.equal(result.events.find(e=>e.affectedApiId===248).type,'observed_bench');
  assert.equal(calls.some(url=>url.endsWith('/football/fixtures/128925')),true);
  assert.equal(calls.some(url=>url.endsWith('/football/fixtures/2645197')),false,'FPL code must never be requested as a Pulse fixture id');
});

/* The 21 Aug review argued against Kinsky's start "due to Vicario's
   availability" while the same report already knew Vicario had joined Juventus
   on loan. The role-competition path is goalkeeper-only and fires only when a
   story does NOT name our player, so a story about the departed keeper in a
   "first choice / starting" context reads as a threat to his replacement. */

const spursReport={
  club:'Tottenham Hotspur',
  clubEvents:[{type:'departure',subject:'Spence'},{type:'loan_out',subject:'Yang'}],
  events:[
    {type:'unavailable',rawType:'unavailable',subject:'Vicario',reason:'Has joined Juventus on loan for the rest of the season.'},
    {type:'fitness_doubt',rawType:'fitness_doubt',subject:'Dragusin',reason:'Knock - 75% chance of playing.'},
  ],
};
const peerItem=(relatedPlayer,signal)=>({
  id:'news-x',title:'Spurs goalkeeper latest',summary:'first choice for the season',
  hierarchyInference:true,relatedPlayer,signal,authorityTier:1,decisionRelevant:true,decisionEligible:true,
});

test('a departed competitor is recognised by full name and by surname',()=>{
  const gone=unavailableCompetitorNames(spursReport);
  assert.equal(gone.has('vicario'),true);
  assert.equal(gone.has('spence'),true,'permanent departures count');
  assert.equal(gone.has('yang'),true,'loans out count');
  assert.equal(gone.has('dragusin'),false,'a fitness doubt is still 75% likely to play, so he remains genuine competition');
  assert.equal(gone.has('kinsky'),false);
});

test('a negative inference resting on a departed competitor stops driving the verdict',()=>{
  const [item]=suppressDepartedCompetitorEvidence([peerItem('Guglielmo Vicario','negative')],spursReport);
  assert.equal(item.decisionEligible,false,'must not count as decision evidence');
  assert.equal(item.decisionRelevant,false);
  assert.match(item.suppressedReason,/Vicario/);
  assert.match(item.suppressedReason,/no longer available/);
});

test('a positive inference about the same departure still counts',()=>{
  const [item]=suppressDepartedCompetitorEvidence([peerItem('Guglielmo Vicario','positive')],spursReport);
  assert.equal(item.decisionEligible,true,'"the competitor left" is real evidence in our player\'s favour');
  assert.equal(item.suppressedReason,undefined);
});

test('a competitor who is still at the club is untouched',()=>{
  const [item]=suppressDepartedCompetitorEvidence([peerItem('Martin Dubravka','negative')],spursReport);
  assert.equal(item.decisionEligible,true,'Dubravka is genuine live competition and must keep counting');
});

test('direct evidence about the player himself is never suppressed',()=>{
  const direct={id:'news-y',hierarchyInference:false,relatedPlayer:'Guglielmo Vicario',signal:'negative',decisionRelevant:true,decisionEligible:true};
  const [item]=suppressDepartedCompetitorEvidence([direct],spursReport);
  assert.equal(item.decisionEligible,true);
});

test('a report with no departures leaves every item alone',()=>{
  const items=[peerItem('Guglielmo Vicario','negative')];
  assert.equal(suppressDepartedCompetitorEvidence(items,{})[0].decisionEligible,true);
  assert.equal(suppressDepartedCompetitorEvidence(items,null)[0].decisionEligible,true);
});
