const FPL_BOOTSTRAP = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const SCHEMA_VERSION = '1.2';

async function withD1(env) {
  if (!env.DB) throw new Error('D1 binding DB is missing.');

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS otb_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `).run();

  const store = {
    async get(key, type) {
      const now = Date.now();
      const row = await env.DB.prepare(`
        SELECT value, expires_at
        FROM otb_store
        WHERE key = ?
      `).bind(String(key)).first();

      if (!row) return null;

      if (row.expires_at && Number(row.expires_at) <= now) {
        await env.DB.prepare('DELETE FROM otb_store WHERE key = ?')
          .bind(String(key)).run();
        return null;
      }

      if (type === 'json') {
        try { return JSON.parse(row.value); }
        catch { return null; }
      }

      return row.value;
    },

    async put(key, value, options = {}) {
      const ttl = Number(options.expirationTtl) || 0;
      const now = Date.now();
      const expiresAt = ttl > 0 ? now + ttl * 1000 : null;

      await env.DB.prepare(`
        INSERT INTO otb_store (key, value, expires_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `).bind(String(key), String(value), expiresAt, now).run();
    }
  };

  return { ...env, ROLE_KV: store };
}


const CLUB_SOURCES = {
  ARS:{name:'Arsenal',urls:['https://www.arsenal.com/news']},
  AVL:{name:'Aston Villa',urls:['https://www.avfc.co.uk/news/']},
  BOU:{name:'Bournemouth',urls:['https://www.afcb.co.uk/news/']},
  BRE:{name:'Brentford',urls:['https://www.brentfordfc.com/en/news']},
  BHA:{name:'Brighton',urls:['https://www.brightonandhovealbion.com/pages/en/media-article/news']},
  CHE:{name:'Chelsea',urls:['https://www.chelseafc.com/en/news']},
  COV:{name:'Coventry City',urls:['https://www.ccfc.co.uk/news/']},
  CRY:{name:'Crystal Palace',urls:['https://www.cpfc.co.uk/news/']},
  EVE:{name:'Everton',urls:['https://www.evertonfc.com/news']},
  FUL:{name:'Fulham',urls:['https://www.fulhamfc.com/news']},
  HUL:{name:'Hull City',urls:['https://www.wearehullcity.co.uk/news/']},
  IPS:{name:'Ipswich Town',urls:['https://www.itfc.co.uk/news/']},
  LEE:{name:'Leeds United',urls:['https://www.leedsunited.com/en/news']},
  LIV:{name:'Liverpool',urls:['https://www.liverpoolfc.com/news']},
  MCI:{name:'Manchester City',urls:['https://www.mancity.com/news/mens']},
  MUN:{name:'Manchester United',urls:['https://www.manutd.com/en/news']},
  NEW:{name:'Newcastle United',urls:['https://www.newcastleunited.com/en/news']},
  NFO:{name:'Nottingham Forest',urls:['https://www.nottinghamforest.co.uk/news']},
  SUN:{name:'Sunderland',urls:['https://www.safc.com/news']},
  TOT:{name:'Tottenham Hotspur',urls:['https://www.tottenhamhotspur.com/news/']}
};

const TEAM_ALIASES = {
  'arsenal':'ARS','aston villa':'AVL','bournemouth':'BOU','brentford':'BRE','brighton':'BHA',
  'brighton and hove albion':'BHA','chelsea':'CHE','coventry':'COV','coventry city':'COV',
  'crystal palace':'CRY','everton':'EVE','fulham':'FUL','hull city':'HUL','ipswich':'IPS',
  'ipswich town':'IPS','leeds':'LEE','leeds united':'LEE','liverpool':'LIV','man city':'MCI',
  'manchester city':'MCI','man utd':'MUN','manchester united':'MUN','newcastle':'NEW',
  'newcastle united':'NEW','nottingham forest':'NFO','nottm forest':'NFO','sunderland':'SUN',
  'tottenham':'TOT','tottenham hotspur':'TOT','spurs':'TOT'
};

const ROLE_VALUES = new Set(['GK','CB','FB','DM','CM','AM','LW','RW','ST']);
const EVENT_VALUES = new Set(['observed_role','departure','signing','injury','return','manager_positive','manager_negative']);

function cors(env){return {
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization',
  'Cache-Control':'no-store'
}}
function json(data,status=200,env={}){return new Response(JSON.stringify(data,null,2),{status,headers:{'Content-Type':'application/json; charset=utf-8',...cors(env)}})}
function clamp(x,a,b){return Math.max(a,Math.min(b,Number(x)||0))}
function cleanText(s){return String(s||'').replace(/\s+/g,' ').trim()}
function normal(s){return cleanText(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'')}
function hashString(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(16)}
function teamCodeFromFplTeam(t){return TEAM_ALIASES[normal(t?.name)] || TEAM_ALIASES[normal(t?.short_name)] || String(t?.short_name||'').toUpperCase()}

class TextCollector {
  constructor(base){this.base=base;this.text=[];this.links=[];this.current=''}
  element(el){const href=el.getAttribute('href');if(href){try{const u=new URL(href,this.base);if(u.protocol.startsWith('http'))this.links.push(u.toString())}catch{}}}
  textChunk(t){const v=cleanText(t.text);if(v)this.text.push(v)}
}

async function fetchPage(url){
  const r=await fetch(url,{headers:{'User-Agent':'OTB-Scout-AI/1.2 (+FPL research)','Accept':'text/html,application/xhtml+xml'},redirect:'follow'});
  if(!r.ok)throw new Error(`${url} returned HTTP ${r.status}`);
  const ct=r.headers.get('content-type')||'';
  if(!ct.includes('text/html'))return {url:r.url,text:cleanText(await r.text()).slice(0,50000),links:[],mode:'fetch'};
  const c=new TextCollector(r.url);
  await new HTMLRewriter()
    .on('title,h1,h2,h3,h4,p,li,time,a', {element:e=>c.element(e),text:t=>c.textChunk(t)})
    .transform(r).text();
  return {url:r.url,text:cleanText(c.text.join(' ')).slice(0,65000),links:[...new Set(c.links)],mode:'fetch'};
}

async function quickActionJson(env,action,payload){
  if(!env.BROWSER?.quickAction)throw new Error('Browser Run quickAction binding is unavailable.');
  const response=await env.BROWSER.quickAction(action,payload);
  if(!response?.ok)throw new Error(`Browser Run ${action} returned HTTP ${response?.status||'unknown'}`);
  const data=await response.json();
  if(data?.success===false)throw new Error(data?.errors?.[0]?.message||`Browser Run ${action} failed.`);
  return data?.result ?? data;
}

async function browserLinks(env,url){
  const result=await quickActionJson(env,'links',{url,visibleLinksOnly:false,gotoOptions:{waitUntil:'networkidle0',timeout:20000}});
  return Array.isArray(result)?result:[];
}

async function browserMarkdown(env,url){
  const result=await quickActionJson(env,'markdown',{url,gotoOptions:{waitUntil:'networkidle0',timeout:20000}});
  const markdown=typeof result==='string'?result:(result?.markdown||result?.content||'');
  return {url,text:cleanText(markdown).slice(0,65000),links:[],mode:'browser-markdown'};
}

async function discoverLanding(env,url){
  const landing=await fetchPage(url);
  let links=landing.links;
  let mode='fetch';
  if(links.length<4&&env.BROWSER?.quickAction){
    try{
      const rendered=await browserLinks(env,url);
      if(rendered.length){links=[...new Set([...links,...rendered])];mode='browser-links'}
    }catch(e){landing.browserError=e.message}
  }
  return {...landing,links,mode};
}

async function fetchArticle(env,url){
  try{
    const page=await fetchPage(url);
    if(page.text.length>=900)return page;
  }catch(e){
    if(!env.BROWSER?.quickAction)throw e;
  }
  if(env.BROWSER?.quickAction)return browserMarkdown(env,url);
  throw new Error(`${url} did not expose enough readable article text.`);
}

function likelyArticleLinks(base,links,limit){
  const host=new URL(base).hostname.replace(/^www\./,'');
  const currentYear=new Date().getUTCFullYear();
  const scored=links.map((url,index)=>{let score=0;try{
    const u=new URL(url);if(u.hostname.replace(/^www\./,'')!==host)return {url,score:-99};
    const p=decodeURIComponent(u.pathname).toLowerCase();
    if(/\/news\//.test(p))score+=7;
    if(/article|story|press|interview|team-news|transfer|sign|pre-season|preseason|friendly|match-report|line-up|lineup/.test(p))score+=5;
    if(new RegExp(`/${currentYear}/`).test(p))score+=5;
    if(new RegExp(`/${currentYear-1}/`).test(p))score-=2;
    const depth=p.split('/').filter(Boolean).length;if(depth>=4)score+=2;
    if(/privacy|ticket|shop|account|login|video|gallery|women|academy|hospitality|commercial|foundation/.test(p))score-=5;
    if(p==='/'||/\/news\/?$/.test(p))score-=6;
  }catch{score=-99}return{url,score,index}})
    .filter(x=>x.score>1).sort((a,b)=>b.score-a.score||a.index-b.index);
  return [...new Set(scored.map(x=>x.url))].slice(0,limit);
}

async function fplContext(env,team){
  const r=await fetch(FPL_BOOTSTRAP,{headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`FPL bootstrap HTTP ${r.status}`);
  const data=await r.json();const teamRow=(data.teams||[]).find(t=>teamCodeFromFplTeam(t)===team);
  if(!teamRow)throw new Error(`Club ${team} is not present in the current FPL bootstrap.`);
  const pos=Object.fromEntries((data.element_types||[]).map(x=>[x.id,x.singular_name_short]));
  const players=(data.elements||[]).filter(p=>p.team===teamRow.id).map(p=>({id:p.id,name:p.web_name,fullName:`${p.first_name||''} ${p.second_name||''}`.trim(),fplPosition:pos[p.element_type]||'',status:p.status,chance:p.chance_of_playing_next_round,news:p.news||'',price:(p.now_cost||0)/10,minutes:p.minutes||0,starts:p.starts||0}));
  const key=`roster:${team}`;let previous=null;try{previous=JSON.parse(await env.ROLE_KV.get(key)||'null')}catch{}
  const current={team,teamName:teamRow.name,fetchedAt:new Date().toISOString(),players};
  await env.ROLE_KV.put(key,JSON.stringify(current),{expirationTtl:60*60*24*120});
  const oldNames=new Set((previous?.players||[]).map(p=>normal(p.fullName||p.name))),newNames=new Set(players.map(p=>normal(p.fullName||p.name)));
  return {current,previous,added:players.filter(p=>!oldNames.has(normal(p.fullName||p.name))),missing:(previous?.players||[]).filter(p=>!newNames.has(normal(p.fullName||p.name)))};
}

function extractionSchema(){return {
  type:'object',additionalProperties:false,required:['events'],properties:{events:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,
    required:['type','subject','affected','role','overlap','hierarchy','confidence','source','reason'],properties:{
      type:{type:'string',enum:[...EVENT_VALUES]},subject:{type:'string'},affected:{type:'string'},role:{type:'string',enum:[...ROLE_VALUES]},
      overlap:{type:'number',minimum:0,maximum:1},hierarchy:{type:'number',minimum:0,maximum:1},confidence:{type:'number',minimum:0,maximum:1},
      source:{type:'string'},reason:{type:'string'},evidenceDate:{type:'string'}
    }}}}
}}

async function aiExtract(env,team,clubName,players,documents,rosterDelta){
  const playerList=players.map(p=>`${p.name} [${p.fplPosition}]`).join(', ');
  const docs=documents.map((d,i)=>`SOURCE ${i+1}: ${d.url}\n${d.text.slice(0,12000)}`).join('\n\n');
  const prompt=`You are the OTB football role-intelligence extractor. Analyse only the supplied official-club text and FPL roster evidence for ${clubName} (${team}).
Return only current, source-grounded structured events that can materially change EXPECTED MINUTES for players registered in FPL.

CURRENT FPL PLAYERS: ${playerList}
ROSTER ADDED: ${rosterDelta.added.map(p=>p.name).join(', ')||'none'}
ROSTER MISSING SINCE LAST SNAPSHOT: ${rosterDelta.missing.map(p=>p.name).join(', ')||'none'}

RULES:
- Use observed_role when a named CURRENT FPL player is explicitly reported, quoted, or shown in a lineup as starting/playing in a tactical role, including out-of-position use. Repeated recent lineup evidence should be stronger than a single mention.
- Use departure/signing/injury/return for a competitor event and name the FPL player(s) whose minutes are likely affected.
- Use manager_positive/manager_negative only for direct role/minutes language.
- affected MUST exactly match one CURRENT FPL player name from the list.
- role is the football role involved, not the FPL position.
- Do not infer a transfer from roster absence alone. Roster absence is unresolved unless official text confirms it.
- Ignore vague rumours, fan opinion, historical stories, academy-only evidence, unrelated teams, and material older than 120 days unless it confirms a still-current transfer or injury status.
- A player's FPL position is not his football role. A DEF may legitimately be observed at RW, LW, AM or ST.
- For departure/injury events, affected is the beneficiary. For signing/return events, affected is the threatened incumbent. Do not apply an injury event to the injured player himself.
- Confirmed official statements: confidence 0.9-1.0. Repeated official preseason lineup evidence: 0.70-0.90. One ambiguous mention: <=0.55.
- overlap measures direct role competition. hierarchy measures expected selection strength of subject/role evidence.
- Include a concise reason citing the concrete evidence (for example: started two consecutive friendlies at RW, manager named him first choice, competitor signed). Include the exact source URL and an ISO evidenceDate when available.
- Return no event when evidence is insufficient.

OFFICIAL MATERIAL:\n${docs}`;
  const result=await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast',{
    messages:[{role:'system',content:'Extract conservative, source-grounded Premier League team-role events as JSON. Never invent facts.'},{role:'user',content:prompt}],
    response_format:{type:'json_schema',json_schema:{name:'otb_role_events',strict:true,schema:extractionSchema()}},
    temperature:0
  });
  let out=result?.response ?? result;
  if(typeof out==='string')out=JSON.parse(out);
  return Array.isArray(out?.events)?out.events:[];
}

function validateEvents(team,players,events){
  const byName=new Map;for(const p of players){byName.set(normal(p.name),p);byName.set(normal(p.fullName),p)}const out=[];
  for(const e of events||[]){const p=byName.get(normal(e.affected));if(!p||!EVENT_VALUES.has(e.type)||!ROLE_VALUES.has(e.role))continue;
    const source=String(e.source||'');if(!/^https?:\/\//i.test(source))continue;
    if(e.type==='injury'&&normal(e.subject)===normal(p.name))continue;
    const evidenceTime=Date.parse(e.evidenceDate||'');if(Number.isFinite(evidenceTime)&&Date.now()-evidenceTime>120*86400000&&!['departure','signing'].includes(e.type))continue;
    out.push({id:`auto-${hashString([team,e.type,e.subject,p.name,e.role,source,e.evidenceDate].join('|'))}`,createdAt:Date.now(),team,type:e.type,subject:cleanText(e.subject).slice(0,120),role:e.role,affected:p.name,affectedApiId:p.id,overlap:clamp(e.overlap,0,1),hierarchy:clamp(e.hierarchy,0,1),confidence:clamp(e.confidence,0,1),source,reason:cleanText(e.reason).slice(0,320),evidenceDate:cleanText(e.evidenceDate).slice(0,40),auto:true,worker:true,oop:(p.fplPosition==='DEF'&&['LW','RW','AM','ST'].includes(e.role))||(p.fplPosition==='MID'&&['FB','CB'].includes(e.role))});
  }
  const seen=new Set;return out.filter(e=>{const k=[e.type,normal(e.subject),normal(e.affected),e.role,e.source].join('|');if(seen.has(k))return false;seen.add(k);return true});
}

async function scanTeam(env,team,{force=false}={}){
  team=String(team||'').toUpperCase();const club=CLUB_SOURCES[team];if(!club)throw new Error(`Unsupported team code: ${team}`);
  const cacheKey=`latest:${team}`;
  if(!force){
    const cached=await env.ROLE_KV.get(cacheKey,'json');
    if(cached)return {...cached,cache:'HIT'};
  }
  const roster=await fplContext(env,team);const max=Math.max(3,Math.min(12,Number(env.MAX_ARTICLES_PER_SCAN)||8));const documents=[];const errors=[];const discovery=[];
  for(const source of club.urls){try{
    const landing=await discoverLanding(env,source);
    discovery.push({source:landing.url,mode:landing.mode,linksFound:landing.links.length,browserError:landing.browserError||null});
    documents.push({url:landing.url,text:landing.text.slice(0,16000),mode:landing.mode});
    const links=likelyArticleLinks(landing.url,landing.links,max);
    for(const url of links){try{documents.push(await fetchArticle(env,url))}catch(e){errors.push(e.message)}}
  }catch(e){errors.push(e.message)}}
  const useful=documents.filter(d=>d.text&&d.text.length>=250);
  const raw=useful.length?await aiExtract(env,team,club.name,roster.current.players,useful,roster):[];
  const events=validateEvents(team,roster.current.players,raw);
  const payload={status:'ok',schemaVersion:SCHEMA_VERSION,season:env.SEASON||'2026/27',team,club:club.name,generatedAt:new Date().toISOString(),cache:'MISS',sourcesScanned:useful.map(d=>d.url),sourceErrors:errors.slice(0,10),diagnostics:{discovery,documentsRead:useful.length,browserFallbackUsed:useful.some(d=>String(d.mode||'').startsWith('browser')),rawEvents:Array.isArray(raw)?raw.length:0,acceptedEvents:events.length},roster:{players:roster.current.players.length,added:roster.added.map(p=>p.name),missingUnresolved:roster.missing.map(p=>p.name)},events};
  await env.ROLE_KV.put(cacheKey,JSON.stringify(payload),{expirationTtl:60*60*24*14});return payload;
}

async function allLatest(env){const out={};for(const team of Object.keys(CLUB_SOURCES)){const x=await env.ROLE_KV.get(`latest:${team}`,'json');if(x)out[team]=x}return out}

function reportAgeMs(report){
  const t=Date.parse(report?.generatedAt||'');
  return Number.isFinite(t)?Math.max(0,Date.now()-t):Infinity;
}

async function cacheFirstTeamReport(env,team,ctx,{force=false}={}){
  team=String(team||'').toUpperCase();
  if(force)return scanTeam(env,team,{force:true});

  const cached=await env.ROLE_KV.get(`latest:${team}`,'json');
  if(!cached)return scanTeam(env,team,{force:true});

  const staleAfterMs=Math.max(15,Number(env.STALE_AFTER_MINUTES)||360)*60*1000;
  const stale=reportAgeMs(cached)>staleAfterMs;
  if(stale&&ctx?.waitUntil){
    ctx.waitUntil(scanTeam(env,team,{force:true}).catch(async error=>{
      await env.ROLE_KV.put(`error:${team}`,JSON.stringify({at:new Date().toISOString(),error:error?.message||String(error)}),{expirationTtl:86400});
    }));
  }
  return {...cached,cache:'HIT',stale,refreshing:stale};
}

export default {
  async fetch(request,env,ctx){
    env = await withD1(env);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors(env)});
    const u=new URL(request.url);try{
      if(u.pathname==='/'||u.pathname==='/api/health')return json({status:'ok',service:'OTB Role Intelligence',schemaVersion:SCHEMA_VERSION,season:env.SEASON||'2026/27',teams:Object.keys(CLUB_SOURCES).length,generatedAt:new Date().toISOString()},200,env);
      if(u.pathname==='/api/role-intelligence'||u.pathname.startsWith('/api/scout/team/')){
        const pathTeam=u.pathname.startsWith('/api/scout/team/')?u.pathname.split('/').filter(Boolean).pop():null;
        const team=u.searchParams.get('team')||pathTeam;if(!team)return json({error:'team is required'},400,env);
        const force=u.searchParams.get('force')==='1'||u.searchParams.get('fresh')==='1';
        return json(await cacheFirstTeamReport(env,team,ctx,{force}),200,env);
      }
      if(u.pathname==='/api/role-sync'&&request.method==='POST'){
        const body=await request.json().catch(()=>({}));if(!body.team)return json({error:'team is required'},400,env);
        return json(await scanTeam(env,body.team,{force:true}),200,env);
      }
      if(u.pathname==='/api/role-latest')return json({status:'ok',generatedAt:new Date().toISOString(),teams:await allLatest(env)},200,env);
      if(u.pathname==='/api/scout/diagnostics'){
        const team=String(u.searchParams.get('team')||'').toUpperCase();if(!team)return json({error:'team is required'},400,env);
        const report=await env.ROLE_KV.get(`latest:${team}`,'json');return json({status:'ok',team,report:report||null},200,env);
      }
      return json({error:'not found'},404,env);
    }catch(e){return json({status:'error',error:e?.message||String(e),generatedAt:new Date().toISOString()},500,env)}
  },
  async scheduled(event,env,ctx){
    env = await withD1(env);
    ctx.waitUntil((async()=>{const teams=Object.keys(CLUB_SOURCES),key='cron:cursor',cursor=Number(await env.ROLE_KV.get(key)||0),count=Math.max(1,Math.min(4,Number(env.CRON_TEAMS_PER_RUN)||2));for(let i=0;i<count;i++){const team=teams[(cursor+i)%teams.length];try{await scanTeam(env,team,{force:true})}catch(e){await env.ROLE_KV.put(`error:${team}`,JSON.stringify({at:new Date().toISOString(),error:e.message}),{expirationTtl:86400})}}await env.ROLE_KV.put(key,String((cursor+count)%teams.length));})());
  }
};
