// OTB Role Intelligence Worker
// v1.3 — article-discovery repair + per-URL diagnostics
//
// Changes vs v1.2 (all additive to the response contract):
//   1. Browser fallback is gated on ARTICLE CANDIDATES and landing text length,
//      not on raw anchor count (the v1.2 `links.length < 4` gate).
//   2. A relaxed second scoring pass runs when the strict pass yields zero
//      candidates, so a scan can never silently do nothing.
//   3. Every candidate URL gets an explicit per-URL diagnostic status.
//   4. Counters are split: linksFound / candidates / attempted /
//      documentsRead / documentsUsed.
//   5. Browser Run results are normalised (the /links action may return
//      objects rather than bare URL strings).
//   6. Browser calls and total scan time are budgeted so force=1 cannot hang.

const FPL_BOOTSTRAP = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const SCHEMA_VERSION = '1.3';

const AI_MIN_DOC_CHARS = 250;      // doc must have this much text to reach the model
const ARTICLE_MIN_CHARS = 900;     // below this, try the browser for a fuller body
const LANDING_MIN_CHARS = 800;     // below this, the landing page is a JS shell
const DEFAULT_BROWSER_BUDGET = 5;  // max Browser Run calls per scan
const DEFAULT_SCAN_BUDGET_MS = 45000;

/* ---------------------------------------------------------------- storage */

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

/* ------------------------------------------------------------ club config */

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

/* --------------------------------------------------------------- helpers */

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
function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,'')}catch{return ''}}

/** Budget guard so a forced scan cannot run past the user's patience. */
function makeBudget(env){
  const started=Date.now();
  const deadline=started+Math.max(10000,Number(env.SCAN_BUDGET_MS)||DEFAULT_SCAN_BUDGET_MS);
  let browserCalls=0;
  const browserMax=Math.max(0,Number(env.BROWSER_BUDGET ?? DEFAULT_BROWSER_BUDGET));
  return {
    expired(){return Date.now()>=deadline},
    canBrowse(env2){return !!env2?.BROWSER?.quickAction && browserCalls<browserMax && !this.expired()},
    spendBrowser(){browserCalls++},
    get browserCalls(){return browserCalls},
    get elapsedMs(){return Date.now()-started}
  };
}

/* ------------------------------------------------------------ page reading */

class TextCollector {
  constructor(base){this.base=base;this.text=[];this.links=[];this.current=''}
  element(el){const href=el.getAttribute('href');if(href){try{const u=new URL(href,this.base);if(u.protocol.startsWith('http')){u.hash='';this.links.push(u.toString())}}catch{}}}
  textChunk(t){const v=cleanText(t.text);if(v)this.text.push(v)}
}

async function parseHtmlResponse(response,baseUrl){
  const c=new TextCollector(baseUrl);
  await new HTMLRewriter()
    .on('title,h1,h2,h3,h4,p,li,time,a', {element:e=>c.element(e),text:t=>c.textChunk(t)})
    .transform(response).text();
  return {text:cleanText(c.text.join(' ')).slice(0,65000),links:[...new Set(c.links)]};
}

async function fetchPage(url){
  let r;
  try{
    r=await fetch(url,{
      headers:{
        'User-Agent':'OTB-Scout-AI/1.3 (+FPL research; contact via otb-role-intelligence.workers.dev)',
        'Accept':'text/html,application/xhtml+xml',
        'Accept-Language':'en-GB,en;q=0.9'
      },
      redirect:'follow'
    });
  }catch(e){
    const err=new Error(`network error: ${e?.message||String(e)}`);
    err.kind='network';err.url=url;throw err;
  }
  if(!r.ok){
    const err=new Error(`HTTP ${r.status}`);
    err.kind=r.status===403||r.status===429?'blocked':'http';
    err.status=r.status;err.url=url;throw err;
  }
  const ct=(r.headers.get('content-type')||'').toLowerCase();
  if(!ct.includes('html')){
    const err=new Error(`unsupported content-type: ${ct||'unknown'}`);
    err.kind='content-type';err.url=r.url;throw err;
  }
  const parsed=await parseHtmlResponse(r,r.url);
  return {url:r.url,text:parsed.text,links:parsed.links,mode:'fetch',status:r.status,redirected:r.url!==url};
}

/* ------------------------------------------------------------ Browser Run */

async function quickActionJson(env,action,payload){
  if(!env.BROWSER?.quickAction)throw new Error('Browser Run quickAction binding is unavailable.');
  const response=await env.BROWSER.quickAction(action,payload);
  // quickAction resolves to a Response.
  if(response && typeof response.json==='function'){
    if(!response.ok)throw new Error(`Browser Run ${action} returned HTTP ${response.status||'unknown'}`);
    const data=await response.json();
    if(data?.success===false)throw new Error(data?.errors?.[0]?.message||`Browser Run ${action} failed.`);
    return data?.result ?? data;
  }
  // Defensive: tolerate a plain object if the binding shape ever changes.
  if(response?.success===false)throw new Error(response?.errors?.[0]?.message||`Browser Run ${action} failed.`);
  return response?.result ?? response;
}

const GOTO = {waitUntil:'networkidle2',timeout:15000};

/** /links may return strings or objects ({url}|{href}); normalise to strings. */
function normaliseLinks(result,base){
  const raw=Array.isArray(result)?result:(Array.isArray(result?.links)?result.links:[]);
  const out=[];
  for(const item of raw){
    const candidate=typeof item==='string'?item:(item?.url||item?.href||item?.link||'');
    if(!candidate)continue;
    try{const u=new URL(candidate,base);if(u.protocol.startsWith('http')){u.hash='';out.push(u.toString())}}catch{}
  }
  return [...new Set(out)];
}

/**
 * One browser call that yields BOTH rendered text and rendered links.
 * v1.2 used /links for discovery and /markdown for articles, which meant a
 * JS-rendered landing page could gain links but never gain text.
 */
async function browserRender(env,url,budget){
  budget.spendBrowser();
  const html=await quickActionJson(env,'content',{url,gotoOptions:GOTO});
  const markup=typeof html==='string'?html:(html?.content||html?.html||'');
  if(!markup)throw new Error('Browser Run content returned no markup.');
  const response=new Response(markup,{headers:{'content-type':'text/html; charset=utf-8'}});
  const parsed=await parseHtmlResponse(response,url);
  return {url,text:parsed.text,links:parsed.links,mode:'browser-content',status:200,redirected:false};
}

async function browserMarkdown(env,url,budget){
  budget.spendBrowser();
  const result=await quickActionJson(env,'markdown',{url,gotoOptions:GOTO});
  const markdown=typeof result==='string'?result:(result?.markdown||result?.content||'');
  return {url,text:cleanText(markdown).slice(0,65000),links:[],mode:'browser-markdown',status:200,redirected:false};
}

/* ----------------------------------------------------- link candidate scoring */

function scoreLink(url,host,currentYear){
  let score=0;
  let u;
  try{u=new URL(url)}catch{return {score:-99,reason:'unparseable'}}
  if(u.hostname.replace(/^www\./,'')!==host)return {score:-99,reason:'off-host'};
  const p=decodeURIComponent(u.pathname).toLowerCase();
  if(/\/news\//.test(p))score+=7;
  if(/article|story|press|interview|team-news|transfer|sign|pre-season|preseason|friendly|match-report|line-up|lineup|squad|injury|contract|loan/.test(p))score+=5;
  if(new RegExp(`/${currentYear}/`).test(p))score+=5;
  if(new RegExp(`/${currentYear-1}/`).test(p))score-=2;
  const depth=p.split('/').filter(Boolean).length;
  if(depth>=4)score+=2;
  if(depth>=2)score+=1;
  if(/privacy|cookie|terms|ticket|shop|store|account|login|register|video|gallery|women|academy|hospitality|commercial|foundation|sitemap|contact/.test(p))score-=6;
  if(p==='/'||/\/news\/?$/.test(p))score-=8;
  return {score,reason:score>1?'candidate':'low-score',depth};
}

/**
 * Strict pass first. If it returns nothing, a relaxed pass admits any
 * same-host link with real path depth that is not obviously utility chrome.
 * A scan that finds links must never end with zero attempts and no diagnostic.
 */
function selectArticleLinks(base,links,limit){
  const host=hostOf(base);
  const currentYear=new Date().getUTCFullYear();
  const scored=links.map((url,index)=>({url,index,...scoreLink(url,host,currentYear)}));

  const strict=scored.filter(x=>x.score>1)
    .sort((a,b)=>b.score-a.score||a.index-b.index);

  let selected=strict;
  let pass='strict';
  if(!selected.length){
    selected=scored.filter(x=>x.score>-99&&(x.depth||0)>=2&&x.score>-6)
      .sort((a,b)=>b.score-a.score||a.index-b.index);
    pass='relaxed';
  }

  const seen=new Set();
  const chosen=[];
  for(const x of selected){
    if(seen.has(x.url))continue;
    seen.add(x.url);
    chosen.push(x.url);
    if(chosen.length>=limit)break;
  }
  const rejected=scored
    .filter(x=>!seen.has(x.url))
    .map(x=>({url:x.url,status:x.reason==='off-host'?'rejected-off-host':'rejected-low-score',score:x.score}));

  return {candidates:chosen,rejected,pass,scoredCount:scored.length};
}

/* --------------------------------------------------------------- discovery */

async function discoverLanding(env,url,budget){
  const record={source:url,mode:'fetch',linksFound:0,textChars:0,browserUsed:false,browserError:null,fetchError:null};
  let landing=null;

  try{
    landing=await fetchPage(url);
    record.mode=landing.mode;
    record.linksFound=landing.links.length;
    record.textChars=landing.text.length;
    record.source=landing.url;
  }catch(e){
    record.fetchError=`${e.kind||'error'}: ${e.message}`;
  }

  const host=hostOf(landing?.url||url);
  const year=new Date().getUTCFullYear();
  const candidateCount=(landing?.links||[]).filter(l=>scoreLink(l,host,year).score>1).length;
  record.candidatesFromFetch=candidateCount;

  // THE v1.2 DEFECT: this gate was `links.length < 4`. Six nav links cleared it
  // on a JS-rendered shell, so the browser was never tried and no article
  // candidates ever existed.
  const needsBrowser = !landing
    || candidateCount===0
    || landing.text.length<LANDING_MIN_CHARS;

  if(needsBrowser){
    if(budget.canBrowse(env)){
      try{
        const rendered=await browserRender(env,landing?.url||url,budget);
        record.browserUsed=true;
        record.mode=rendered.mode;
        landing={
          url:rendered.url,
          text:rendered.text.length>=(landing?.text.length||0)?rendered.text:landing.text,
          links:[...new Set([...(landing?.links||[]),...rendered.links])],
          mode:rendered.mode,
          status:200,
          redirected:false
        };
        record.linksFound=landing.links.length;
        record.textChars=landing.text.length;
      }catch(e){
        record.browserError=e?.message||String(e);
      }
    }else{
      record.browserError=env.BROWSER?.quickAction
        ? 'browser budget exhausted'
        : 'Browser Run binding unavailable';
    }
  }

  if(!landing)return {landing:null,record};
  return {landing,record};
}

/* ---------------------------------------------------------- article reading */

async function readArticle(env,url,budget){
  const entry={url,status:'pending',mode:null,chars:0,httpStatus:null,error:null,browserUsed:false};
  let page=null;

  try{
    page=await fetchPage(url);
    entry.httpStatus=page.status;
    entry.mode=page.mode;
    entry.chars=page.text.length;
    if(page.text.length>=ARTICLE_MIN_CHARS){
      entry.status='accepted';
      return {doc:page,entry};
    }
    entry.status='thin';
  }catch(e){
    entry.error=`${e.kind||'error'}: ${e.message}`;
    entry.httpStatus=e.status??null;
    entry.status=e.kind==='blocked'?'blocked':'fetch-error';
  }

  if(budget.canBrowse(env)){
    try{
      const rendered=await browserMarkdown(env,url,budget);
      entry.browserUsed=true;
      entry.mode=rendered.mode;
      entry.chars=rendered.text.length;
      if(rendered.text.length>=AI_MIN_DOC_CHARS){
        entry.status='accepted-browser';
        return {doc:rendered,entry};
      }
      entry.status='too-short';
      return {doc:rendered.text?rendered:null,entry};
    }catch(e){
      entry.status='browser-error';
      entry.error=[entry.error,e?.message||String(e)].filter(Boolean).join(' | ');
      return {doc:page&&page.text?page:null,entry};
    }
  }

  if(entry.status==='thin'){
    entry.status = page.text.length>=AI_MIN_DOC_CHARS ? 'accepted-thin' : 'too-short';
    return {doc:page.text?page:null,entry};
  }
  if(!entry.error)entry.error='no browser fallback available';
  return {doc:null,entry};
}

/* ---------------------------------------------------------------- FPL data */

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

/* ------------------------------------------------------------- extraction */

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
- The source field MUST be one of the SOURCE URLs supplied above, copied exactly.
- Return no event when evidence is insufficient.

OFFICIAL MATERIAL:\n${docs}`;
  const result=await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast',{
    messages:[{role:'system',content:'Extract conservative, source-grounded Premier League team-role events as JSON. Never invent facts.'},{role:'user',content:prompt}],
    response_format:{type:'json_schema',json_schema:{name:'otb_role_events',strict:true,schema:extractionSchema()}},
    temperature:0
  });
  let out=result?.response ?? result;
  if(typeof out==='string'){try{out=JSON.parse(out)}catch{return []}}
  return Array.isArray(out?.events)?out.events:[];
}

function validateEvents(team,players,events,allowedSources){
  const byName=new Map;for(const p of players){byName.set(normal(p.name),p);byName.set(normal(p.fullName),p)}const out=[];
  const allowedHosts=new Set([...allowedSources].map(hostOf).filter(Boolean));
  for(const e of events||[]){const p=byName.get(normal(e.affected));if(!p||!EVENT_VALUES.has(e.type)||!ROLE_VALUES.has(e.role))continue;
    const source=String(e.source||'');if(!/^https?:\/\//i.test(source))continue;
    // Guard against a hallucinated URL: the citation must point at a document
    // that was actually supplied to the model.
    if(allowedHosts.size&&!allowedHosts.has(hostOf(source)))continue;
    if(e.type==='injury'&&normal(e.subject)===normal(p.name))continue;
    const evidenceTime=Date.parse(e.evidenceDate||'');if(Number.isFinite(evidenceTime)&&Date.now()-evidenceTime>120*86400000&&!['departure','signing'].includes(e.type))continue;
    out.push({id:`auto-${hashString([team,e.type,e.subject,p.name,e.role,source,e.evidenceDate].join('|'))}`,createdAt:Date.now(),team,type:e.type,subject:cleanText(e.subject).slice(0,120),role:e.role,affected:p.name,affectedApiId:p.id,overlap:clamp(e.overlap,0,1),hierarchy:clamp(e.hierarchy,0,1),confidence:clamp(e.confidence,0,1),source,reason:cleanText(e.reason).slice(0,320),evidenceDate:cleanText(e.evidenceDate).slice(0,40),auto:true,worker:true,oop:(p.fplPosition==='DEF'&&['LW','RW','AM','ST'].includes(e.role))||(p.fplPosition==='MID'&&['FB','CB'].includes(e.role))});
  }
  const seen=new Set;return out.filter(e=>{const k=[e.type,normal(e.subject),normal(e.affected),e.role,e.source].join('|');if(seen.has(k))return false;seen.add(k);return true});
}

/* ------------------------------------------------------------------- scan */

async function scanTeam(env,team,{force=false}={}){
  team=String(team||'').toUpperCase();
  const club=CLUB_SOURCES[team];
  if(!club)throw new Error(`Unsupported team code: ${team}`);

  const cacheKey=`latest:${team}`;
  if(!force){
    const cached=await env.ROLE_KV.get(cacheKey,'json');
    if(cached)return {...cached,cache:'HIT'};
  }

  const budget=makeBudget(env);
  const roster=await fplContext(env,team);
  const max=Math.max(3,Math.min(12,Number(env.MAX_ARTICLES_PER_SCAN)||8));

  const documents=[];
  const errors=[];
  const discovery=[];
  const perUrl=[];
  let linksFound=0,candidateCount=0,attempted=0;

  for(const source of club.urls){
    try{
      const {landing,record}=await discoverLanding(env,source,budget);
      if(!landing){
        discovery.push({...record,linksFound:0,candidates:0,selectionPass:null});
        if(record.fetchError)errors.push(`${source}: ${record.fetchError}`);
        if(record.browserError)errors.push(`${source}: ${record.browserError}`);
        continue;
      }

      linksFound+=landing.links.length;

      const {candidates,rejected,pass,scoredCount}=selectArticleLinks(landing.url,landing.links,max);
      candidateCount+=candidates.length;

      discovery.push({
        source:landing.url,
        mode:landing.mode,
        linksFound:landing.links.length,
        linksScored:scoredCount,
        candidates:candidates.length,
        selectionPass:candidates.length?pass:'none',
        textChars:landing.text.length,
        browserUsed:record.browserUsed,
        browserError:record.browserError||null,
        fetchError:record.fetchError||null
      });

      // The landing page itself is a low-value listing document, but it is kept
      // because a club sometimes puts a full team-news summary on it.
      documents.push({url:landing.url,text:landing.text.slice(0,16000),mode:landing.mode,kind:'landing'});
      perUrl.push({
        url:landing.url,
        status:landing.text.length>=AI_MIN_DOC_CHARS?'accepted':'too-short',
        kind:'landing',
        mode:landing.mode,
        chars:landing.text.length,
        httpStatus:landing.status??null,
        error:null,
        browserUsed:record.browserUsed
      });

      // Explicit diagnostic when scoring admitted nothing — the silent path in v1.2.
      if(!candidates.length){
        errors.push(`${landing.url}: ${landing.links.length} links discovered, none scored as article candidates`);
        for(const r of rejected.slice(0,10))perUrl.push({url:r.url,status:r.status,kind:'article',score:r.score,chars:0});
      }

      for(const url of candidates){
        if(budget.expired()){
          perUrl.push({url,status:'skipped-budget',kind:'article',chars:0});
          continue;
        }
        attempted++;
        const {doc,entry}=await readArticle(env,url,budget);
        perUrl.push({...entry,kind:'article'});
        if(doc&&doc.text)documents.push({...doc,kind:'article'});
        if(entry.error)errors.push(`${url}: ${entry.error}`);
      }
    }catch(e){
      errors.push(`${source}: ${e?.message||String(e)}`);
    }
  }

  const retrieved=documents.filter(d=>d.text&&d.text.length>0);
  const useful=documents.filter(d=>d.text&&d.text.length>=AI_MIN_DOC_CHARS);
  const articleDocs=useful.filter(d=>d.kind==='article');

  // Only run the model when at least one real article was read. A listing page
  // alone is not grounds for an inference.
  const modelInput=articleDocs.length?useful:[];
  const raw=modelInput.length?await aiExtract(env,team,club.name,roster.current.players,modelInput,roster):[];
  const events=validateEvents(team,roster.current.players,raw,new Set(modelInput.map(d=>d.url)));

  const browserFallbackUsed=perUrl.some(x=>x.browserUsed)||discovery.some(d=>d.browserUsed);

  // ---- Evidence authority -------------------------------------------------
  // A scan is AUTHORITATIVE only if it actually read at least one article
  // document. An authoritative scan that finds nothing legitimately clears the
  // club's evidence. A NON-authoritative scan (every source blocked, JS shell
  // unrendered, budget exhausted) must not be allowed to erase good evidence,
  // so the last known-good events are carried forward until they age out.
  const evidenceAuthoritative=articleDocs.length>0;
  const maxCarryMs=Math.max(1,Number(env.MAX_CARRY_DAYS)||7)*86400000;

  let finalEvents=events;
  let evidenceGeneratedAt=new Date().toISOString();
  let evidenceCarriedForward=false;
  let evidenceNote=evidenceAuthoritative
    ? `Evidence derived from ${articleDocs.length} article document(s) read in this scan.`
    : 'This scan read no article documents.';

  if(!evidenceAuthoritative){
    const prior=await env.ROLE_KV.get(cacheKey,'json');
    const priorEvents=Array.isArray(prior?.events)?prior.events:[];
    // Age against the scan that actually PRODUCED the evidence, not against the
    // last carry-forward, otherwise carrying could chain indefinitely.
    const anchor=Date.parse(prior?.evidenceGeneratedAt||prior?.generatedAt||'');
    const withinCarryWindow=Number.isFinite(anchor)&&(Date.now()-anchor)<=maxCarryMs;

    // Carried evidence must still be valid against TODAY's roster: a player who
    // has since left the club cannot keep an active xMins adjustment.
    const rosterIds=new Set(roster.current.players.map(p=>p.id));
    const rosterNames=new Set(roster.current.players.map(p=>normal(p.name)));
    const stillValid=priorEvents.filter(e=>
      (Number.isFinite(Number(e.affectedApiId))&&rosterIds.has(Number(e.affectedApiId)))
      ||rosterNames.has(normal(e.affected))
    );

    if(stillValid.length&&withinCarryWindow){
      finalEvents=stillValid;
      evidenceGeneratedAt=prior.evidenceGeneratedAt||prior.generatedAt;
      evidenceCarriedForward=true;
      const ageDays=Math.floor((Date.now()-anchor)/86400000);
      const dropped=priorEvents.length-stillValid.length;
      evidenceNote=`This scan read no article documents, so ${stillValid.length} evidence item(s) from ${ageDays} day(s) ago were retained rather than cleared`
        +(dropped?`; ${dropped} were dropped because the player is no longer in the club's FPL roster.`:'.');
    }else if(priorEvents.length){
      evidenceNote=withinCarryWindow
        ? 'This scan read no article documents, and no previous evidence remained valid against the current roster.'
        : 'This scan read no article documents, and the previous evidence has aged out of the carry-forward window.';
    }
  }

  const payload={
    status:'ok',
    schemaVersion:SCHEMA_VERSION,
    season:env.SEASON||'2026/27',
    team,
    club:club.name,
    generatedAt:new Date().toISOString(),
    cache:'MISS',
    // Evidence authority contract (v1.3). Clients that ignore these fields keep
    // working; clients that honour them will not lose evidence to a failed scan.
    evidenceAuthoritative,
    evidenceGeneratedAt,
    evidenceCarriedForward,
    evidenceNote,
    sourcesScanned:useful.map(d=>d.url),
    // sourceErrors stays reserved for conditions worth surfacing in the UI —
    // the frontend styles the panel 'warn' whenever this array is non-empty.
    sourceErrors:errors.slice(0,10),
    diagnostics:{
      discovery,
      linksFound,
      candidates:candidateCount,
      attempted,
      documentsRead:retrieved.length,      // retained for frontend compatibility
      documentsUsed:useful.length,
      articleDocuments:articleDocs.length,
      browserFallbackUsed,
      browserCalls:budget.browserCalls,
      browserAvailable:!!env.BROWSER?.quickAction,
      elapsedMs:budget.elapsedMs,
      budgetExpired:budget.expired(),
      rawEvents:Array.isArray(raw)?raw.length:0,
      acceptedEvents:events.length,
      perUrl:perUrl.slice(0,60),
      eventsFromThisScan:events.length,
      evidenceAuthoritative,
      evidenceCarriedForward
    },
    roster:{
      players:roster.current.players.length,
      added:roster.added.map(p=>p.name),
      missingUnresolved:roster.missing.map(p=>p.name)
    },
    events:finalEvents
  };

  await env.ROLE_KV.put(cacheKey,JSON.stringify(payload),{expirationTtl:60*60*24*14});
  return payload;
}

/* -------------------------------------------------------------- surfaces */

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
      if(u.pathname==='/'||u.pathname==='/api/health')return json({status:'ok',service:'OTB Role Intelligence',schemaVersion:SCHEMA_VERSION,season:env.SEASON||'2026/27',teams:Object.keys(CLUB_SOURCES).length,browserAvailable:!!env.BROWSER?.quickAction,generatedAt:new Date().toISOString()},200,env);
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
      // Single-URL probe: isolates fetch vs browser behaviour for one article.
      if(u.pathname==='/api/scout/probe'){
        const target=u.searchParams.get('url');if(!target)return json({error:'url is required'},400,env);
        const budget=makeBudget(env);
        const {entry}=await readArticle(env,target,budget);
        return json({status:'ok',probe:entry,browserAvailable:!!env.BROWSER?.quickAction,browserCalls:budget.browserCalls},200,env);
      }
      return json({error:'not found'},404,env);
    }catch(e){return json({status:'error',error:e?.message||String(e),generatedAt:new Date().toISOString()},500,env)}
  },
  async scheduled(event,env,ctx){
    env = await withD1(env);
    ctx.waitUntil((async()=>{const teams=Object.keys(CLUB_SOURCES),key='cron:cursor',cursor=Number(await env.ROLE_KV.get(key)||0),count=Math.max(1,Math.min(4,Number(env.CRON_TEAMS_PER_RUN)||2));for(let i=0;i<count;i++){const team=teams[(cursor+i)%teams.length];try{await scanTeam(env,team,{force:true})}catch(e){await env.ROLE_KV.put(`error:${team}`,JSON.stringify({at:new Date().toISOString(),error:e.message}),{expirationTtl:86400})}}await env.ROLE_KV.put(key,String((cursor+count)%teams.length));})());
  }
};
