import base, { FreshReviewWorkflow } from './worker.js';
import { TEAM_CODES, normaliseTeams, reportTimestampMs, freshnessState, refreshBudget, selectRefreshTeams } from './src/role-freshness-core.js';

export { FreshReviewWorkflow };

const VERSION='role-freshness-v1';
const PREFIX='role-freshness:';
const FPL_BOOTSTRAP='https://fantasy.premierleague.com/api/bootstrap-static/';
let STORE_READY=false;

function json(body,status=200,request=null,env={}){
  const origin=request?.headers?.get?.('origin')||'';
  const allowed=String(env.ALLOWED_ORIGIN||'https://blackpharoahisking-gif.github.io');
  const cors=!origin||origin===allowed?{'access-control-allow-origin':origin||'*'}:{};
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'content-type',...cors}});
}
function originAllowed(request,env){const origin=String(request.headers.get('origin')||'');return !origin||origin===String(env.ALLOWED_ORIGIN||'https://blackpharoahisking-gif.github.io')}
async function ensureStore(env){
  if(STORE_READY)return;
  if(!env.DB)throw new Error('D1 binding DB is missing.');
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS otb_store (key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER,updated_at INTEGER NOT NULL)`).run();
  STORE_READY=true;
}
async function storeGet(env,key){
  await ensureStore(env);const now=Date.now();
  const row=await env.DB.prepare('SELECT value,expires_at,updated_at FROM otb_store WHERE key=?').bind(String(key)).first();
  if(!row)return null;if(row.expires_at&&Number(row.expires_at)<=now){await env.DB.prepare('DELETE FROM otb_store WHERE key=?').bind(String(key)).run();return null}
  try{return {...JSON.parse(row.value),__updatedAt:Number(row.updated_at)||0}}catch{return {value:row.value,__updatedAt:Number(row.updated_at)||0}}
}
async function storePut(env,key,value,ttlSec=0){
  await ensureStore(env);const now=Date.now(),expires=ttlSec>0?now+ttlSec*1000:null;
  await env.DB.prepare(`INSERT INTO otb_store(key,value,expires_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at,updated_at=excluded.updated_at`).bind(String(key),JSON.stringify(value),expires,now).run();
}
async function storeDelete(env,key){await ensureStore(env);await env.DB.prepare('DELETE FROM otb_store WHERE key=?').bind(String(key)).run()}
async function latestReports(env){
  await ensureStore(env);const rows=await env.DB.prepare("SELECT key,value,updated_at FROM otb_store WHERE key>='latest:' AND key<'latest;' ").all(),out={};
  for(const row of rows.results||[]){const team=String(row.key||'').slice(7).toUpperCase();if(!TEAM_CODES.includes(team))continue;try{out[team]={report:JSON.parse(row.value),storeUpdatedAt:Number(row.updated_at)||0}}catch{}}
  return out;
}
async function priorityRows(env){
  await ensureStore(env);const lo=PREFIX+'priority:',hi=PREFIX+'priority;';
  const rows=await env.DB.prepare('SELECT key,value,expires_at,updated_at FROM otb_store WHERE key>=? AND key<?').bind(lo,hi).all(),out={};
  for(const row of rows.results||[]){if(row.expires_at&&Number(row.expires_at)<=Date.now()){await storeDelete(env,row.key);continue}const team=String(row.key).slice(lo.length).toUpperCase();try{out[team]={...JSON.parse(row.value),__updatedAt:Number(row.updated_at)||0}}catch{}}
  return out;
}
function newestEventMs(payload){let best=null;for(const e of payload?.events||payload?.current||[]){const ms=Date.parse(e?.evidenceDate||e?.detectedAt||e?.generatedAt||'');if(Number.isFinite(ms)&&(best==null||ms>best))best=ms}return best}
async function clubNewsMs(env,ctx,team){
  try{const req=new Request(`https://internal.invalid/api/scout/club-events?team=${encodeURIComponent(team)}&mode=current`,{headers:{Accept:'application/json'}}),res=await base.fetch(req,env,ctx),body=await res.json().catch(()=>null);return res.ok?newestEventMs(body):null}catch{return null}
}
async function nextDeadline(env){
  try{
    const res=await fetch(FPL_BOOTSTRAP,{headers:{Accept:'application/json'},cf:{cacheTtl:300,cacheEverything:true}});if(!res.ok)throw new Error(`FPL ${res.status}`);const body=await res.json(),now=Date.now();
    const deadlines=(body.events||[]).map(e=>({gw:Number(e.id),ms:Date.parse(e.deadline_time||'')})).filter(x=>Number.isFinite(x.ms)&&x.ms>now).sort((a,b)=>a.ms-b.ms);if(!deadlines.length)return null;
    return{gw:deadlines[0].gw,deadlineAt:new Date(deadlines[0].ms).toISOString(),deadlineMinutes:(deadlines[0].ms-now)/60000,checkedAt:new Date(now).toISOString()};
  }catch{return null}
}
async function buildStatus(env,ctx,{withNews=false}={}){
  const [reports,priorities,deadline]=await Promise.all([latestReports(env),priorityRows(env),storeGet(env,PREFIX+'deadline:v1')]);
  const now=Date.now(),deadlineMinutes=Number.isFinite(Number(deadline?.deadlineMinutes))?Number(deadline.deadlineMinutes):null,rows=[];
  const newsTimes=withNews?Object.fromEntries(await Promise.all(TEAM_CODES.map(async t=>[t,await clubNewsMs(env,ctx,t)]))):{};
  for(const team of TEAM_CODES){
    const rec=reports[team],report=rec?.report||null,reportMs=reportTimestampMs(report)??rec?.storeUpdatedAt??null,ageMinutes=Number.isFinite(reportMs)?Math.max(0,(now-reportMs)/60000):null,queued=priorities[team]||null;
    if(queued&&Number.isFinite(reportMs)&&reportMs>=Number(queued.requestedAt||Infinity)){await storeDelete(env,PREFIX+'priority:'+team)}
    const newsMs=withNews?newsTimes[team]:null,newsAfterReport=Number.isFinite(newsMs)&&(!Number.isFinite(reportMs)||newsMs>reportMs+60000),state=freshnessState(ageMinutes,{deadlineMinutes});
    rows.push({team,reportAt:Number.isFinite(reportMs)?new Date(reportMs).toISOString():null,ageMinutes:ageMinutes==null?null:Math.round(ageMinutes),state,missing:!report,priority:Number(queued?.priority)||0,requestedAt:Number(queued?.requestedAt)||0,reason:queued?.reason||null,newsAfterReport,latestNewsAt:Number.isFinite(newsMs)?new Date(newsMs).toISOString():null,scanEligible:!!queued||newsAfterReport||state!=='fresh'});
  }
  return{rows,deadlineMinutes};
}
async function queueTeams(env,teams,{reason='app',priority=1}={}){
  const now=Date.now(),p=Math.max(1,Math.min(9,Math.trunc(Number(priority)||1)));
  for(const team of normaliseTeams(teams)){const key=PREFIX+'priority:'+team,prev=await storeGet(env,key),value={team,reason:String(reason||'app').slice(0,80),priority:Math.max(p,Number(prev?.priority)||0),requestedAt:prev?.requestedAt||now,lastRequestedAt:now};await storePut(env,key,value,2*60*60)}
}
async function kickTeam(env,ctx,team,{reason='scheduled'}={}){
  const guardKey=PREFIX+'kick:'+team,guard=await storeGet(env,guardKey),now=Date.now();
  if(guard&&now-Number(guard.at||0)<10*60000)return{team,status:'suppressed',reason:'recent kick'};
  await storePut(env,guardKey,{at:now,reason},20*60);
  const headers={Accept:'application/json'};if(env.SCOUT_ADMIN_TOKEN)headers['x-otb-token']=String(env.SCOUT_ADMIN_TOKEN);
  const req=new Request(`https://internal.invalid/api/role-intelligence?team=${encodeURIComponent(team)}&force=1`,{headers});
  try{const res=await base.fetch(req,env,ctx),body=await res.json().catch(()=>({})),row={team,status:res.ok?'requested':'error',http:res.status,scanExecuted:body?.scanExecuted===true,refreshing:body?.refreshing===true,scanLocked:body?.scanLocked===true,forceThrottled:body?.forceThrottled===true,reason,at:new Date().toISOString()};await storePut(env,PREFIX+'last:'+team,row,24*60*60);return row}
  catch(error){const row={team,status:'error',reason,error:error?.message||String(error),at:new Date().toISOString()};await storePut(env,PREFIX+'last:'+team,row,24*60*60);return row}
}
async function processRefreshes(env,ctx,{withNews=false,budget=null,reason='scheduled'}={}){
  const status=await buildStatus(env,ctx,{withNews}),limit=budget==null?refreshBudget(status.deadlineMinutes):Math.max(0,Math.trunc(budget)),teams=selectRefreshTeams(status.rows,{budget:limit});
  const results=[];for(const team of teams)results.push(await kickTeam(env,ctx,team,{reason:status.rows.find(r=>r.team===team)?.newsAfterReport?'news-change':reason}));
  await storePut(env,PREFIX+'last-run:v1',{at:new Date().toISOString(),reason,budget:limit,selected:teams,results,deadlineMinutes:status.deadlineMinutes},24*60*60);
  return{teams,results,deadlineMinutes:status.deadlineMinutes};
}
async function publicStatus(env,ctx,teams){
  const requested=normaliseTeams(teams);const status=await buildStatus(env,ctx,{withNews:false}),rows=requested.length?status.rows.filter(r=>requested.includes(r.team)):status.rows;
  return{status:'ok',version:VERSION,generatedAt:new Date().toISOString(),deadlineMinutes:status.deadlineMinutes,requested:rows.length,teams:Object.fromEntries(rows.map(r=>[r.team,r]))};
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(request.method==='OPTIONS'&&url.pathname.startsWith('/api/role-freshness'))return json({status:'ok'},204,request,env);
    if(url.pathname==='/api/role-freshness/status'){
      if(!originAllowed(request,env))return json({status:'error',error:'origin not allowed'},403,request,env);
      return json(await publicStatus(env,ctx,url.searchParams.get('teams')||''),200,request,env);
    }
    if(url.pathname==='/api/role-freshness/request'){
      if(request.method!=='POST')return json({status:'error',error:'use POST'},405,request,env);
      if(!originAllowed(request,env))return json({status:'error',error:'origin not allowed'},403,request,env);
      const body=await request.json().catch(()=>({})),teams=normaliseTeams(body.teams);if(!teams.length)return json({status:'error',error:'at least one supported team is required'},400,request,env);
      const reason=String(body.reason||'app').slice(0,80),priority=Math.max(1,Math.min(9,Math.trunc(Number(body.priority)||1)));await queueTeams(env,teams,{reason,priority});
      const deadline=await storeGet(env,PREFIX+'deadline:v1'),deadlineMinutes=Number(deadline?.deadlineMinutes),immediate=Number.isFinite(deadlineMinutes)&&deadlineMinutes>=0&&deadlineMinutes<=90?3:2;
      ctx.waitUntil(processRefreshes(env,ctx,{withNews:false,budget:immediate,reason:`request:${reason}`}));
      return json({status:'accepted',version:VERSION,teams,reason,priority,immediateBudget:immediate},202,request,env);
    }
    if(url.pathname==='/'||url.pathname==='/api/health'){
      const response=await base.fetch(request,env,ctx);try{const body=await response.clone().json();if(response.ok&&body&&typeof body==='object')return json({...body,roleFreshness:{version:VERSION,mode:'background-priority+news+deadline',statusEndpoint:'/api/role-freshness/status',requestEndpoint:'/api/role-freshness/request'}},response.status,request,env)}catch{}return response;
    }
    return base.fetch(request,env,ctx);
  },
  async scheduled(event,env,ctx){
    if(typeof base.scheduled==='function')await base.scheduled(event,env,ctx);
    ctx.waitUntil((async()=>{
      const deadline=await nextDeadline(env);if(deadline)await storePut(env,PREFIX+'deadline:v1',deadline,6*60*60);
      await processRefreshes(env,ctx,{withNews:true,reason:'cron-freshness'});
    })());
  }
};
