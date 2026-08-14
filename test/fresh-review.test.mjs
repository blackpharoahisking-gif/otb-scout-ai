import assert from 'node:assert/strict';
import {generateKeyPairSync,sign as signBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/^import\s+\{\s*WorkflowEntrypoint\s*\}\s+from\s+'cloudflare:workers';\s*/m,'')
  .replace(/export class FreshReviewWorkflow/, 'class FreshReviewWorkflow')
  .replace(/export default\s*\{/, 'const workerDefault = {')
  +'\n;globalThis.__freshTest={activeChipValue,validateFreshReviewContext,enrichFreshReviewIdentitiesFromBootstrap,freshProjectedTotal,statusForFreshPlayer,enforceFreshVerdict,fallbackFreshClassification,freshContextDiff,freshCacheMinutes,unavailableFreshPlayer,freshPublisherTier,freshSourceWeight,freshNewsDate,freshNewsItemsFromHtml,freshNewsItemsFromRss,freshNewsQueries,freshPlayerEvidenceMatches,freshHierarchyPeerMatches,freshHierarchySignal,freshEvidenceCategory,freshRecency,freshAnnotateEvidence,freshEvidenceCoverage,buildFreshSquadSummary,createFreshReviewJob,processFreshReviewPlayer,finalizeFreshReview,freshJobKey,freshCacheKey,freshLatestKey,publicFreshJob,freshReviewAuthorised,freshReviewIdentity,verifyFreshOwnerCapability,verifyAccessJwt,sha256Hex,FreshReviewWorkflow};';
class WorkflowEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}}
const context={URL,Date,Map,Set,RegExp,Object,Array,String,Number,Math,JSON,console,crypto:globalThis.crypto,TextEncoder,TextDecoder,atob,WorkflowEntrypoint,fetch:globalThis.fetch,Response};
vm.createContext(context);
vm.runInContext(source,context,{filename:'worker.js'});
const api=context.__freshTest;

function gw1(activeChip='NONE'){
  const base=(playerId,name,club,position,squadRole,xPts,expectedMinutes,startProbability,extra={})=>({
    playerId,name,club,position,squadRole,xPts,expectedMinutes,startProbability,availability:1,...extra
  });
  return {
    season:'2026/27',gameweek:1,activeChip,formation:'3-5-2',captainId:5,viceCaptainId:8,
    players:[
      base(1,'Verbruggen','BHA','GKP','XI',4.1,90,.96),
      base(2,'Gabriel','ARS','DEF','XI',4.8,88,.95),
      base(3,'Calafiori','ARS','DEF','XI',3.53,60,.76),
      base(4,'Hume','SUN','DEF','XI',3.2,86,.93),
      base(5,'B.Fernandes','MUN','MID','XI',6.22,83,.94,{captain:true}),
      base(6,'Semenyo','BOU','MID','XI',4.6,86,.94),
      base(7,'Mbeumo','MUN','MID','XI',5.4,82,.9),
      base(8,'Wirtz','LIV','MID','XI',5.1,69,.76,{viceCaptain:true}),
      base(9,'Le Fée','SUN','MID','XI',3.8,78,.85),
      base(10,'João Pedro','CHE','FWD','XI',4.7,76,.82),
      base(11,'Calvert-Lewin','LEE','FWD','XI',4.1,70,.75),
      base(12,'Kinsky','TOT','GKP','BENCH',2.1,35,.39,{benchOrder:1}),
      base(13,'Isak','LIV','FWD','BENCH',5.4,72,.78,{benchOrder:2}),
      base(14,'Shaw','MUN','DEF','BENCH',3.1,58,.65,{benchOrder:3}),
      base(15,"O'Nien",'SUN','DEF','BENCH',2.8,65,.72,{benchOrder:4})
    ],
    otbAlerts:[{severity:'AMBER',message:'Example current OTB alert'}]
  };
}

function validated(chip='NONE'){
  const result=api.validateFreshReviewContext(gw1(chip));
  assert.equal(result.ok,true,result.errors.join('\n'));
  return result.context;
}

function memoryEnv(){
  const rows=new Map(),workflowStarts=[];
  return{rows,workflowStarts,FRESH_REVIEW_WORKFLOW:{async create(options){workflowStarts.push(options);return{id:options.id}}},ROLE_KV:{
    async get(key,type){const value=rows.get(String(key));if(value==null)return null;return type==='json'?JSON.parse(value):value},
    async put(key,value){rows.set(String(key),String(value))}
  }};
}

test('valid squad contract requires a legal 15',()=>{
  const valid=api.validateFreshReviewContext(gw1());
  assert.equal(valid.ok,true);
  const invalid=gw1();invalid.players.pop();
  const rejected=api.validateFreshReviewContext(invalid);
  assert.equal(rejected.ok,false);
  assert.match(rejected.errors.join(' '),/exactly 15/i);
});

test('no chip scores XI plus one captain duplication and leaves bench non-scoring',()=>{
  const ctx=validated('NONE');
  assert.equal(ctx.activeChip,'NONE');
  assert.equal(ctx.players.filter(p=>p.scoring).length,11);
  assert.equal(ctx.players.find(p=>p.name==='Kinsky').scoring,false);
  const xi=ctx.players.filter(p=>p.squadRole==='XI').reduce((sum,p)=>sum+p.xPts,0);
  const captain=ctx.players.find(p=>p.captain);
  assert.equal(api.freshProjectedTotal(ctx),Number((xi+captain.xPts).toFixed(2)));
});

test('Bench Boost scores all 15 while preserving the legal bench order',()=>{
  const ctx=validated('BB');
  assert.equal(ctx.activeChip,'BENCH_BOOST');
  assert.equal(ctx.players.filter(p=>p.scoring).length,15);
  assert.equal(ctx.players.find(p=>p.name==='Kinsky').benchOrder,1);
  const all=ctx.players.reduce((sum,p)=>sum+p.xPts,0);
  const captain=ctx.players.find(p=>p.captain);
  assert.equal(api.freshProjectedTotal(ctx),Number((all+captain.xPts).toFixed(2)));
});

test('Triple Captain is generic chip state and applies two captain duplications',()=>{
  const normal=validated('NONE'),triple=validated('TRIPLE CAPTAIN');
  assert.equal(triple.activeChip,'TRIPLE_CAPTAIN');
  assert.equal(api.freshProjectedTotal(triple),Number((api.freshProjectedTotal(normal)+triple.players.find(p=>p.captain).xPts).toFixed(2)));
});

test('Kinsky low OTB start security is a material Bench Boost risk',()=>{
  const ctx=validated('BENCH_BOOST'),player=ctx.players.find(p=>p.name==='Kinsky');
  assert.equal(api.statusForFreshPlayer(ctx,player,'UNKNOWN'),'RED');
  const failed=api.unavailableFreshPlayer(ctx,player,'simulated source failure');
  assert.equal(failed.classification,'UNKNOWN');
  assert.equal(failed.status,'RED');
  assert.match(failed.rationale,/Bench Boost/i);
});

test('Tier 1 negative evidence cannot be silently overruled by weak optimism',()=>{
  const ctx=validated(),player=ctx.players.find(p=>p.name==='Calafiori');
  const evidence=[
    {id:'official',authorityTier:1,weight:.95,signal:'negative',publisher:'Arsenal',summary:'Officially ruled out',title:'Team news',url:'https://www.arsenal.com/news/team-news',relevantDate:new Date().toISOString()},
    {id:'rumour',authorityTier:4,weight:.2,signal:'positive',publisher:'Aggregator',summary:'Could start',title:'Predicted XI',url:'https://example.test',relevantDate:new Date().toISOString()}
  ];
  const result=api.enforceFreshVerdict(ctx,player,evidence,{classification:'STRONG UPGRADE',status:'OPPORTUNITY',confidence:'LOW',rationale:'Weak report says he may start.',freshEvidenceSummary:'Mixed.',monitorPoint:'Team news.',evidenceIds:['rumour']});
  assert.equal(result.classification,'DOWNGRADE');
  assert.equal(result.status,'AMBER');
  assert.doesNotMatch(result.rationale,/Weak report/);
});

test('positive disagreement can upgrade a conservative OTB assumption',()=>{
  const ctx=validated(),player={...ctx.players.find(p=>p.name==='Wirtz'),startProbability:.52};
  const evidence=[{id:'lineup',authorityTier:1,weight:.9,signal:'positive',publisher:'Liverpool',summary:'Started final first-team preparation match',title:'Confirmed XI',url:'https://www.liverpoolfc.com/news',relevantDate:new Date().toISOString()}];
  const result=api.enforceFreshVerdict(ctx,player,evidence,{classification:'STRONG UPGRADE',status:'OPPORTUNITY',confidence:'HIGH',rationale:'Recent official first-team selection is stronger than OTB.',freshEvidenceSummary:'Recent official selection.',monitorPoint:'Final press conference.',evidenceIds:['lineup']});
  assert.equal(result.classification,'STRONG UPGRADE');
  assert.equal(result.status,'OPPORTUNITY');
});

test('missing evidence produces UNKNOWN rather than invented certainty',()=>{
  const ctx=validated(),player=ctx.players.find(p=>p.name==='Calvert-Lewin');
  const result=api.enforceFreshVerdict(ctx,player,[],{classification:'AGREE',status:'GREEN',confidence:'HIGH',rationale:'Certain.',freshEvidenceSummary:'Certain.',monitorPoint:'',evidenceIds:[]});
  assert.equal(result.classification,'UNKNOWN');
  assert.equal(result.confidence,'LOW');
  assert.equal(result.evidenceIds.length,0);
});

test('stale-only or undated evidence stays visible but cannot drive a gameweek verdict',()=>{
  const ctx=validated(),player=ctx.players.find(p=>p.name==='Calafiori'),evidence=[{id:'old',authorityTier:1,weight:.18,signal:'negative',publisher:'Arsenal',summary:'Old injury report',title:'Historical team news',url:'https://www.arsenal.com/news/old',relevantDate:'2025-12-01T12:00:00Z'}];
  const result=api.enforceFreshVerdict(ctx,player,evidence,{classification:'STRONG DOWNGRADE',confidence:'HIGH',rationale:'Old evidence says out.',freshEvidenceSummary:'Old report.',monitorPoint:'',evidenceIds:['old']});
  assert.equal(result.classification,'UNKNOWN');
  assert.equal(result.confidence,'LOW');
  assert.equal(result.evidenceIds.length,0);
  assert.match(result.freshEvidenceSummary,/historical|undated/i);
});

test('changed-squad review identifies only new additions for selective research',()=>{
  const before=validated(),after=validated();
  after.players[12]={...after.players[12],playerId:'99',name:'Nmecha',club:'LEE'};
  const diff=api.freshContextDiff(before,after);
  assert.equal(diff.hasChanges,true);
  assert.equal([...diff.added].join(','),'99');
  assert.equal([...diff.removed].join(','),'13');
});

test('near-deadline cache windows are shorter than normal windows',()=>{
  const now=Date.parse('2026-08-14T12:00:00Z');
  const ctx=validated();
  ctx.deadline='2026-08-14T13:30:00Z';
  assert.equal(api.freshCacheMinutes(ctx,now),20);
  ctx.deadline='2026-08-15T12:00:00Z';
  assert.equal(api.freshCacheMinutes(ctx,now),180);
});

test('RotoWire is preferred within Tier 2 but never promoted above official evidence',()=>{
  assert.equal(api.freshPublisherTier('RotoWire','https://www.rotowire.com/soccer/','Player update'),2);
  assert.equal(api.freshPublisherTier('Liverpool FC','https://news.google.com/read/example','Club update'),1);
  assert.equal(api.freshPublisherTier('Liverpool Echo','https://news.google.com/read/example','Player update'),2);
  assert.equal(api.freshPublisherTier('readliverpoolfc.com','https://news.google.com/read/example','Player update'),4);
  const ordinary=api.freshSourceWeight({authorityTier:2,relevantDate:new Date().toISOString(),title:'Team update',summary:''});
  const preferred=api.freshSourceWeight({authorityTier:2,relevantDate:new Date().toISOString(),title:'Team update',summary:'',preferredSource:true});
  const official=api.freshSourceWeight({authorityTier:1,relevantDate:new Date().toISOString(),title:'Official team news',summary:''});
  assert.ok(preferred>ordinary);
  assert.ok(preferred<official);
});

test('publisher authority comes from the source rather than headline wording',()=>{
  assert.equal(api.freshPublisherTier('The English Football League','https://news.google.com/read/efl','Competition update'),1);
  assert.equal(api.freshPublisherTier('The Argus','https://news.google.com/read/argus','Brighton update'),2);
  assert.equal(api.freshPublisherTier('Fantasy Football Scout','https://news.google.com/read/ffs','Predicted lineup'),2);
  assert.equal(api.freshPublisherTier('Unknown aggregator','https://news.google.com/read/fake','Official club update'),4);
});

test('official FPL IDs expand compact display names before research',()=>{
  const ctx=validated(),bootstrap={
    teams:[{id:10,name:'Manchester United',short_name:'MUN'},{id:18,name:'Sunderland',short_name:'SUN'}],
    elements:[
      {id:5,first_name:'Bruno',second_name:'Borges Fernandes',web_name:'B.Fernandes',team:10},
      {id:9,first_name:'Enzo',second_name:'Le Fée',web_name:'E.Le Fée',team:18}
    ]
  };
  const enriched=api.enrichFreshReviewIdentitiesFromBootstrap(ctx,bootstrap),bruno=enriched.players.find(p=>p.playerId==='5'),leFee=enriched.players.find(p=>p.playerId==='9');
  assert.equal(bruno.canonicalName,'Bruno Borges Fernandes');
  assert.equal(bruno.searchName,'Bruno Fernandes');
  assert.equal(bruno.identitySource,'FPL_BOOTSTRAP');
  assert.match(api.freshNewsQueries(bruno,Date.parse('2026-08-14T12:00:00Z'))[0],/^"Bruno Fernandes" "Manchester United"/);
  assert.equal(leFee.canonicalName,'Enzo Le Fée');
  assert.match(api.freshNewsQueries(leFee,Date.parse('2026-08-14T12:00:00Z'))[0],/^"Enzo Le Fée" "Sunderland"/);
});

test('official FPL roster enriches players with same-club same-position competitors',()=>{
  const context={players:[{playerId:'101',name:'Kinsky',club:'TOT',position:'GKP'}]},data={
    teams:[{id:18,short_name:'TOT',name:'Tottenham Hotspur'}],
    elements:[
      {id:101,team:18,element_type:1,first_name:'Antonin',second_name:'Kinsky',web_name:'Kinsky'},
      {id:102,team:18,element_type:1,first_name:'Guglielmo',second_name:'Vicario',web_name:'Vicario'},
      {id:103,team:18,element_type:1,first_name:'Martin',second_name:'Dubravka',web_name:'Dubravka'},
      {id:104,team:18,element_type:2,first_name:'Pedro',second_name:'Porro',web_name:'Porro'}
    ]
  };
  const player=api.enrichFreshReviewIdentitiesFromBootstrap(context,data).players[0];
  assert.ok(player.competitionAliases.includes('Guglielmo Vicario'));
  assert.ok(player.competitionAliases.includes('Martin Dubravka'));
  assert.ok(!player.competitionAliases.includes('Pedro Porro'));
  assert.match(api.freshNewsQueries(player).at(-1),/Vicario/);
});

test('competitor departure reporting becomes guarded positive hierarchy evidence',()=>{
  const player={playerId:'101',name:'Kinsky',canonicalName:'Antonin Kinsky',searchName:'Antonin Kinsky',webName:'Kinsky',club:'TOT',position:'GKP',identityAliases:['Antonin Kinsky','Kinsky'],competitionAliases:['Guglielmo Vicario','Vicario','Martin Dubravka','Dubravka']};
  const xml='<rss><channel><item><title>Juventus pursue Guglielmo Vicario transfer</title><link>https://example.test/vicario</link><description>Tottenham Hotspur goalkeeper Vicario is outside the manager plans and set to leave.</description><pubDate>Fri, 14 Aug 2026 08:00:00 GMT</pubDate><source url="https://www.skysports.com">Sky Sports</source></item></channel></rss>';
  const rows=api.freshNewsItemsFromRss(xml,player);
  assert.equal(rows.length,1);
  assert.equal(rows[0].signal,'positive');
  assert.equal(rows[0].evidenceCategory,'ROLE_COMPETITION');
  assert.equal(rows[0].hierarchyInference,true);
  assert.match(rows[0].relatedPlayer,/Vicario/);
});

test('outfield FPL buckets do not create unsafe same-position competitor aliases',()=>{
  const context={players:[{playerId:'201',name:'Senesi',club:'TOT',position:'DEF'}]},data={teams:[{id:18,short_name:'TOT',name:'Tottenham Hotspur'}],elements:[
    {id:201,team:18,element_type:2,first_name:'Marcos',second_name:'Senesi',web_name:'Senesi'},
    {id:202,team:18,element_type:2,first_name:'Cristian',second_name:'Romero',web_name:'Romero'}
  ]};
  const player=api.enrichFreshReviewIdentitiesFromBootstrap(context,data).players[0];
  assert.equal(player.competitionAliases.length,0);
  assert.equal(api.freshHierarchyPeerMatches({...player,competitionAliases:['Cristian Romero']},'Tottenham Hotspur: Romero inspires Argentina comeback'),null);
});

test('indirect goalkeeper competition is capped at partial monitoring evidence',()=>{
  const ctx=validated(),player={...ctx.players.find(p=>p.name==='Kinsky'),position:'GKP'};
  const evidence=[api.freshAnnotateEvidence({id:'peer',authorityTier:1,signal:'negative',publisher:'Tottenham Hotspur',publisherUrl:'https://www.tottenhamhotspur.com',title:'Vicario signs a new contract',summary:'Tottenham goalkeeper Vicario signs an extension',url:'https://www.tottenhamhotspur.com/news/vicario',relevantDate:new Date().toISOString(),evidenceCategory:'ROLE_COMPETITION',hierarchyInference:true,relatedPlayer:'Guglielmo Vicario'})];
  const result=api.enforceFreshVerdict(ctx,player,evidence,{classification:'STRONG DOWNGRADE',confidence:'HIGH',rationale:'Vicario remains competition.',freshEvidenceSummary:'Contract extension.',monitorPoint:'Team news.',evidenceIds:['peer']});
  assert.equal(result.evidenceCoverage,'PARTIAL');
  assert.equal(result.classification,'MONITOR');
  assert.equal(result.status,'AMBER');
});

test('marketing and charity stories cannot become decision evidence',()=>{
  const player={playerId:'1',name:'Kelleher',canonicalName:'Caoimhin Kelleher',searchName:'Caoimhin Kelleher',webName:'Kelleher',club:'BRE',position:'GKP',identityAliases:['Caoimhin Kelleher','Kelleher'],competitionAliases:[]};
  const xml='<rss><channel><item><title>Caoimhin Kelleher supports Irish Guide Dogs charity</title><link>https://example.test/charity</link><description>Brentford goalkeeper attends a charity event.</description><pubDate>Fri, 14 Aug 2026 08:00:00 GMT</pubDate><source url="https://example.test">Example</source></item></channel></rss>';
  const rows=api.freshNewsItemsFromRss(xml,player);
  assert.equal(rows.length,1);
  assert.equal(rows[0].decisionRelevant,false);
  assert.equal(rows[0].decisionEligible,false);
});

test('future-dated evidence is quarantined instead of treated as current',()=>{
  const now=Date.parse('2026-08-14T12:00:00Z'),future=new Date(now+24*3600000).toISOString(),recency=api.freshRecency(future,'LINEUP',now);
  assert.equal(recency.band,'FUTURE DATE');
  assert.equal(recency.decisionEligible,false);
});

test('public football names handle compound legal surnames and true mononyms',()=>{
  const context={players:[{playerId:'127',name:'Gomez',club:'BHA'},{playerId:'248',name:'Beto',club:'EVE'}]},bootstrap={teams:[{id:5,name:'Brighton and Hove Albion',short_name:'BHA'},{id:9,name:'Everton',short_name:'EVE'}],elements:[{id:127,first_name:'Diego',second_name:'Gómez Amarilla',web_name:'Gomez',team:5},{id:248,first_name:'Norberto',second_name:'Bercique Gomes Betuncal',web_name:'Beto',team:9}]};
  const enriched=api.enrichFreshReviewIdentitiesFromBootstrap(context,bootstrap),gomez=enriched.players[0],beto=enriched.players[1];
  assert.equal(gomez.searchName,'Diego Gomez');
  assert.equal(api.freshPlayerEvidenceMatches(gomez,'Diego Gomez returns to Brighton training'),true);
  assert.equal(api.freshPlayerEvidenceMatches(gomez,'Joe Gomez returns to Liverpool training'),false);
  assert.equal(beto.searchName,'Beto');
  assert.match(api.freshNewsQueries(beto,Date.parse('2026-08-14T12:00:00Z'))[0],/^"Beto" "Everton"/);
});

test('canonical identity rejects Joe Gomez evidence for Brighton Diego Gomez',()=>{
  const player={playerId:'99',name:'Gomez',canonicalName:'Diego Gomez',webName:'Gomez',identityAliases:['Diego Gomez','Gomez'],club:'BHA'};
  assert.equal(api.freshPlayerEvidenceMatches(player,'Joe Gomez returns to Liverpool training'),false);
  assert.equal(api.freshPlayerEvidenceMatches(player,'Diego Gomez returns to Brighton training'),true);
  assert.equal(api.freshPlayerEvidenceMatches(player,'Gomez, Wieffer and Milner: Brighton team news'),true);
});

test('evidence lifetimes are category-specific rather than a blanket 45-day cutoff',()=>{
  const now=Date.parse('2026-08-14T12:00:00Z'),sixtyDaysAgo=new Date(now-60*86400000).toISOString(),twentyDaysAgo=new Date(now-20*86400000).toISOString();
  assert.equal(api.freshEvidenceCategory({title:'Player completes transfer and competes for first-team role'}),'ROLE_COMPETITION');
  assert.equal(api.freshRecency(sixtyDaysAgo,'ROLE_COMPETITION',now).decisionEligible,true);
  assert.equal(api.freshRecency(twentyDaysAgo,'PREDICTED_LINEUP',now).decisionEligible,false);
});

test('missing live evidence is UNVERIFIED coverage, not an automatic squad warning',()=>{
  const ctx=validated(),player=ctx.players.find(p=>p.captain),result=api.enforceFreshVerdict(ctx,player,[],{classification:'AGREE',status:'GREEN',confidence:'HIGH',rationale:'Certain.',freshEvidenceSummary:'Certain.',monitorPoint:'',evidenceIds:[]});
  assert.equal(result.classification,'UNKNOWN');
  assert.equal(result.evidenceCoverage,'UNVERIFIED');
  assert.equal(result.status,'GREEN');
  const reviews=ctx.players.map(row=>api.unavailableFreshPlayer(ctx,row,'simulated search gap'));
  const summary=api.buildFreshSquadSummary(ctx,reviews);
  assert.match(summary.primaryIssue,/inconclusive/i);
  assert.doesNotMatch(summary.primaryIssue,/B\.Fernandes\s+—/);
  assert.match(summary.captainAssessment,/did not independently validate/i);
});

test('public Google News HTML fallback preserves publisher, date and RotoWire preference',()=>{
  const player={playerId:'3',name:'Calafiori'},html='<a class="JtKRv" href="./read/example?hl=en-GB&amp;gl=GB" data-n-tid="29" aria-label="Calafiori returns to Arsenal training - RotoWire - 14 Aug">Calafiori returns to Arsenal training</a>';
  const rows=api.freshNewsItemsFromHtml(html,player);
  assert.equal(rows.length,1);
  assert.equal(rows[0].publisher,'RotoWire');
  assert.equal(rows[0].authorityTier,2);
  assert.equal(rows[0].preferredSource,true);
  assert.match(rows[0].relevantDate,/^2026-08-14/);
});

test('Google News HTML fallback recovers a date while neutral presence remains non-decision evidence',()=>{
  const player={playerId:'3',name:'Calafiori'},html='<article><a class="JtKRv" href="./read/example" data-n-tid="29">Calafiori returns to Arsenal training</a><time datetime="2026-08-14T08:00:00Z">2 hours ago</time></article>';
  const rows=api.freshNewsItemsFromHtml(html,player);
  assert.equal(rows.length,1);
  assert.equal(rows[0].relevantDate,'2026-08-14T08:00:00.000Z');
  assert.equal(rows[0].decisionEligible,false);
});

test('relative Google News timestamps become source-owned ISO dates',()=>{
  const now=Date.parse('2026-08-14T12:00:00Z');
  assert.equal(api.freshNewsDate('2 hours ago',now),'2026-08-14T10:00:00.000Z');
  assert.equal(api.freshNewsDate('Yesterday 08:30',now),'2026-08-13T08:30:00.000Z');
});

test('RSS parser accepts namespaced publishers and rejects unrelated results',()=>{
  const player={playerId:'8',name:'Wirtz'},xml='<rss><channel><item><title>Wirtz starts Liverpool final friendly</title><link>https://example.test/wirtz</link><description>Confirmed current role</description><pubDate>Fri, 14 Aug 2026 08:00:00 GMT</pubDate><News:Source>Premier League</News:Source></item><item><title>Unrelated club story</title><link>https://example.test/other</link><pubDate>Fri, 14 Aug 2026 08:00:00 GMT</pubDate><News:Source>Example</News:Source></item></channel></rss>';
  const rows=api.freshNewsItemsFromRss(xml,player,'Fixture RSS');
  assert.equal(rows.length,1);
  assert.equal(rows[0].publisher,'Premier League');
  assert.equal(rows[0].authorityTier,1);
});

test('owner authentication verifies a signed capability and preserves the admin fallback',async()=>{
  const keys=generateKeyPairSync('ed25519'),publicDer=keys.publicKey.export({format:'der',type:'spki'}),publicRaw=publicDer.subarray(publicDer.length-32).toString('base64url'),now=Math.floor(Date.now()/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const header=encode({alg:'EdDSA',typ:'JWT',kid:'otb-fresh-2026-01'}),payload=encode({iss:'otb-owner',aud:'otb-fresh-review',sub:'marcus',scope:['fresh-review'],iat:now,nbf:now-30,exp:now+3600,jti:'test-only'}),input=header+'.'+payload,token=input+'.'+signBytes(null,Buffer.from(input),keys.privateKey).toString('base64url');
  assert.equal(await api.verifyFreshOwnerCapability(token,publicRaw,now),true);
  assert.equal(await api.verifyFreshOwnerCapability(token.slice(0,-2)+'aa',publicRaw,now),false);
  const request={url:'https://worker.test/api/fresh-review',headers:{get(name){return String(name).toLowerCase()==='authorization'?'Bearer existing-admin-token':null}}};
  assert.equal(await api.freshReviewAuthorised(request,{SCOUT_ADMIN_TOKEN:'existing-admin-token'}),true);
});

test('job finalization survives every player research failure and caches the complete review',async()=>{
  const env=memoryEnv(),created=await api.createFreshReviewJob(env,{context:gw1('BENCH_BOOST')});
  assert.equal(created.status,202);
  const jobId=created.body.jobId,finalized=await api.finalizeFreshReview(env,jobId);
  assert.equal(finalized.status,200);
  assert.equal(finalized.body.review.playerReviews.length,15);
  assert.equal(finalized.body.review.research.failedPlayers,15);
  assert.equal(finalized.body.review.mutatesProjection,false);
  assert.equal(finalized.body.review.activeChip,'BENCH_BOOST');
  assert.equal(finalized.body.review.scoringPlayerCount,15);
  assert.equal(finalized.body.review.coverageCounts.UNVERIFIED,15);
  assert.equal(finalized.body.review.research.researchedPlayers,15);
  const cached=await api.createFreshReviewJob(env,{context:gw1('BENCH_BOOST')});
  assert.equal(cached.status,200);
  assert.equal(cached.body.cache,'HIT');
  assert.equal(cached.body.review.reviewId,jobId);
});

test('force refresh creates a new job while a changed-squad review can target only the addition',async()=>{
  const env=memoryEnv(),first=await api.createFreshReviewJob(env,{context:gw1('NONE')});
  const firstId=first.body.jobId;await api.finalizeFreshReview(env,firstId);
  const forced=await api.createFreshReviewJob(env,{context:gw1('NONE'),force:true});
  assert.equal(forced.status,202);
  assert.notEqual(forced.body.jobId,firstId);
  const changed=gw1('NONE'),replacement=changed.players.find(p=>p.playerId===13);replacement.playerId=99;replacement.name='Nmecha';replacement.club='LEE';
  const partial=await api.createFreshReviewJob(env,{context:changed,force:true,priorReviewId:firstId,selectedPlayerIds:[99]});
  assert.equal(partial.status,202);
  assert.equal(partial.body.targetPlayers,1);
  assert.equal(partial.body.reusedPlayers,14);
  assert.equal(partial.body.diff.added.join(','),'99');
});

test('creating a review starts one durable Workflow and reports that the browser may close',async()=>{
  const env=memoryEnv(),identity={id:'access:marcus',role:'admin',mode:'cloudflare-access'};
  const created=await api.createFreshReviewJob(env,{context:gw1('NONE')},identity);
  assert.equal(created.status,202);
  assert.equal(created.body.executionMode,'cloudflare-workflow');
  assert.equal(created.body.safeToClose,true);
  assert.equal(created.body.status,'queued');
  assert.equal(env.workflowStarts.length,1);
  assert.equal(env.workflowStarts[0].id,created.body.jobId);
  assert.equal(env.workflowStarts[0].params.actorId,identity.id);
});

test('an active identical review is reused instead of starting a second scan',async()=>{
  const env=memoryEnv(),identity={id:'access:marcus',role:'admin',mode:'cloudflare-access'};
  const first=await api.createFreshReviewJob(env,{context:gw1('NONE')},identity);
  const second=await api.createFreshReviewJob(env,{context:gw1('NONE')},identity);
  assert.equal(second.status,202);
  assert.equal(second.body.cache,'ACTIVE');
  assert.equal(second.body.jobId,first.body.jobId);
  assert.equal(env.workflowStarts.length,1);
});

test('Workflow finishes all 15 after the initiating browser has done no player requests',async()=>{
  const env=memoryEnv(),identity={id:'access:marcus',role:'admin',mode:'cloudflare-access'};
  const created=await api.createFreshReviewJob(env,{context:gw1('BENCH_BOOST')},identity),job=await env.ROLE_KV.get(api.freshJobKey(created.body.jobId),'json');
  for(const player of job.context.players)job.playerReviews[player.playerId]=api.unavailableFreshPlayer(job.context,player,'isolated workflow fixture');
  await env.ROLE_KV.put(api.freshJobKey(job.jobId),JSON.stringify(job));
  const stepNames=[],step={async do(name,options,callback){if(typeof options==='function'){callback=options}stepNames.push(name);return callback()}};
  const workflow=new api.FreshReviewWorkflow(null,env),result=await workflow.run({payload:{jobId:job.jobId,actorId:identity.id}},step);
  const completed=await env.ROLE_KV.get(api.freshJobKey(job.jobId),'json');
  assert.equal(result.reviewId,job.jobId);
  assert.equal(completed.status,'complete');
  assert.equal(completed.review.playerReviews.length,15);
  assert.equal(completed.review.scoringPlayerCount,15);
  assert.equal(stepNames.filter(name=>name.startsWith('research player ')).length,15);
});

test('review jobs and caches are isolated by authenticated user identity',async()=>{
  const env=memoryEnv(),alice={id:'access:alice',role:'reviewer',mode:'cloudflare-access'},bob={id:'access:bob',role:'reviewer',mode:'cloudflare-access'};
  const first=await api.createFreshReviewJob(env,{context:gw1('NONE')},alice);await api.finalizeFreshReview(env,first.body.jobId,alice.id);
  const bobJob=await api.createFreshReviewJob(env,{context:gw1('NONE')},bob);
  assert.equal(bobJob.status,202);
  assert.notEqual(bobJob.body.jobId,first.body.jobId);
  assert.notEqual(api.freshCacheKey(alice.id,first.body.contextHash),api.freshCacheKey(bob.id,bobJob.body.contextHash));
  assert.equal((await api.processFreshReviewPlayer(env,first.body.jobId,'1',bob.id)).status,404);
});

test('Cloudflare Access JWT validation checks signature, audience and exact email allowlist',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=publicKey.export({format:'jwk'}),now=Math.floor(Date.now()/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  jwk.kid='access-test-key';jwk.alg='RS256';jwk.use='sig';
  const header=encode({alg:'RS256',typ:'JWT',kid:jwk.kid}),payload=encode({iss:'https://otb.cloudflareaccess.com',aud:['fresh-aud'],email:'marcus@example.com',iat:now,nbf:now-10,exp:now+3600}),input=header+'.'+payload,token=input+'.'+signBytes('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url'),previousFetch=context.fetch;
  context.fetch=async()=>new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{'Content-Type':'application/json'}});
  try{
    const identity=await api.verifyAccessJwt(token,{CF_ACCESS_TEAM_DOMAIN:'otb.cloudflareaccess.com',CF_ACCESS_AUD:'fresh-aud',FRESH_REVIEW_ALLOWED_EMAILS:'marcus@example.com'} ,now);
    assert.equal(identity.email,'marcus@example.com');
    assert.equal(identity.mode,'cloudflare-access');
    assert.equal(await api.verifyAccessJwt(token,{CF_ACCESS_TEAM_DOMAIN:'otb.cloudflareaccess.com',CF_ACCESS_AUD:'wrong-aud',FRESH_REVIEW_ALLOWED_EMAILS:'marcus@example.com'},now),null);
    assert.equal(await api.verifyAccessJwt(token,{CF_ACCESS_TEAM_DOMAIN:'otb.cloudflareaccess.com',CF_ACCESS_AUD:'fresh-aud',FRESH_REVIEW_ALLOWED_EMAILS:'someone@example.com'},now),null);
  }finally{context.fetch=previousFetch}
});
