import assert from 'node:assert/strict';
import {generateKeyPairSync,sign as signBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/export default\s*\{/, 'const workerDefault = {')
  +'\n;globalThis.__freshTest={activeChipValue,validateFreshReviewContext,freshProjectedTotal,statusForFreshPlayer,enforceFreshVerdict,fallbackFreshClassification,freshContextDiff,freshCacheMinutes,unavailableFreshPlayer,freshPublisherTier,freshSourceWeight,freshNewsItemsFromHtml,freshNewsItemsFromRss,createFreshReviewJob,finalizeFreshReview,freshJobKey,freshReviewAuthorised,verifyFreshOwnerCapability,sha256Hex};';
const context={URL,Date,Map,Set,RegExp,Object,Array,String,Number,Math,JSON,console,crypto:globalThis.crypto,TextEncoder,TextDecoder,atob};
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
  const rows=new Map();
  return{rows,ROLE_KV:{
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
    {id:'official',authorityTier:1,weight:.95,signal:'negative',publisher:'Arsenal',summary:'Officially ruled out',title:'Team news',url:'https://www.arsenal.com/news/team-news'},
    {id:'rumour',authorityTier:4,weight:.2,signal:'positive',publisher:'Aggregator',summary:'Could start',title:'Predicted XI',url:'https://example.test'}
  ];
  const result=api.enforceFreshVerdict(ctx,player,evidence,{classification:'STRONG UPGRADE',status:'OPPORTUNITY',confidence:'LOW',rationale:'Weak report says he may start.',freshEvidenceSummary:'Mixed.',monitorPoint:'Team news.',evidenceIds:['rumour']});
  assert.equal(result.classification,'DOWNGRADE');
  assert.equal(result.status,'AMBER');
});

test('positive disagreement can upgrade a conservative OTB assumption',()=>{
  const ctx=validated(),player={...ctx.players.find(p=>p.name==='Wirtz'),startProbability:.52};
  const evidence=[{id:'lineup',authorityTier:1,weight:.9,signal:'positive',publisher:'Liverpool',summary:'Started final first-team preparation match',title:'Confirmed XI',url:'https://www.liverpoolfc.com/news'}];
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
  const ordinary=api.freshSourceWeight({authorityTier:2,relevantDate:new Date().toISOString(),title:'Team update',summary:''});
  const preferred=api.freshSourceWeight({authorityTier:2,relevantDate:new Date().toISOString(),title:'Team update',summary:'',preferredSource:true});
  const official=api.freshSourceWeight({authorityTier:1,relevantDate:new Date().toISOString(),title:'Official team news',summary:''});
  assert.ok(preferred>ordinary);
  assert.ok(preferred<official);
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
