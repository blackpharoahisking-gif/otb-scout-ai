// OTB Role Intelligence Worker
// v2.8 — RC5.0.8 release hardening: atomic scan lock, execution-aware quota, safe event ageing
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
const SCHEMA_VERSION = '1.28.0';   // wire format: UNCHANGED in RC5.0.9 (no field/shape change)
// Single source of truth. This string was previously duplicated in the report
// payload and the /api/health response, which is exactly how a deployment
// smoke test ends up verifying one build while the other reports another.
const WORKER_BUILD = 'v2.10-rc5.0.10-independent-verified';

const AI_MIN_DOC_CHARS = 250;      // doc must have this much text to reach the model
const ARTICLE_MIN_CHARS = 900;     // below this, try the browser for a fuller body
const LANDING_MIN_CHARS = 800;     // below this, the landing page is a JS shell
const DEFAULT_BROWSER_BUDGET = 3;  // max Browser Run calls per scan (see notes: free tier = 3 new instances/min)
const DEFAULT_BROWSER_SPACING_MS = 2500; // Browser Run enforces a per-second fill rate, not a burst allowance
const DEFAULT_SCAN_BUDGET_MS = 45000;
const ARTICLE_CACHE_DAYS = 45;
const MUTABLE_CACHE_MINUTES = 90;
const MUTABLE_ARTICLE_RE = /(?:team-news|fitness-update|injury-update|press-conference|squad-news|starting-xi|confirmed-line-up|line-up|lineup|availability|ruled-out|doubtful|training|matchday-live|live-blog)/i;

function isMutableArticleUrl(url){
  try{return MUTABLE_ARTICLE_RE.test(decodeURIComponent(new URL(url).pathname))}
  catch{return MUTABLE_ARTICLE_RE.test(String(url||''))}
}
function articleCacheMaxAgeMs(url,force=false){
  if(force&&isMutableArticleUrl(url))return 0; // manual Fresh Scan revalidates mutable operational news
  return isMutableArticleUrl(url)?MUTABLE_CACHE_MINUTES*60000:ARTICLE_CACHE_DAYS*86400000;
}
// Bump when the TEXT FORMAT changes. v1 flattened documents to a single line,
// which makes line-based boilerplate detection impossible; v2 preserves lines.
const CACHE_FORMAT = 'v3';     // extracted article cache; mutable operational URLs are revalidated
const DISCOVERY_LEDGER_MAX = 320;
const DISCOVERY_LEDGER_VERSION = 'v2';
const RECENCY_COVERAGE_MIN = 0.25;

/* ---------------------------------------------------------------- storage */

let TABLE_READY = false;

async function withD1(env) {
  if (!env.DB) throw new Error('D1 binding DB is missing.');

  // Ran on EVERY request before; once per isolate is enough.
  if (!TABLE_READY) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS otb_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `).run();
    TABLE_READY = true;
  }

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

    /* LIKE 'prefix%' compiles to a full index SCAN in SQLite because the
       default LIKE is case-insensitive, so the optimiser cannot use the
       key index. Measured at ~20k rows read per call against a populated
       article cache. A half-open range is an indexed SEARCH instead and
       is exactly equivalent for the ASCII, wildcard-free prefixes used
       here, e.g. 'calib:'. */
    async list(prefix) {
      const lo = String(prefix);
      const hi = lo.slice(0, -1) + String.fromCharCode(lo.charCodeAt(lo.length - 1) + 1);
      const { results } = await env.DB.prepare(
        'SELECT key FROM otb_store WHERE key >= ? AND key < ? LIMIT 5000'
      ).bind(lo, hi).all();
      return (results || []).map(r => r.key);
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
const EVENT_VALUES = new Set(['observed_role','confirmed_start','confirmed_bench','unavailable','fitness_doubt','minutes_restricted','rotation_warning','suspension','departure','signing','loan_in','loan_out','injury','return','manager_positive','manager_negative']);

const EVIDENCE_POLICY = Object.freeze({
  confirmed_start:{channel:'lineup',tier:1,halfLifeHours:18,ttlHours:30,maxMinuteImpact:35,direct:true},
  confirmed_bench:{channel:'lineup',tier:1,halfLifeHours:18,ttlHours:30,maxMinuteImpact:35,direct:true},
  unavailable:{channel:'availability',tier:1,halfLifeHours:72,ttlHours:168,maxMinuteImpact:90,direct:true},
  suspension:{channel:'availability',tier:1,halfLifeHours:168,ttlHours:336,maxMinuteImpact:90,direct:true},
  minutes_restricted:{channel:'availability',tier:1,halfLifeHours:48,ttlHours:96,maxMinuteImpact:45,direct:true},
  fitness_doubt:{channel:'availability',tier:2,halfLifeHours:36,ttlHours:72,maxMinuteImpact:25,direct:true},
  observed_role:{channel:'selection',tier:2,halfLifeHours:240,ttlHours:720,maxMinuteImpact:12,direct:true},
  rotation_warning:{channel:'manager',tier:2,halfLifeHours:72,ttlHours:120,maxMinuteImpact:12,direct:true},
  manager_positive:{channel:'manager',tier:2,halfLifeHours:96,ttlHours:168,maxMinuteImpact:10,direct:true},
  manager_negative:{channel:'manager',tier:2,halfLifeHours:96,ttlHours:168,maxMinuteImpact:10,direct:true},
  signing:{channel:'competition',tier:3,halfLifeHours:360,ttlHours:1080,maxMinuteImpact:5,direct:false},
  departure:{channel:'competition',tier:3,halfLifeHours:360,ttlHours:1080,maxMinuteImpact:5,direct:false},
  loan_in:{channel:'competition',tier:3,halfLifeHours:240,ttlHours:720,maxMinuteImpact:5,direct:false},
  loan_out:{channel:'competition',tier:3,halfLifeHours:240,ttlHours:720,maxMinuteImpact:5,direct:false},
  injury:{channel:'competition',tier:3,halfLifeHours:120,ttlHours:336,maxMinuteImpact:6,direct:false},
  return:{channel:'competition',tier:3,halfLifeHours:120,ttlHours:336,maxMinuteImpact:6,direct:false}
});

// Vocabulary observed across official club publishing styles. Discovery uses
// these families broadly; classification below requires semantic context so
// ambiguous words such as "signs", "deal", "returns" and "leaves" cannot
// create a player event on their own.
const CLUB_TERMS = Object.freeze({
  transferIn:[
    /\bjoins?\b/i, /\bnew signing\b/i, /\bsigns? for\b/i,
    /\bcomplete(?:s|d)? (?:the )?(?:signing|move)\b/i,
    /\bhas signed\b/i, /\barrives?\b/i, /\bwelcome\b/i,
    /\bagree(?:s|d)? (?:a )?deal to sign\b/i, /\bseals? (?:a )?move\b/i
  ],
  transferOut:[
    /\bleaves?\b/i, /\bdeparts?\b/i, /\bhas left\b/i,
    /\bjoins? .+ from\b/i, /\bcomplete(?:s|d)? (?:a )?move to\b/i,
    /\btransfer(?:red)? to\b/i, /\bsold to\b/i, /\bfarewell\b/i
  ],
  loan:[
    /\bon loan\b/i, /\bseason-long loan\b/i, /\bloan deal\b/i,
    /\bloan move\b/i, /\btemporary move\b/i, /\breturns? from loan\b/i,
    /\brecalled from loan\b/i
  ],
  renewal:[
    /\bnew deal\b/i, /\bnew contract\b/i, /\bcontract extension\b/i,
    /\bextends? (?:his|her|their|the) (?:stay|deal|contract)\b/i,
    /\bcommits? .+ future\b/i, /\bcommits? to\b/i, /\bpens? (?:a )?new deal\b/i,
    /\bputs? pen to paper\b/i, /\bre-?signs?\b/i, /\brenews?\b/i,
    /\bprofessional terms\b/i, /\bfirst pro(?:fessional)? deal\b/i
  ],
  injuryOut:[
    /\bruled out\b/i, /\bunavailable\b/i, /\bsidelined\b/i,
    /\bwill miss\b/i, /\bset to miss\b/i, /\bout for\b/i,
    /\bsuffer(?:s|ed)? (?:an? )?(?:injury|knock|setback)\b/i,
    /\bunderwent surgery\b/i, /\boperation\b/i
  ],
  doubt:[
    /\bdoubtful\b/i, /\ba doubt\b/i, /\bfitness test\b/i,
    /\bassessment closer to the game\b/i, /\bwe will see\b/i,
    /\bchance of making\b/i, /\bmay be in contention\b/i
  ],
  return:[
    /\bback in training\b/i, /\breturns? to training\b/i,
    /\breturned to training\b/i, /\bresumed training\b/i,
    /\bback with the squad\b/i, /\breturned to the squad\b/i,
    /\bavailable for\b/i, /\bfit to face\b/i, /\bready to return\b/i
  ],
  selectionPositive:[
    /\bstarts?\b/i, /\bstarting xi\b/i, /\bnamed in the starting xi\b/i,
    /\bfirst choice\b/i, /\bkept his place\b/i, /\bkept her place\b/i,
    /\bplayed (?:the full )?90\b/i, /\bdeployed at\b/i, /\blined up at\b/i
  ],
  selectionNegative:[
    /\bbenched\b/i, /\brested\b/i, /\bdropped\b/i,
    /\bnot in the squad\b/i, /\bomitted from the squad\b/i,
    /\bsubstitute\b/i
  ],
  nonPlayer:[
    /\bmanager\b/i, /\bcoach\b/i, /\bacademy manager\b/i,
    /\bstaff\b/i, /\bpartnership\b/i, /\bsponsorship\b/i,
    /\bcommercial\b/i, /\bambassador\b/i
  ]
});

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
/** Collapses horizontal whitespace but KEEPS newlines — line structure is what
 *  makes cross-document boilerplate detection possible. */
function cleanLines(s){return String(s||'').replace(/[ \t\u00a0]+/g,' ').replace(/\n{2,}/g,'\n').split('\n').map(l=>l.trim()).filter(Boolean).join('\n')}
function normal(s){return cleanText(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'')}
function hashString(s){
  // Two independent FNV-1a passes -> 64 bits. A single 32-bit pass collides with
  // ~0.3% probability across a season of article URLs, and a collision would
  // silently serve the WRONG cached article text for a URL.
  let a=2166136261,b=2166136261^0x9e3779b9;
  for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);
    a^=c;a=Math.imul(a,16777619);
    b^=c+i;b=Math.imul(b,16777639)}
  return ((a>>>0).toString(16).padStart(8,'0'))+((b>>>0).toString(16).padStart(8,'0'));
}
function teamCodeFromFplTeam(t){return TEAM_ALIASES[normal(t?.name)] || TEAM_ALIASES[normal(t?.short_name)] || String(t?.short_name||'').toUpperCase()}
function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,'')}catch{return ''}}

/** Budget guard so a forced scan cannot run past the user's patience. */
function makeBudget(env){
  const started=Date.now();
  const deadline=started+Math.max(10000,Number(env.SCAN_BUDGET_MS)||DEFAULT_SCAN_BUDGET_MS);
  const spacing=Math.max(0,Number(env.BROWSER_MIN_SPACING_MS ?? DEFAULT_BROWSER_SPACING_MS));
  const browserMax=Math.max(0,Number(env.BROWSER_BUDGET ?? DEFAULT_BROWSER_BUDGET));
  let browserCalls=0,lastCallAt=0,quotaExhausted=false,rateLimitHits=0;
  return {
    expired(){return Date.now()>=deadline},
    remainingMs(){return Math.max(0,deadline-Date.now())},
    canBrowse(env2){
      if(quotaExhausted)return false;
      if(!env2?.BROWSER?.quickAction)return false;
      if(browserCalls>=browserMax)return false;
      return !this.expired();
    },
    /** Browser Run bills a per-second fill rate; back-to-back calls return 429. */
    async pace(){
      if(!lastCallAt||!spacing)return;
      const wait=Math.min(spacing-(Date.now()-lastCallAt),this.remainingMs());
      if(wait>0)await new Promise(r=>setTimeout(r,wait));
    },
    spendBrowser(){browserCalls++;lastCallAt=Date.now()},
    noteRateLimit(){rateLimitHits++},
    markQuotaExhausted(){quotaExhausted=true},
    get quotaExhausted(){return quotaExhausted},
    get rateLimitHits(){return rateLimitHits},
    get browserCalls(){return browserCalls},
    get browserMax(){return browserMax},
    get elapsedMs(){return Date.now()-started}
  };
}

/* ------------------------------------------------------------ perimeter */
// Threat model note: the realistic risk here is not a determined attacker, it
// is an accidental loop, a crawler, or a stray script hitting force=1 and
// burning the Browser Run allowance overnight. So the controls are cost
// controls first: cooldown, daily cap and a scan lock. A shared secret is
// reserved for routes the browser app never calls, because a secret shipped
// inside public HTML is not a secret.

const DEFAULT_FORCE_COOLDOWN_MIN = 2;   // 10 was hostile to normal re-scanning
const DEFAULT_FORCE_DAILY_CAP = 60;
const SCAN_LOCK_TTL_MS = 150000;

function adminAuthorised(request,env){
  const expected=String(env.SCOUT_ADMIN_TOKEN||'');
  if(!expected)return false;                       // fail closed when unset
  const url=new URL(request.url);
  const supplied=request.headers.get('x-otb-token')
    ||(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'')
    ||url.searchParams.get('key')||'';
  if(supplied.length!==expected.length)return false;
  // Constant-time-ish compare.
  let diff=0;
  for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^supplied.charCodeAt(i);
  return diff===0;
}

/** Origin is a weak filter, not authentication. Direct address-bar requests
 *  send no Origin header, so those are allowed through for debugging. */
function originAllowed(request,env){
  const allowed=String(env.ALLOWED_ORIGIN||'').trim();
  if(!allowed||allowed==='*')return true;
  const origin=request.headers.get('origin');
  if(!origin)return true;
  return allowed.split(',').map(x=>x.trim()).includes(origin);
}

function dayStamp(){return new Date().toISOString().slice(0,10)}

/** Per-team cooldown plus a global daily ceiling on forced scans. */
async function forcedScanAllowed(env,team){
  const cooldownMs=Math.max(0,Number(env.FORCE_COOLDOWN_MINUTES ?? DEFAULT_FORCE_COOLDOWN_MIN))*60000;
  const cap=Math.max(0,Number(env.FORCE_DAILY_CAP ?? DEFAULT_FORCE_DAILY_CAP));

  if(cap>0){
    const key=`forcecount:${dayStamp()}`;
    const used=Number(await env.ROLE_KV.get(key))||0;
    if(used>=cap)return {allowed:false,reason:`daily forced-scan cap of ${cap} reached; cached reports are still served`,retryAfterSec:3600};
  }
  if(cooldownMs>0){
    const last=Number(await env.ROLE_KV.get(`forcelast:${team}`))||0;
    const since=Date.now()-last;
    if(last&&since<cooldownMs){
      return {allowed:false,reason:`a forced scan for ${team} ran ${Math.round(since/1000)}s ago; cooldown is ${Math.round(cooldownMs/1000)}s`,retryAfterSec:Math.ceil((cooldownMs-since)/1000)};
    }
  }
  return {allowed:true};
}

async function noteForcedScan(env,team){
  const key=`forcecount:${dayStamp()}`;
  const used=Number(await env.ROLE_KV.get(key))||0;
  await env.ROLE_KV.put(key,String(used+1),{expirationTtl:60*60*36});
  await env.ROLE_KV.put(`forcelast:${team}`,String(Date.now()),{expirationTtl:60*60*24});
}

/** Prevents cron and users scanning the same club at once.
 *  Acquisition is one atomic SQLite UPSERT. The token makes release ownership
 *  safe: an old request cannot clear a newer request's lock after TTL rollover.
 */
async function acquireScanLock(env,team){
  const key=`lock:scan:${team}`,now=Date.now(),cutoff=now-SCAN_LOCK_TTL_MS;
  const token=`${now}:${crypto.randomUUID()}`;
  const expiresAt=now+SCAN_LOCK_TTL_MS+30000;
  const result=await env.DB.prepare(`
    INSERT INTO otb_store (key,value,expires_at,updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,
      expires_at=excluded.expires_at,
      updated_at=excluded.updated_at
    WHERE otb_store.updated_at <= ? OR otb_store.value='0'
  `).bind(key,token,expiresAt,now,cutoff).run();
  return Number(result?.meta?.changes||0)>0?token:null;
}
async function releaseScanLock(env,team,token){
  if(!token)return;
  try{
    await env.DB.prepare('DELETE FROM otb_store WHERE key = ? AND value = ?')
      .bind(`lock:scan:${team}`,String(token)).run();
  }catch{}
}

/* ------------------------------------------------------------ page reading */

class TextCollector {
  constructor(base){this.base=base;this.text=[];this.links=[];this.current=''}
  element(el){const href=el.getAttribute('href');if(href){try{const u=new URL(href,this.base);if(u.protocol.startsWith('http')){u.hash='';this.links.push(u.toString())}}catch{}}}
  // HTMLRewriter can split one text node across several chunks. Buffer until
  // lastInTextNode so a line is a whole line, not a fragment.
  textChunk(t){
    this.current+=t.text;
    if(t.lastInTextNode){
      const v=cleanText(this.current);
      if(v)this.text.push(v);
      this.current='';
    }
  }
}

async function parseHtmlResponse(response,baseUrl){
  const c=new TextCollector(baseUrl);
  await new HTMLRewriter()
    .on('title,h1,h2,h3,h4,p,li,time,a', {element:e=>c.element(e),text:t=>c.textChunk(t)})
    .transform(response).text();
  return {text:cleanLines(c.text.join('\n')).slice(0,65000),links:[...new Set(c.links)]};
}

/** Extract publication dates from multiple publisher signals.
 *  Structured Article data, HTML time elements and card data attributes are
 *  combined; no single publisher convention is assumed. */
function extractLinkTimesFromHtml(markup,baseUrl){
  const times=new Map(),sources=new Map(),html=String(markup||'');
  const resolveUrl=raw=>{try{const u=new URL(raw,baseUrl);if(!u.protocol.startsWith('http'))return null;u.hash='';return u.toString()}catch{return null}};
  const set=(url,raw,source)=>{const u=resolveUrl(url),t=Date.parse(raw||'');if(!u||!Number.isFinite(t))return;const prev=times.get(u);if(!Number.isFinite(prev)||t<prev){times.set(u,t);sources.set(u,source)}};
  const ldRe=/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while((m=ldRe.exec(html))){
    let data;try{data=JSON.parse(m[1])}catch{continue}
    const walk=x=>{if(!x)return;if(Array.isArray(x)){x.forEach(walk);return}if(typeof x!=='object')return;
      const typ=Array.isArray(x['@type'])?x['@type'].join(' '):String(x['@type']||'');
      if(/NewsArticle|Article|BlogPosting/i.test(typ)){const url=x.url||x.mainEntityOfPage?.['@id']||x.mainEntityOfPage?.url,date=x.datePublished||x.dateCreated||x.dateModified;if(url&&date)set(url,date,'json-ld')}
      if(x['@graph'])walk(x['@graph']);for(const v of Object.values(x))if(v&&typeof v==='object')walk(v);
    };walk(data);
  }
  const timeRe=/<time\b[^>]*(?:datetime|data-time|data-date)=["']([^"']+)["'][^>]*>/gi;
  const anchorRe=/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const timeHits=[];while((m=timeRe.exec(html))){const t=Date.parse(m[1]);if(Number.isFinite(t))timeHits.push({i:m.index,t})}
  const anchors=[];while((m=anchorRe.exec(html))){const u=resolveUrl(m[1]);if(u)anchors.push({i:m.index,url:u})}
  for(const a of anchors){let best=null,dist=Infinity;for(const th of timeHits){const d=Math.abs(th.i-a.i);if(d<dist&&d<=2200){best=th;dist=d}}if(best&&!times.has(a.url)){times.set(a.url,best.t);sources.set(a.url,'time-near-link')}}
  const cardDateRe=/(?:data-(?:publish(?:ed)?|date|timestamp)|datePublished)\s*=\s*["']([^"']+)["']/gi;
  const cardDates=[];while((m=cardDateRe.exec(html))){const t=Date.parse(m[1]);if(Number.isFinite(t))cardDates.push({i:m.index,t})}
  for(const a of anchors){if(times.has(a.url))continue;let best=null,dist=Infinity;for(const d of cardDates){const dx=Math.abs(d.i-a.i);if(dx<dist&&dx<=2200){best=d;dist=dx}}if(best){times.set(a.url,best.t);sources.set(a.url,'data-attribute')}}
  const uniqueLinks=[...new Set(anchors.map(a=>a.url))];
  return {times,sources,coverage:uniqueLinks.length?times.size/uniqueLinks.length:0};
}
function extractPagePublicationFromHtml(markup){
  const html=String(markup||''),hits=[];
  const push=(raw,source,priority)=>{const t=Date.parse(raw||'');if(Number.isFinite(t))hits.push({t,source,priority})};
  let m;
  const metaRe=/<meta\b[^>]*(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  while((m=metaRe.exec(html))){
    const k=String(m[1]||'').toLowerCase(),v=m[2];
    if(['article:published_time','og:published_time','datepublished','publishdate','pubdate'].includes(k))push(v,`meta:${k}`,1);
    else if(['article:modified_time','datemodified','last-modified'].includes(k))push(v,`meta:${k}`,5);
  }
  const ldRe=/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while((m=ldRe.exec(html))){
    let data;try{data=JSON.parse(m[1])}catch{continue}
    const walk=x=>{if(!x)return;if(Array.isArray(x)){x.forEach(walk);return}if(typeof x!=='object')return;
      const typ=Array.isArray(x['@type'])?x['@type'].join(' '):String(x['@type']||'');
      if(/NewsArticle|Article|BlogPosting/i.test(typ)){
        if(x.datePublished)push(x.datePublished,'json-ld:datePublished',0);
        else if(x.dateCreated)push(x.dateCreated,'json-ld:dateCreated',2);
        else if(x.dateModified)push(x.dateModified,'json-ld:dateModified',6);
      }
      if(x['@graph'])walk(x['@graph']);for(const v of Object.values(x))if(v&&typeof v==='object')walk(v);
    };walk(data);
  }
  const timeRe=/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/gi;
  while((m=timeRe.exec(html)))push(m[1],'time:datetime',3);
  if(!hits.length)return {publishedAt:null,dateSource:null};
  hits.sort((a,b)=>a.priority-b.priority||a.t-b.t);
  return {publishedAt:hits[0].t,dateSource:hits[0].source};
}


async function fetchPage(url,{etag=null,lastModified=null}={}){
  let r;
  try{
    r=await fetch(url,{
      headers:{
        'User-Agent':'OTB-Scout-AI/1.3 (+FPL research; contact via otb-role-intelligence.workers.dev)',
        'Accept':'text/html,application/xhtml+xml',
        'Accept-Language':'en-GB,en;q=0.9',
        ...(etag?{'If-None-Match':etag}:{}),
        ...(lastModified?{'If-Modified-Since':lastModified}:{})
      },
      redirect:'follow'
    });
  }catch(e){
    const err=new Error(`network error: ${e?.message||String(e)}`);
    err.kind='network';err.url=url;throw err;
  }
  if(r.status===304)return {url:r.url,notModified:true,status:304,mode:'fetch-304',etag:r.headers.get('etag')||etag||null,lastModified:r.headers.get('last-modified')||lastModified||null};
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
  const markup=await r.text();
  const parsed=await parseHtmlResponse(new Response(markup,{headers:{'content-type':ct||'text/html'}}),r.url);
  const recency=extractLinkTimesFromHtml(markup,r.url);
  const pageDate=extractPagePublicationFromHtml(markup);
  return {url:r.url,text:parsed.text,links:parsed.links,times:recency.times,timeSources:recency.sources,timestampCoverage:recency.coverage,publishedAt:pageDate.publishedAt,dateSource:pageDate.dateSource,etag:r.headers.get('etag')||null,lastModified:r.headers.get('last-modified')||null,mode:'fetch',status:r.status,redirected:r.url!==url};
}

/* ------------------------------------------------------------ Browser Run */

async function quickActionJson(env,action,payload){
  if(!env.BROWSER?.quickAction)throw new Error('Browser Run quickAction binding is unavailable.');
  const response=await env.BROWSER.quickAction(action,payload);
  if(response && typeof response.json==='function'){
    if(!response.ok){
      let body='';try{body=cleanText(await response.text()).slice(0,240)}catch{}
      const err=new Error(`Browser Run ${action} returned HTTP ${response.status}${body?`: ${body}`:''}`);
      err.status=response.status;
      // Two very different 429s: the daily browser-time cap (Workers Free is
      // 10 minutes/day, resets at UTC midnight) versus the per-minute instance
      // fill rate. The first means stop; the second means slow down.
      err.quotaExhausted=response.status===429&&/time limit|exceeded for today|daily|per day/i.test(body);
      err.rateLimited=response.status===429&&!err.quotaExhausted;
      throw err;
    }
    const data=await response.json();
    if(data?.success===false)throw new Error(data?.errors?.[0]?.message||`Browser Run ${action} failed.`);
    return data?.result ?? data;
  }
  if(response?.success===false)throw new Error(response?.errors?.[0]?.message||`Browser Run ${action} failed.`);
  return response?.result ?? response;
}

/** Paces calls, retries once on a rate-limit 429, and stops dead on a quota 429. */
async function browserCall(env,budget,action,payload){
  for(let attempt=0;attempt<2;attempt++){
    // Re-checked every attempt, so a 429 retry can no longer push the scan
    // past BROWSER_BUDGET (v1.4 reached 4 calls against a budget of 3).
    if(!budget.canBrowse(env))throw new Error(`Browser Run ${action} skipped: browser budget exhausted.`);
    await budget.pace();
    budget.spendBrowser();
    try{
      return await quickActionJson(env,action,payload);
    }catch(e){
      if(e.quotaExhausted){budget.markQuotaExhausted();throw e}
      if(e.rateLimited&&attempt===0&&budget.remainingMs()>8000){
        budget.noteRateLimit();
        await new Promise(r=>setTimeout(r,Math.min(5000,budget.remainingMs()-2000)));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Browser Run ${action} failed after retry.`);
}

const GOTO = {waitUntil:'networkidle2',timeout:15000};

/**
 * One browser call that yields BOTH rendered text and rendered links.
 * v1.2 used /links for discovery and /markdown for articles, which meant a
 * JS-rendered landing page could gain links but never gain text.
 */
async function browserRender(env,url,budget){
  const html=await browserCall(env,budget,'content',{url,gotoOptions:GOTO});
  const markup=typeof html==='string'?html:(html?.content||html?.html||'');
  if(!markup)throw new Error('Browser Run content returned no markup.');
  const response=new Response(markup,{headers:{'content-type':'text/html; charset=utf-8'}});
  const parsed=await parseHtmlResponse(response,url);
  const recency=extractLinkTimesFromHtml(markup,url);
  const pageDate=extractPagePublicationFromHtml(markup);
  return {url,text:parsed.text,links:parsed.links,times:recency.times,timeSources:recency.sources,timestampCoverage:recency.coverage,publishedAt:pageDate.publishedAt,dateSource:pageDate.dateSource,mode:'browser-content',status:200,redirected:false};
}

async function browserMarkdown(env,url,budget){
  const result=await browserCall(env,budget,'markdown',{url,gotoOptions:GOTO});
  const markdown=typeof result==='string'?result:(result?.markdown||result?.content||'');
  return {url,text:cleanLines(markdown).slice(0,65000),links:[],mode:'browser-markdown',status:200,redirected:false};
}

/* --------------------------------------------------------- article cache */
// Stable announcement/history URLs use a long extracted-text cache. Mutable
// operational URLs (team news, fitness, press conferences, lineups, training)
// use a short cache and are always revalidated during an explicit Fresh Scan.
// HTTP validators keep revalidation cheap when publishers support them.

function articleKey(url){return `article:${CACHE_FORMAT}:${hashString(url)}`}

async function cachedArticle(env,url,{force=false}={}){
  try{
    const hit=await env.ROLE_KV.get(articleKey(url),'json');
    if(!hit?.text||hit.text.length<AI_MIN_DOC_CHARS)return null;
    const fetchedAt=Date.parse(hit.fetchedAt||'');
    const maxAge=articleCacheMaxAgeMs(url,force);
    if(maxAge===0 || !Number.isFinite(fetchedAt) || Date.now()-fetchedAt>maxAge)return null;
    // Integrity check. The stored payload records the URL it was written for;
    // if it disagrees, the key resolved to another article and the text would
    // be silently wrong. Treat as a miss and re-render rather than serve it.
    if(hit.url&&hit.url!==url){
      try{await env.ROLE_KV.put(`cachemismatch:${hashString(url)}`,JSON.stringify({requested:url,stored:hit.url,at:new Date().toISOString()}),{expirationTtl:60*60*24*14})}catch{}
      return null;
    }
    return hit;
  }catch{}
  return null;
}

async function storeArticle(env,url,doc){
  if(!doc?.text||doc.text.length<AI_MIN_DOC_CHARS)return;
  try{
    await env.ROLE_KV.put(articleKey(url),JSON.stringify({
      url,text:doc.text,mode:doc.mode,fetchedAt:new Date().toISOString(),
      publishedAt:Number(doc.publishedAt)||null,dateSource:doc.dateSource||null,
      etag:doc.etag||null,lastModified:doc.lastModified||null
    }),{expirationTtl:60*60*24*ARTICLE_CACHE_DAYS});
  }catch{}
}

/* --------------------------------------------------- boilerplate stripping */
// A club article page is ~85% site furniture: nav, menus, cookie notices,
// related-article teasers, footers. That furniture is IDENTICAL across every
// page on the host, so lines that recur across documents are by definition
// chrome, and lines unique to one page are its actual content. The landing
// page is pure chrome plus headlines, which makes it an excellent reference
// corpus even when only one article was read.
//
// This runs on text already in hand — no extra fetches, no extra browser time.

function splitLines(text){
  return String(text||'').split('\n').map(l=>l.trim()).filter(Boolean);
}

function buildBoilerplateSet(docs){
  const counts=new Map();
  for(const d of docs){
    for(const line of new Set(splitLines(d.text))){
      counts.set(line,(counts.get(line)||0)+1);
    }
  }
  // Recurring in at least two documents, scaling up with corpus size so a
  // quote legitimately shared by two of six articles is not mistaken for nav.
  const threshold=Math.max(2,Math.ceil(docs.length*0.4));
  const set=new Set();
  for(const [line,count] of counts){
    if(count>=threshold)set.add(line);
  }
  return set;
}

function stripBoilerplate(text,boilerplate){
  const original=String(text||'');
  const kept=[];
  let previous=null;
  for(const line of splitLines(original)){
    if(boilerplate.has(line))continue;
    if(line===previous)continue;   // collapse repeated adjacent lines
    kept.push(line);
    previous=line;
  }
  const stripped=kept.join('\n');
  // Safety valve only for total loss. A page that genuinely IS 97% chrome
  // should be stripped to 3%; and a stub that falls under AI_MIN_DOC_CHARS
  // after stripping should be DROPPED as thin, not rescued by re-adding nav.
  if(!stripped.length){
    return {text:original,stripped:false,before:original.length,after:original.length};
  }
  return {text:stripped,stripped:true,before:original.length,after:stripped.length};
}



function scoreLink(url,host,currentYear){
  let score=0,u;try{u=new URL(url)}catch{return {score:-99,reason:'unparseable'}}
  if(u.hostname.replace(/^www\./,'')!==host)return {score:-99,reason:'off-host'};
  const p=decodeURIComponent(u.pathname).toLowerCase();
  if(/\/news\//.test(p))score+=7;
  if(/article|story|press|interview|team-news|fitness-update|injury-update|transfer|sign(?:s|ed|ing)?|joins?|join-|completes?|welcome|agree(?:s|d)?|announce(?:s|d|ment)?|departs?|leaves?|arrives?|seals?|pens?|commits?|extends?|new-deal|new-contract|loan|loan-deal|loan-move|returns?|back-in-training|available|unavailable|ruled-out|sidelined|doubtful|starting-xi|confirmed-line-up|line-up|lineup|squad-news|squad|pre-season|preseason|friendly|match-report|injury|contract/.test(p))score+=6;
  if(new RegExp(`/${currentYear}/`).test(p))score+=1;
  if(new RegExp(`/${currentYear-1}/`).test(p))score-=2;
  const depth=p.split('/').filter(Boolean).length;if(depth>=2)score+=1;
  if(/press-conference|injury-update|starting-xi|confirmed-line-up|team-news|squad-news/.test(p))score+=4;
  if(/how-to-watch|watch-live|live-stream|tv-guide|broadcast|listen-live|quiz|competition-|matchday-guide|where-to-watch/.test(p))score-=20;
  if(/privacy|cookie|terms|ticket|shop|store|account|login|register|video|gallery|women|academy|hospitality|commercial|foundation|sitemap|contact/.test(p))score-=12;
  if(/preview|fixtures|highlights|\/watch-|watch--|match-gallery|photos/.test(p))score-=8;
  if(p==='/'||/\/news\/?$/.test(p))score-=12;
  return {score,reason:score>1?'candidate':'low-score',depth};
}

/**
 * Strict pass first. If it returns nothing, a relaxed pass admits any
 * same-host link with real path depth that is not obviously utility chrome.
 * A scan that finds links must never end with zero attempts and no diagnostic.
 */
function discoveryLedgerKey(team){return `discovery:${DISCOVERY_LEDGER_VERSION}:${team}`}
async function loadDiscoveryLedger(env,team){const row=await env.ROLE_KV.get(discoveryLedgerKey(team),'json');return Array.isArray(row?.urls)?row.urls:[]}
async function saveDiscoveryLedger(env,team,urls){const dedup=[...new Set((urls||[]).filter(Boolean))].slice(-DISCOVERY_LEDGER_MAX);await env.ROLE_KV.put(discoveryLedgerKey(team),JSON.stringify({updatedAt:new Date().toISOString(),urls:dedup}),{expirationTtl:60*60*24*120})}

function selectArticleLinks(base,links,limit,times=new Map(),timestampCoverage=0,{seenUrls=new Set(),force=false}={}){
  const host=hostOf(base),currentYear=new Date().getUTCFullYear();
  const scored=links.map((url,index)=>({url,index,time:Number(times?.get?.(url))||null,seen:seenUrls.has(url),...scoreLink(url,host,currentYear)}));

  let selected=scored.filter(x=>x.score>1),pass='strict';
  if(!selected.length){selected=scored.filter(x=>x.score>-99&&(x.depth||0)>=2&&x.score>-6);pass='relaxed'}

  // IMPORTANT: the relaxed pass must stay relaxed. v2.0 accidentally reapplied
  // score>1 here, which made "relaxed" effectively strict again.
  const eligible=pass==='relaxed'?selected:selected.filter(x=>x.score>1);
  const coverage=Number(timestampCoverage)||0,useTimestamp=coverage>=RECENCY_COVERAGE_MIN;
  const unseenFirst=(a,b)=>(a.seen===b.seen?0:(a.seen?1:-1));

  // Freshness lane:
  //   1) timestamps, when enough are actually available;
  //   2) otherwise the publisher's rendered DOM order;
  // with never-processed URLs ahead of URLs already analysed.
  const freshLane=useTimestamp
    ? eligible.filter(x=>Number.isFinite(x.time)).sort((a,b)=>unseenFirst(a,b)||b.time-a.time||b.score-a.score||a.index-b.index)
    : eligible.slice().sort((a,b)=>unseenFirst(a,b)||a.index-b.index||b.score-a.score);
  const keywordLane=eligible.slice().sort((a,b)=>unseenFirst(a,b)||b.score-a.score||a.index-b.index);

  const seen=new Set(),chosen=[],add=x=>{if(!x||seen.has(x.url)||chosen.length>=limit)return;seen.add(x.url);chosen.push(x.url)};
  const reserve=Math.max(1,Math.floor(limit/2));
  for(const x of freshLane){add(x);if(chosen.length>=reserve)break}
  for(const x of keywordLane)add(x);

  const recencySource=useTimestamp?'timestamp':'landing-order';
  pass=`${pass}+${recencySource}${force?'+unprocessed-first':''}`;

  const rejected=scored.filter(x=>!seen.has(x.url)).map(x=>({
    url:x.url,status:x.reason==='off-host'?'rejected-off-host':'rejected-low-score',
    score:x.score,time:x.time,seen:x.seen,index:x.index
  }));

  // Full rank trace for interrogation. No article text is exposed, only URLs
  // and selection metadata, so this is cheap and safe to retain in diagnostics.
  const ranked=scored
    .filter(x=>x.score>-99)
    .sort((a,b)=>unseenFirst(a,b)||b.score-a.score||a.index-b.index)
    .slice(0,80)
    .map(x=>({url:x.url,index:x.index,score:x.score,seen:x.seen,time:x.time,selected:seen.has(x.url),reason:x.reason}));

  return {
    candidates:chosen,rejected,ranked,pass,scoredCount:scored.length,
    timestampCoverage:Number(coverage.toFixed(2)),recencyUsed:true,recencySource,
    newCandidates:chosen.filter(u=>!seenUrls.has(u)).length,
    cachedCandidates:chosen.filter(u=>seenUrls.has(u)).length
  };
}

/* --------------------------------------------------------------- discovery */

async function discoverLanding(env,url,budget,{force=false,processedUrls=new Set()}={}){
  const record={
    source:url,mode:'fetch',linksFound:0,textChars:0,browserUsed:false,
    browserError:null,fetchError:null,timestampCoverage:0,recencyUsed:false,
    staticCandidates:0,staticUnprocessedCandidates:0,
    dynamicEscalated:false,dynamicEscalationReason:null
  };
  let landing=null;

  try{
    landing=await fetchPage(url);
    record.mode=landing.mode;
    record.linksFound=landing.links.length;
    record.textChars=landing.text.length;
    record.source=landing.url;
    record.timestampCoverage=Number(landing.timestampCoverage||0);
  }catch(e){
    record.fetchError=`${e.kind||'error'}: ${e.message}`;
  }

  const host=hostOf(landing?.url||url);
  const year=new Date().getUTCFullYear();
  const staticEligible=(landing?.links||[]).filter(l=>scoreLink(l,host,year).score>1);
  const candidateCount=staticEligible.length;
  const staticUnprocessed=staticEligible.filter(l=>!processedUrls.has(l)).length;
  record.candidatesFromFetch=candidateCount;
  record.staticCandidates=candidateCount;
  record.staticUnprocessedCandidates=staticUnprocessed;

  // A manual Fresh Live Scan has a stronger contract than a background fetch.
  // If static HTML yields no new processable URLs OR no usable publication
  // coverage, render the landing page with JavaScript before declaring it fresh.
  // Cloudflare recommends Browser Run /content + networkidle for JS-heavy pages.
  let escalationReason=null;
  if(!landing)escalationReason='static-fetch-failed';
  else if(candidateCount===0)escalationReason='no-static-candidates';
  else if(landing.text.length<LANDING_MIN_CHARS)escalationReason='static-shell';
  else if(force&&staticUnprocessed===0)escalationReason='forced-scan-no-unprocessed-links';
  else if(force&&Number(landing.timestampCoverage||0)<RECENCY_COVERAGE_MIN)escalationReason='forced-scan-low-date-coverage';

  const needsBrowser=!!escalationReason;
  record.dynamicEscalationReason=escalationReason;

  if(needsBrowser){
    if(budget.canBrowse(env)){
      try{
        const rendered=await browserRender(env,landing?.url||url,budget);
        record.browserUsed=true;
        record.dynamicEscalated=true;
        record.mode=rendered.mode;

        // Prefer rendered DOM order while preserving any useful static links.
        // Rendered links come FIRST because their order reflects the page the
        // user actually sees after JavaScript executes.
        const mergedLinks=[...new Set([...(rendered.links||[]),...(landing?.links||[])])];
        landing={
          url:rendered.url,
          text:rendered.text.length>=(landing?.text.length||0)?rendered.text:(landing?.text||''),
          links:mergedLinks,
          timeSources:new Map([...(landing?.timeSources?.entries?.()||[]),...(rendered.timeSources?.entries?.()||[])]),
          times:new Map([...(landing?.times?.entries?.()||[]),...(rendered.times?.entries?.()||[])]),
          timestampCoverage:Math.max(Number(landing?.timestampCoverage||0),Number(rendered.timestampCoverage||0)),
          mode:rendered.mode,status:200,redirected:false
        };
        record.linksFound=landing.links.length;
        record.textChars=landing.text.length;
        record.timestampCoverage=Number(landing.timestampCoverage||0);

        const renderedEligible=landing.links.filter(l=>scoreLink(l,hostOf(landing.url),year).score>1);
        record.renderedCandidates=renderedEligible.length;
        record.renderedUnprocessedCandidates=renderedEligible.filter(l=>!processedUrls.has(l)).length;
      }catch(e){
        record.browserError=e?.message||String(e);
      }
    }else{
      record.browserError=!env.BROWSER?.quickAction
        ? 'Browser Run binding unavailable'
        : (budget.quotaExhausted?'Browser Run daily allowance exhausted':'per-scan browser budget reached');
    }
  }

  if(!landing)return {landing:null,record};
  return {landing,record};
}

/* ---------------------------------------------------------- article reading */

async function readArticle(env,url,budget,{force=false}={}){
  const entry={url,status:'pending',mode:null,chars:0,httpStatus:null,error:null,browserUsed:false,cached:false,revalidated:false,mutable:isMutableArticleUrl(url)};
  let hit=null;
  try{hit=await env.ROLE_KV.get(articleKey(url),'json')}catch{}

  // Long-lived immutable articles can be served directly. Mutable operational
  // news is short-lived and a manual Fresh Scan always revalidates it.
  const usableCache=await cachedArticle(env,url,{force});
  if(usableCache){
    entry.status='cached';entry.mode=usableCache.mode||'cache';entry.cachedAt=usableCache.fetchedAt||null;entry.chars=usableCache.text.length;entry.cached=true;entry.publishedAt=usableCache.publishedAt||null;entry.dateSource=usableCache.dateSource||null;
    return {doc:{url,text:usableCache.text,mode:'cache',status:200,publishedAt:usableCache.publishedAt||null,dateSource:usableCache.dateSource||null,etag:usableCache.etag||null,lastModified:usableCache.lastModified||null},entry};
  }

  let page=null;
  try{
    page=await fetchPage(url,{etag:hit?.etag||null,lastModified:hit?.lastModified||null});
    if(page.notModified && hit?.text){
      const refreshed={...hit,fetchedAt:new Date().toISOString(),etag:page.etag||hit.etag||null,lastModified:page.lastModified||hit.lastModified||null};
      await env.ROLE_KV.put(articleKey(url),JSON.stringify(refreshed),{expirationTtl:60*60*24*ARTICLE_CACHE_DAYS});
      entry.status='revalidated-not-modified';entry.mode='fetch-304';entry.httpStatus=304;entry.chars=hit.text.length;entry.cached=true;entry.revalidated=true;entry.publishedAt=hit.publishedAt||null;entry.dateSource=hit.dateSource||null;
      return {doc:{url,text:hit.text,mode:'cache-revalidated',status:200,publishedAt:hit.publishedAt||null,dateSource:hit.dateSource||null,etag:refreshed.etag,lastModified:refreshed.lastModified},entry};
    }
    entry.httpStatus=page.status;entry.mode=page.mode;entry.chars=page.text.length;
    if(page.text.length>=ARTICLE_MIN_CHARS){
      entry.status='accepted';entry.publishedAt=page.publishedAt||null;entry.dateSource=page.dateSource||null;
      await storeArticle(env,url,page);
      return {doc:page,entry};
    }
    entry.status='thin';
  }catch(e){
    entry.error=`${e.kind||'error'}: ${e.message}`;entry.httpStatus=e.status??null;entry.status=e.kind==='blocked'?'blocked':'fetch-error';
  }

  if(budget.canBrowse(env)){
    try{
      // content gives us rendered HTML so we can recover both text AND article timestamp.
      const rendered=await browserRender(env,url,budget);
      entry.browserUsed=true;entry.mode=rendered.mode;entry.chars=rendered.text.length;
      if(rendered.text.length>=AI_MIN_DOC_CHARS){
        entry.status='accepted-browser';entry.publishedAt=rendered.publishedAt||page?.publishedAt||null;entry.dateSource=rendered.dateSource||page?.dateSource||null;
        if(!rendered.publishedAt&&page?.publishedAt)rendered.publishedAt=page.publishedAt;
        if(!rendered.dateSource&&page?.dateSource)rendered.dateSource=page.dateSource;
        await storeArticle(env,url,rendered);
        return {doc:rendered,entry};
      }
      entry.status='too-short';
      return {doc:rendered.text?rendered:null,entry};
    }catch(e){
      entry.browserUsed=true;entry.status=e.quotaExhausted?'browser-quota-exhausted':(e.rateLimited?'browser-rate-limited':'browser-error');
      entry.error=[entry.error,e?.message||String(e)].filter(Boolean).join(' | ');
      return {doc:page&&page.text?page:null,entry};
    }
  }

  if(!env.BROWSER?.quickAction){entry.status='deferred-no-browser';entry.error=entry.error||'Browser Run binding unavailable'}
  else if(budget.quotaExhausted){entry.status='deferred-browser-quota';entry.error=entry.error||'Browser Run daily allowance exhausted; this URL will be retried on a later scan'}
  else if(budget.expired()){entry.status='deferred-time-budget';entry.error=entry.error||'scan time budget reached; this URL will be retried on a later scan'}
  else{entry.status='deferred-browser-budget';entry.error=entry.error||`per-scan browser budget of ${budget.browserMax} reached; this URL will be retried on a later scan`}

  if(page&&page.text&&page.text.length>=AI_MIN_DOC_CHARS){entry.status='accepted-thin';return {doc:page,entry}}
  return {doc:null,entry};
}

/* ---------------------------------------------------------------- FPL data */

/* bootstrap-static is ~1.5MB. A cron sweep previously fetched and parsed it
   once per team plus once for calibration — six times per tick, ~9MB and six
   JSON.parse passes for data that changes at most a few times an hour.
   Memoised per isolate with a short TTL: correctness is unaffected because
   every consumer only reads player status, prices and event metadata. */
let BOOTSTRAP_MEMO = null;
const BOOTSTRAP_MEMO_MS = 90000;

async function getBootstrap(env){
  const now=Date.now();
  if(BOOTSTRAP_MEMO&&now-BOOTSTRAP_MEMO.at<BOOTSTRAP_MEMO_MS)return BOOTSTRAP_MEMO.data;
  const r=await fetch(FPL_BOOTSTRAP,{headers:{Accept:'application/json'}});
  if(!r.ok)throw new Error(`FPL bootstrap HTTP ${r.status}`);
  const data=await r.json();
  BOOTSTRAP_MEMO={at:now,data};
  return data;
}

async function fplContext(env,team){
  const data=await getBootstrap(env);const teamRow=(data.teams||[]).find(t=>teamCodeFromFplTeam(t)===team);
  if(!teamRow)throw new Error(`Club ${team} is not present in the current FPL bootstrap.`);
  const pos=Object.fromEntries((data.element_types||[]).map(x=>[x.id,x.singular_name_short]));
  const currentRound=Number((data.events||[]).find(e=>e.is_current)?.id)||Number((data.events||[]).filter(e=>e.finished).pop()?.id)||0;
  const players=(data.elements||[]).filter(p=>p.team===teamRow.id).map(p=>({id:p.id,name:p.web_name,fullName:`${p.first_name||''} ${p.second_name||''}`.trim(),fplPosition:pos[p.element_type]||'',status:p.status,chance:p.chance_of_playing_next_round,news:p.news||'',price:(p.now_cost||0)/10,minutes:p.minutes||0,starts:p.starts||0}));
  const key=`roster:${team}`;let previous=null;try{previous=JSON.parse(await env.ROLE_KV.get(key)||'null')}catch{}
  const current={team,teamName:teamRow.name,fetchedAt:new Date().toISOString(),currentRound,players};
  await env.ROLE_KV.put(key,JSON.stringify(current),{expirationTtl:60*60*24*120});
  const oldNames=new Set((previous?.players||[]).map(p=>normal(p.fullName||p.name))),newNames=new Set(players.map(p=>normal(p.fullName||p.name)));
  // With no previous snapshot there is nothing to diff against. Reporting the
  // entire squad as "added" is false, and worse, it enters the model prompt as
  // ROSTER ADDED and biases extraction toward signing events.
  if(!previous)return {current,previous:null,added:[],missing:[],currentRound};
  return {current,previous,currentRound,added:players.filter(p=>!oldNames.has(normal(p.fullName||p.name))),missing:(previous?.players||[]).filter(p=>!newNames.has(normal(p.fullName||p.name)))};
}

/* ------------------------------------------------ official club events */
// Official-club event classifier. The role model remains conservative; these
// events are a news/intelligence layer and only map into xMins when a current
// FPL player can be identified safely.

function titleCaseSlug(s){
  return String(s||'').split('-').filter(Boolean)
    .map(w=>w?w[0].toUpperCase()+w.slice(1):w).join(' ')
}
function headlineLines(doc){return splitLines(doc?.text).slice(0,20)}
function firstHeadline(doc){return headlineLines(doc)[0]||''}
function termHit(group,text){return (CLUB_TERMS[group]||[]).some(r=>r.test(text))}

function subjectFromHeadlineOrSlug(doc){
  for(const line of headlineLines(doc)){
    let m=line.match(/^(.{2,100}?)\s+(?:joins|signs for|completes (?:a )?move to|moves to|leaves|departs|pens new deal|signs new deal|signs new contract|extends contract)\b/i);
    if(m)return cleanText(m[1]).slice(0,100);
    m=line.match(/^(?:injury update|fitness update|team news):?\s*(.{2,100})$/i);
    if(m)return cleanText(m[1]).slice(0,100);
  }
  try{
    const slug=decodeURIComponent(new URL(doc.url).pathname.split('/').filter(Boolean).pop()||'');
    // Do not use "signs" alone to classify, but it is still useful for subject extraction.
    const m=slug.match(/^(.+?)-(?:joins?|signs?|signed|leaves?|departs?|completes?|moves?|pens?|extends?|returns?)(?:-|$)/i);
    return m?cleanText(titleCaseSlug(m[1])).slice(0,100):'';
  }catch{return ''}
}

function classifyClubEvent(doc,clubName){
  const lines=headlineLines(doc), headline=firstHeadline(doc);
  let path='';try{path=decodeURIComponent(new URL(doc.url).pathname).toLowerCase()}catch{}
  const body=String(doc.text||'').slice(0,9000),headlineHay=`${headline}\n${path}`,hay=`${headlineHay}\n${body}`;
  const club=normal(clubName);

  // 1) Headline/slug movement semantics outrank generic article-body wording.
  // This preserves true transfer stories even when the body says "head coach"
  // or "signed a new five-year contract".
  for(const line of lines.slice(0,4)){
    let mm=line.match(/^(.{2,100}?)\s+joins\s+(.{2,100}?)\s+on loan\b/i);
    if(mm)return normal(mm[2]).includes(club)
      ? {type:'loan_in',actionable:true,reason:'headline loan into current club'}
      : {type:'loan_out',actionable:true,reason:'headline loan to another club'};

    mm=line.match(/^(.{2,100}?)\s+joins\s+(.{2,100})$/i);
    if(mm)return normal(mm[2]).includes(club)
      ? {type:'signing',actionable:true,reason:'headline joins current club'}
      : {type:'departure',actionable:true,reason:'headline joins another club'};

    mm=line.match(/^(.{2,100}?)\s+signs\s+for\s+(.{2,100})$/i);
    if(mm)return normal(mm[2]).includes(club)
      ? {type:'signing',actionable:true,reason:'headline signs for current club'}
      : {type:'departure',actionable:true,reason:'headline signs for another club'};

    // "completes a move to X" / "moves to X" name a destination, exactly like
    // "joins X" and "signs for X" above, so direction must be resolved the
    // same way: compare the named destination against the club whose site is
    // being scanned. Treating this as unconditionally outbound was wrong --
    // a buying club's own announcement routinely opens with wording like
    // "Player has completed a move to Arsenal from Newcastle United", and
    // that sentence would have been misclassified as Arsenal's departure.
    mm=line.match(/\bcompletes?\s+(?:a\s+)?move\s+to\s+(.{2,100}?)(?:\s+from\s+.{2,100})?[.!]?$/i)
      ||line.match(/\bmoves?\s+to\s+(.{2,100}?)(?:\s+from\s+.{2,100})?[.!]?$/i);
    if(mm)return normal(mm[1]).includes(club)
      ? {type:'signing',actionable:true,reason:'headline/opening line: completes move to current club'}
      : {type:'departure',actionable:true,reason:'headline/opening line: completes move to another club'};

    // "leaves the club" / "departs the club" are genuinely self-referential --
    // "the club" always means whichever site is being read -- so these stay
    // unconditional, unlike the destination-naming patterns above.
    if(/\bleaves? the club\b|\bdeparts? the club\b/i.test(line))
      return {type:'departure',actionable:true,reason:'explicit outbound headline language'};

    if(/\b(?:new signing|joins us|has joined us|signs for us|arrives at|welcome to)\b/i.test(line))
      return {type:'signing',actionable:true,reason:'explicit inbound headline language'};
  }

  // 2) Contract renewal suppression is headline/slug-primary, not body-global.
  // "Player signs for Club" followed by "signed a five-year contract" is a transfer.
  if(termHit('renewal',headlineHay))
    return {type:'contract_renewal',actionable:false,reason:'headline/slug contract renewal or internal terms'};

  // 3) Staff/non-player suppression also requires headline/slug evidence.
  if(/\b(?:goalkeeping coach|head coach|assistant coach|academy manager|technical director|sporting director|chief executive|manager appointed|coach joins)\b/i.test(headlineHay))
    return {type:'non_player',actionable:false,reason:'headline/slug is a staff announcement'};

  if(/\b(?:partnership|sponsorship|commercial partner|rights deal|broadcast deal|kit deal|brand ambassador)\b/i.test(headlineHay))
    return {type:'non_player_signing',actionable:false,reason:'headline/slug commercial or non-player deal'};

  // 4) Body-confirmed loan movement.
  if(termHit('loan',hay)){
    if(/\b(?:returns?|returned|recalled)\s+(?:to\s+[\w .'-]+\s+)?from (?:a |his |her )?loan\b/i.test(hay) ||
       /\b(?:loan spell|loan deal) (?:has )?(?:ended|expired)\b/i.test(hay))
      return {type:'loan_return',actionable:true,reason:'loan return or recall'};
    if(/\bhas joined us on loan\b|\bjoins us on loan\b|\barrives? on loan\b/i.test(hay))
      return {type:'loan_in',actionable:true,reason:'explicit inbound loan language'};
    if(/\bhas joined [^.\n]{2,80} on (?:a |an )?(?:season-long )?loan\b|\bhas moved to [^.\n]{2,80} on loan\b/i.test(hay))
      return {type:'loan_out',actionable:true,reason:'explicit outbound loan language'};
  }

  // 5) Body-confirmed permanent transfer.
  if(/\bhas joined us\b|\bjoins us\b|\bjoined us from\b|\bhas signed for us\b|\bnew signing\b|\bwelcome to\b/i.test(hay))
    return {type:'signing',actionable:true,reason:'explicit inbound transfer language'};
  // Body-level destination language needs the same direction check as headlines.
  // This covers articles whose headline is generic but whose body says
  // "Player has completed a move to Arsenal from Newcastle United".
  let bodyMove=hay.match(/\bhas completed\s+(?:a\s+)?move\s+to\s+([^\.\n]{2,100}?)(?:\s+from\s+[^\.\n]{2,100})?(?:[\.\n]|$)/i)
    ||hay.match(/\bhas moved\s+to\s+([^\.\n]{2,100}?)(?:\s+from\s+[^\.\n]{2,100})?(?:[\.\n]|$)/i);
  if(bodyMove)return normal(bodyMove[1]).includes(club)
    ? {type:'signing',actionable:true,reason:'body confirms move to current club'}
    : {type:'departure',actionable:true,reason:'body confirms move to another club'};

  if(/\bhas left the club\b|\bhas left us\b|\bleaves? the club\b|\bdeparts? the club\b|\bhas joined [^.\n]{2,80} (?:on|in) a permanent transfer\b/i.test(hay))
    return {type:'departure',actionable:true,reason:'explicit outbound transfer language'};

  // 6) Operational football news classification stays broad.
  if(termHit('injuryOut',hay))return {type:'injury_status',actionable:false,reason:'official unavailable/injury language'};
  if(termHit('doubt',hay))return {type:'fitness_doubt',actionable:false,reason:'official doubt/assessment language'};
  if(termHit('return',hay))return {type:'fitness_return',actionable:false,reason:'official return/availability language'};
  if(termHit('selectionPositive',hay))return {type:'selection_signal',actionable:false,reason:'official selection/role language'};
  if(termHit('selectionNegative',hay))return {type:'selection_signal',actionable:false,reason:'official bench/rest language'};
  return {type:'unknown',actionable:false,reason:'insufficient event semantics'};
}

function clubEventLedgerKey(team){return `club-events:${team}`}
async function loadClubEventLedger(env,team){const row=await env.ROLE_KV.get(clubEventLedgerKey(team),'json');return Array.isArray(row?.events)?row.events:[]}
async function saveClubEventLedger(env,team,events){const seen=new Set(),merged=[];for(const e of (events||[]).sort((a,b)=>Date.parse(b.evidenceDate||0)-Date.parse(a.evidenceDate||0))){const k=e.id||[e.team,e.type,normal(e.subject),e.source].join('|');if(seen.has(k))continue;seen.add(k);merged.push(e);if(merged.length>=120)break}await env.ROLE_KV.put(clubEventLedgerKey(team),JSON.stringify({updatedAt:new Date().toISOString(),events:merged}),{expirationTtl:60*60*24*180})}
function clubEventCurrentWindowMs(e){
  const t=String(e?.type||'');
  return ['signing','departure','loan_in','loan_out','loan_return'].includes(t)?30*86400000:7*86400000;
}
function isCurrentClubEvent(e){
  const t=Date.parse(e?.evidenceDate||e?.detectedAt||e?.createdAt||'');
  // Unknown-age events stay in history but never remain "current" indefinitely.
  return Number.isFinite(t) ? (Date.now()-t)<=clubEventCurrentWindowMs(e) : false;
}

function fastPathClubEvents(team,clubName,documents){
  const out=[];
  for(const d of documents||[]){
    const tx=classifyClubEvent(d,clubName);
    // Only transaction types create fast-path clubEvents today. Injury/return/
    // selection signals continue through the AI/FPL pipelines to avoid duplicate
    // alerts in News, but are retained in diagnostics for taxonomy auditing.
    if(!['signing','departure','loan_in','loan_out','loan_return'].includes(tx.type))continue;

    const subject=subjectFromHeadlineOrSlug(d);
    if(!subject)continue;

    out.push({
      id:`club-${hashString([team,tx.type,subject,d.url].join('|'))}`,
      team,type:tx.type,subject,confidence:1,source:d.url,
      reason:`Official ${clubName} ${tx.type.replaceAll('_',' ')} announcement detected. Role/xMins impact remains separate until a current FPL player can be mapped safely.`,
      evidenceDate:Number(d.publishedAt)?new Date(Number(d.publishedAt)).toISOString():'',
      detectedAt:new Date().toISOString(),
      official:true,fastPath:true,classificationReason:tx.reason
    });
  }
  const seen=new Set();
  return out.filter(e=>{const k=[e.type,normal(e.subject),e.source].join('|');if(seen.has(k))return false;seen.add(k);return true});
}

/* ------------------------------------------------------------- extraction */

function extractionSchema(){return {
  type:'object',additionalProperties:false,required:['events'],properties:{events:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,
    required:['type','subject','affected','overlap','hierarchy','confidence','source','reason'],properties:{
      type:{type:'string',enum:[...EVENT_VALUES]},subject:{type:'string'},affected:{type:'string'},role:{type:'string',enum:[...ROLE_VALUES]},
      overlap:{type:'number',minimum:0,maximum:1},hierarchy:{type:'number',minimum:0,maximum:1},confidence:{type:'number',minimum:0,maximum:1},
      source:{type:'string'},reason:{type:'string'},evidenceDate:{type:'string'},
      minutesCap:{type:'number',minimum:0,maximum:90},
      directAvailability:{type:'number',minimum:0,maximum:1},
      selectionCertainty:{type:'number',minimum:0,maximum:1},
      productionImpact:{type:'number',minimum:-0.25,maximum:0.25},
      fixtureId:{type:'string'},competition:{type:'string'},kickoff:{type:'string'},gameweek:{type:'number',minimum:1,maximum:60}
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
- Use observed_role ONLY for SELECTION or MINUTES language: started, named in the starting XI, played 90 minutes, was deployed at, lined up at, first choice, kept his place, benched, rested, substituted on/off, came off after X minutes. Repeated recent lineup evidence should be stronger than a single mention.
- GOALS, ASSISTS, AND PERFORMANCE QUALITY ARE NOT ROLE EVIDENCE. A player scoring, assisting, playing well, or being praised for a performance tells you nothing about expected minutes on its own. A substitute who scores must NOT produce an observed_role event. Only create an event from a goal or performance mention if the SAME text also states that the player started, or states the position he played in.
- Fixture lists, TV and "how to watch" guides, ticket news, kit launches, competition or quiz pages, and community or commercial stories contain no role evidence. Return no event from them even if current FPL players are named.
- Use departure/signing/injury/return for a competitor event and name the FPL player(s) whose minutes are likely affected.
- CONFIRMED LINEUPS: use confirmed_start when an official team sheet explicitly names a CURRENT FPL player in the starting XI; use confirmed_bench when it explicitly names that player among substitutes.
- MATCH SCOPE: when identifiable from the official text, include fixtureId, competition, kickoff and gameweek for match-specific evidence. Never invent these fields.
- DIRECT AVAILABILITY: use unavailable when the club/manager explicitly says a CURRENT FPL player is ruled out, unavailable, will miss the match, will not travel, or is ineligible. Use suspension for an explicit domestic suspension. These direct events affect the named player himself.
- FITNESS UNCERTAINTY: use fitness_doubt for doubtful, late fitness test, assessed tomorrow, touch-and-go, or similar uncertainty that clearly refers to a CURRENT FPL player.
- MINUTES RESTRICTION: use minutes_restricted only when the source explicitly limits a CURRENT FPL player's workload (for example 45 minutes, 60 minutes maximum, or not ready for 90). Set minutesCap only when supported.
- ROTATION: use rotation_warning only for direct manager/club language that materially warns of rotation/rest. Do not infer rotation merely from fixture congestion.
- TRANSFER SEMANTICS: signing means a player ARRIVING FROM ANOTHER CLUB. departure means a player LEAVING FOR ANOTHER CLUB. A player who "signs a new deal", "signs a new contract", "extends his contract", "renews", "agrees professional terms", or signs sponsorship/commercial terms is NOT a signing event and must produce NO signing/departure role event.
- LOAN SEMANTICS: loan_in means a player temporarily ARRIVING at the current club; loan_out means a current player temporarily LEAVING; a loan return/recall is not a permanent signing/departure. Never collapse loan movement into a permanent transfer.
- OFFICIAL FITNESS LANGUAGE: phrases such as ruled out, unavailable, sidelined, set to miss, back in training, resumed training, available for, doubtful, or chance of making the game are valid injury/return/minutes evidence when they clearly refer to a CURRENT FPL player.
- SELECTION LANGUAGE varies by club: starting XI, named in the XI, starts, kept his place, first choice, benched, rested, omitted, deployed at, lined up at, and played 90 are role/minutes evidence. Treat them semantically, not as raw keyword triggers.
- Do not infer a competitive xMins effect merely from a contract renewal. A renewal can be reported as news elsewhere, but it does not by itself change another player's expected minutes.
- Use manager_positive/manager_negative only for direct role/minutes language.
- affected MUST exactly match one CURRENT FPL player name from the list.
- For observed_role, subject and affected MUST be the SAME player: it records that THAT player was selected. If the text says a DIFFERENT player started in a position, that is a threat to the incumbent — use manager_negative or signing with the incumbent as affected, never observed_role.
- role is the football role involved, not the FPL position.
- Do not infer a transfer from roster absence alone. Roster absence is unresolved unless official text confirms it.
- Ignore vague rumours, fan opinion, historical stories, academy-only evidence, unrelated teams, and material older than 120 days unless it confirms a still-current transfer or injury status.
- A player's FPL position is not his football role. A DEF may legitimately be observed at RW, LW, AM or ST.
- For departure/injury events, affected is the beneficiary. For signing/return events, affected is the threatened incumbent. Do not apply an injury event to the injured player himself.
- Confirmed official statements: confidence 0.9-1.0. Repeated official preseason lineup evidence: 0.70-0.90. One ambiguous mention: <=0.55.
- overlap measures direct role competition. hierarchy measures expected selection strength of subject/role evidence.
- directAvailability is optional and only for direct availability evidence. Use 0 for definitely unavailable/suspended; use a supported intermediate probability only for explicit uncertainty; use 1 for explicitly available.
- selectionCertainty is optional and only for confirmed lineup or explicit start/bench language.
- productionImpact is optional and should normally be 0. Use a small non-zero value only when the source explicitly establishes a sustained tactical role that plausibly changes per-minute production.
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
  const canonicalUrl=u=>{try{const x=new URL(String(u||''));x.hash='';return x.toString()}catch{return String(u||'')}};
  const allowedExact=new Set([...allowedSources].map(canonicalUrl));
  const allowedHosts=new Set([...allowedSources].map(hostOf).filter(Boolean));
  for(const e of events||[]){const p=byName.get(normal(e.affected));if(!p||!EVENT_VALUES.has(e.type))continue;
    const roleOptional=['confirmed_start','confirmed_bench','unavailable','fitness_doubt','minutes_restricted','suspension'].includes(e.type);
    if(!roleOptional&&!ROLE_VALUES.has(e.role))continue;
    const eventRole=ROLE_VALUES.has(e.role)?e.role:null;
    // observed_role describes the subject's OWN selection, so subject and
    // affected must be the same player. When they differ the model has
    // described a competitor being selected, which is a threat to `affected`,
    // not a boost -- and the sign would come out backwards.
    if(e.type==='observed_role'&&normal(e.subject)&&normal(e.subject)!==normal(p.name)&&normal(e.subject)!==normal(p.fullName))continue;
    const source=String(e.source||'');if(!/^https?:\/\//i.test(source))continue;
    // Guard against a hallucinated URL: the citation must point at a document
    // that was actually supplied to the model.
    if(allowedHosts.size&&!allowedHosts.has(hostOf(source)))continue;
    if(allowedExact.size&&!allowedExact.has(canonicalUrl(source)))continue;
    if(e.type==='injury'&&normal(e.subject)===normal(p.name))continue;
    if(e.type==='loan_in'&&normal(e.subject)===normal(p.name))continue; // arrival threatens incumbent; affected is incumbent
    if(e.type==='loan_out'&&normal(e.subject)!==normal(p.name)&&normal(e.subject)!==normal(p.fullName))continue; // outbound loan should name departing current player
    if(['confirmed_start','confirmed_bench','unavailable','fitness_doubt','minutes_restricted','suspension'].includes(e.type)
       && normal(e.subject)!==normal(p.name)&&normal(e.subject)!==normal(p.fullName))continue;

    const evidenceTime=Date.parse(e.evidenceDate||'');if(Number.isFinite(evidenceTime)&&Date.now()-evidenceTime>120*86400000&&!['departure','signing'].includes(e.type))continue;
    const normalizedType=e.type==='loan_in'?'signing':(e.type==='loan_out'?'departure':e.type);
    const policy=EVIDENCE_POLICY[e.type]||EVIDENCE_POLICY[normalizedType]||{channel:'other',tier:4,halfLifeHours:168,ttlHours:336,maxMinuteImpact:8,direct:false};
    const evidenceDate=cleanText(e.evidenceDate).slice(0,40),evidenceMs=Date.parse(evidenceDate||''),effectiveMs=Number.isFinite(evidenceMs)?evidenceMs:Date.now();
    out.push({id:`auto-${hashString([team,normalizedType,e.subject,p.name,e.role,source,e.evidenceDate].join('|'))}`,createdAt:Date.now(),team,type:normalizedType,rawType:e.type,subject:cleanText(e.subject).slice(0,120),role:eventRole,affected:p.name,affectedApiId:p.id,overlap:clamp(e.overlap,0,1),hierarchy:clamp(e.hierarchy,0,1),confidence:clamp(e.confidence,0,1),source,reason:cleanText(e.reason).slice(0,320),evidenceDate,evidenceClass:policy.channel,authorityTier:policy.tier,sourceAuthority:.98,effectiveFrom:new Date(effectiveMs).toISOString(),expiresAt:new Date(effectiveMs+policy.ttlHours*3600000).toISOString(),halfLifeHours:policy.halfLifeHours,maxMinuteImpact:policy.maxMinuteImpact,directImpact:!!policy.direct,verificationStatus:'official-source',minutesCap:Number.isFinite(Number(e.minutesCap))?clamp(Number(e.minutesCap),0,90):null,directAvailability:Number.isFinite(Number(e.directAvailability))?clamp(Number(e.directAvailability),0,1):null,selectionCertainty:Number.isFinite(Number(e.selectionCertainty))?clamp(Number(e.selectionCertainty),0,1):null,productionImpact:Number.isFinite(Number(e.productionImpact))?clamp(Number(e.productionImpact),-.25,.25):0,fixtureId:cleanText(e.fixtureId).slice(0,80)||null,competition:cleanText(e.competition).slice(0,80)||null,kickoff:cleanText(e.kickoff).slice(0,40)||null,gameweek:Number.isFinite(Number(e.gameweek))?Number(e.gameweek):null,auto:true,worker:true,oop:(p.fplPosition==='DEF'&&['LW','RW','AM','ST'].includes(e.role))||(p.fplPosition==='MID'&&['FB','CB'].includes(e.role))});
  }
  const seen=new Set;return out.filter(e=>{const k=[e.type,normal(e.subject),normal(e.affected),e.role,e.source].join('|');if(seen.has(k))return false;seen.add(k);return true});
}

/* ---------------------------------------------------- calibration ledger */
// The log-odds coefficients in the frontend (observed_role +1.0, signing -1.2,
// and so on) are PRIORS. They can only become measurements by comparing what an
// event predicted against what the player actually did afterwards.
//
// One row is written per accepted event, capturing the player's cumulative
// minutes and starts AT THE MOMENT the event fired. After CALIB_WINDOW_ROUNDS
// gameweeks the row is resolved by diffing against the current bootstrap. The
// result is a dataset you can fit directly:
//     started ~ logit(p0) + type x (overlap . hierarchy . confidence)

const CALIB_WINDOW_ROUNDS = 2;
const CALIB_TTL_DAYS = 400;

function calibKey(id){return `calib:${id}`}

async function recordCalibrationRows(env,team,events,roster){
  const round=Number(roster.currentRound)||0;
  const byId=new Map(roster.current.players.map(p=>[p.id,p]));
  for(const e of events){
    try{
      if(await env.ROLE_KV.get(calibKey(e.id),'json'))continue;   // already logged
      const p=byId.get(e.affectedApiId);
      if(!p)continue;
      await env.ROLE_KV.put(calibKey(e.id),JSON.stringify({
        eventId:e.id,team,type:e.type,role:e.role,
        subject:e.subject,affected:e.affected,affectedApiId:e.affectedApiId,
        overlap:e.overlap,hierarchy:e.hierarchy,confidence:e.confidence,
        strength:Number((e.overlap*e.hierarchy*e.confidence).toFixed(4)),
        source:e.source,evidenceDate:e.evidenceDate,
        recordedAt:new Date().toISOString(),
        roundAtEvent:round,
        minutesAtEvent:p.minutes,startsAtEvent:p.starts,
        fplPositionAtEvent:p.fplPosition,
        resolved:false
      }),{expirationTtl:60*60*24*CALIB_TTL_DAYS});
    }catch{}
  }
}

/** Diffs due rows against the live bootstrap and writes the observed outcome. */
async function resolveCalibration(env,{limit=200}={}){
  const data=await getBootstrap(env);
  const round=Number((data.events||[]).find(e=>e.is_current)?.id)
    ||Number((data.events||[]).filter(e=>e.finished).pop()?.id)||0;
  const live=new Map((data.elements||[]).map(p=>[p.id,p]));

  const keys=(await env.ROLE_KV.list('calib:')).slice(0,limit);
  let resolved=0,pending=0,missing=0;

  for(const key of keys){
    const row=await env.ROLE_KV.get(key,'json');
    if(!row||row.resolved){continue}
    const elapsed=round-Number(row.roundAtEvent||0);
    if(elapsed<CALIB_WINDOW_ROUNDS){pending++;continue}
    const p=live.get(row.affectedApiId);
    if(!p){missing++;continue}

    const startsAfter=Math.max(0,(p.starts||0)-(row.startsAtEvent||0));
    const minutesAfter=Math.max(0,(p.minutes||0)-(row.minutesAtEvent||0));
    const out={...row,
      resolved:true,
      resolvedAt:new Date().toISOString(),
      roundAtResolve:round,
      roundsElapsed:elapsed,
      startsAfter,minutesAfter,
      // The two fitting targets.
      startRate:elapsed?Number((startsAfter/elapsed).toFixed(4)):null,
      minutesPerRound:elapsed?Number((minutesAfter/elapsed).toFixed(2)):null
    };
    await env.ROLE_KV.put(key,JSON.stringify(out),{expirationTtl:60*60*24*CALIB_TTL_DAYS});
    resolved++;
  }
  return {round,scanned:keys.length,resolved,pending,playerMissing:missing};
}

async function calibrationExport(env,{team=null,resolvedOnly=false}={}){
  const keys=await env.ROLE_KV.list('calib:');
  const rows=[];
  for(const key of keys){
    const row=await env.ROLE_KV.get(key,'json');
    if(!row)continue;
    if(team&&row.team!==team)continue;
    if(resolvedOnly&&!row.resolved)continue;
    rows.push(row);
  }
  rows.sort((a,b)=>String(a.recordedAt).localeCompare(String(b.recordedAt)));
  const done=rows.filter(r=>r.resolved);
  const byType={};
  for(const r of done){
    const t=byType[r.type]||(byType[r.type]={n:0,meanStartRate:0,meanStrength:0});
    t.n++;t.meanStartRate+=Number(r.startRate)||0;t.meanStrength+=Number(r.strength)||0;
  }
  for(const t of Object.values(byType)){
    t.meanStartRate=Number((t.meanStartRate/t.n).toFixed(3));
    t.meanStrength=Number((t.meanStrength/t.n).toFixed(3));
  }
  return {
    total:rows.length,resolved:done.length,pending:rows.length-done.length,
    // Rough guide only: a real fit needs the logistic regression described above.
    // 30+ resolved rows per event type before any coefficient is worth trusting.
    readyToFit:done.length>=50,
    byType,rows
  };
}



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
  const priorProcessed=await loadDiscoveryLedger(env,team);
  const seenUrls=new Set(priorProcessed);
  const processedThisScan=[];
  let linksFound=0,candidateCount=0,attempted=0;

  for(const source of club.urls){
    try{
      const {landing,record}=await discoverLanding(env,source,budget,{force,processedUrls:seenUrls});
      if(!landing){
        discovery.push({...record,linksFound:0,candidates:0,selectionPass:null});
        if(record.fetchError)errors.push(`${source}: ${record.fetchError}`);
        if(record.browserError)errors.push(`${source}: ${record.browserError}`);
        continue;
      }

      linksFound+=landing.links.length;

      const {candidates,rejected,ranked,pass,scoredCount,timestampCoverage,recencyUsed,recencySource,newCandidates,cachedCandidates}=selectArticleLinks(landing.url,landing.links,max,landing.times||new Map(),landing.timestampCoverage||0,{seenUrls,force});
      candidateCount+=candidates.length;
      const candidateTimes=new Map(candidates.map(u=>[u,Number(landing.times?.get?.(u))||null]));

      discovery.push({
        source:landing.url,
        mode:landing.mode,
        linksFound:landing.links.length,
        linksScored:scoredCount,
        candidates:candidates.length,
        selectionPass:candidates.length?pass:'none',
        timestampCoverage,
        recencyUsed,
        recencySource,
        newCandidates,
        cachedCandidates,
        selectedCandidates:candidates.map(u=>({url:u,publishedAt:candidateTimes.get(u)?new Date(candidateTimes.get(u)).toISOString():null,dateSource:landing.timeSources?.get?.(u)||null,previouslyProcessed:seenUrls.has(u)})),
        rankedCandidates:ranked,
        staticCandidates:record.staticCandidates,
        staticUnprocessedCandidates:record.staticUnprocessedCandidates,
        renderedCandidates:record.renderedCandidates??null,
        renderedUnprocessedCandidates:record.renderedUnprocessedCandidates??null,
        dynamicEscalated:record.dynamicEscalated,
        dynamicEscalationReason:record.dynamicEscalationReason,
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

      // Cached articles cost nothing, so read them before spending any budget.
      const cacheHits=await Promise.all(candidates.map(u=>cachedArticle(env,u,{force})));
      const ordered=[
        ...candidates.filter((u,i)=>cacheHits[i]),
        ...candidates.filter((u,i)=>!cacheHits[i])
      ];

      for(const url of ordered){
        attempted++;
        const {doc,entry}=await readArticle(env,url,budget,{force});
        const processedOk=!!(doc&&doc.text)&&['cached','revalidated-not-modified','accepted','accepted-browser','accepted-thin'].includes(entry.status);
        if(processedOk)processedThisScan.push(url);
        perUrl.push({...entry,kind:'article',processedOk});
        if(doc&&doc.text){const landingPublishedAt=candidateTimes.get(url)||null,articlePublishedAt=Number(doc.publishedAt)||null,publishedAt=articlePublishedAt||landingPublishedAt||null,dateSource=articlePublishedAt?(doc.dateSource||'article-page'):(landingPublishedAt?(landing.timeSources?.get?.(url)||'landing-page'):null);documents.push({...doc,kind:'article',publishedAt,dateSource,landingPublishedAt,articlePublishedAt});}
        if(entry.error)errors.push(`${url}: ${entry.error}`);
      }
    }catch(e){
      errors.push(`${source}: ${e?.message||String(e)}`);
    }
  }

  // Strip site furniture before anything is measured or sent to the model.
  // Documents are cached RAW, so improving this heuristic later costs no
  // re-rendering — the next scan simply strips better.
  const boilerplate=buildBoilerplateSet(documents);
  let boilerplateBefore=0,boilerplateAfter=0,strippedDocs=0;
  for(const d of documents){
    const r=stripBoilerplate(d.text,boilerplate);
    d.text=r.text;
    d.charsBefore=r.before;
    d.charsAfter=r.after;
    boilerplateBefore+=r.before;
    boilerplateAfter+=r.after;
    if(r.stripped)strippedDocs++;
  }
  for(const entry of perUrl){
    const match=documents.find(d=>d.url===entry.url);
    if(match)entry.charsAfterStrip=match.charsAfter;
  }

  const retrieved=documents.filter(d=>d.text&&d.text.length>0);
  const useful=documents.filter(d=>d.text&&d.text.length>=AI_MIN_DOC_CHARS);
  const articleDocs=useful.filter(d=>d.kind==='article');
  const currentClubEvents=fastPathClubEvents(team,club.name,articleDocs),priorClubEvents=await loadClubEventLedger(env,team);
  const clubEvents=[...currentClubEvents,...priorClubEvents].sort((a,b)=>Date.parse(b.evidenceDate||0)-Date.parse(a.evidenceDate||0)).filter((e,i,arr)=>arr.findIndex(x=>(x.id||[x.team,x.type,normal(x.subject),x.source].join('|'))===(e.id||[e.team,e.type,normal(e.subject),e.source].join('|')))===i).slice(0,120);
  try{await saveClubEventLedger(env,team,clubEvents)}catch{}
  const transactionDiagnostics=articleDocs.map(d=>{
    const tx=classifyClubEvent(d,club.name);
    return {url:d.url,type:tx.type,actionable:tx.actionable,reason:tx.reason};
  }).filter(x=>x.type!=='unknown');

  // Only run the model when at least one real article was read, and send ONLY
  // the articles. The landing page is a headline list whose every line recurs
  // across the site, so it survives boilerplate stripping intact and would
  // otherwise dominate the model input with ~26k chars of teasers.
  const modelInput=articleDocs;
  const raw=modelInput.length?await aiExtract(env,team,club.name,roster.current.players,modelInput,roster):[];
  const events=validateEvents(team,roster.current.players,raw,new Set(modelInput.map(d=>d.url)));

  const browserFallbackUsed=perUrl.some(x=>x.browserUsed)||discovery.some(d=>d.browserUsed);

  // ---- Evidence authority -------------------------------------------------
  // A scan is AUTHORITATIVE only if it read a meaningful share of the articles
  // it set out to read. Reading 1 of 8 because the browser allowance ran out is
  // NOT grounds for clearing evidence that an earlier full scan gathered.
  const coverage=attempted?articleDocs.length/attempted:0;
  const evidenceAuthoritative=articleDocs.length>0
    && !budget.quotaExhausted
    && (articleDocs.length>=3 || coverage>=0.5);
  const maxCarryMs=Math.max(1,Number(env.MAX_CARRY_DAYS)||7)*86400000;

  let finalEvents=events;
  let evidenceGeneratedAt=new Date().toISOString();
  let evidenceCarriedForward=false;
  let evidenceNote=evidenceAuthoritative
    ? `Evidence derived from ${articleDocs.length} of ${attempted} article document(s) read in this scan.`
    : (budget.quotaExhausted
        ? 'The Browser Run daily allowance was exhausted during this scan, so coverage was incomplete.'
        : `This scan read only ${articleDocs.length} of ${attempted} article document(s).`);

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
      evidenceNote=`Coverage was incomplete, so ${stillValid.length} evidence item(s) from ${ageDays} day(s) ago were retained rather than cleared`
        +(dropped?`; ${dropped} were dropped because the player is no longer in the club's FPL roster.`:'.');
    }else if(priorEvents.length){
      evidenceNote=withinCarryWindow
        ? 'Coverage was incomplete, and no previous evidence remained valid against the current roster.'
        : 'Coverage was incomplete, and the previous evidence has aged out of the carry-forward window.';
    }
  }

  try{await saveDiscoveryLedger(env,team,[...priorProcessed,...processedThisScan])}catch{}

  const payload={
    status:'ok',
    schemaVersion:SCHEMA_VERSION,
    workerBuild:WORKER_BUILD,
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
      browserBudget:budget.browserMax,
      browserRateLimitHits:budget.rateLimitHits,
      browserQuotaExhausted:budget.quotaExhausted,
      cacheHits:perUrl.filter(x=>x.cached).length,
      boilerplateLines:boilerplate.size,
      unsplittableDocuments:documents.filter(d=>d.text&&d.text.length>5000&&splitLines(d.text).length<3).length,
      charsBeforeStrip:boilerplateBefore,
      charsAfterStrip:boilerplateAfter,
      strippedDocuments:strippedDocs,
      strippedPct:boilerplateBefore?Number((100*(1-boilerplateAfter/boilerplateBefore)).toFixed(1)):0,
      coverage:Number(coverage.toFixed(2)),
      browserAvailable:!!env.BROWSER?.quickAction,
      elapsedMs:budget.elapsedMs,
      budgetExpired:budget.expired(),
      rawEvents:Array.isArray(raw)?raw.length:0,
      acceptedEvents:events.length,
      confirmedClubEvents:clubEvents.length,
      transactionDiagnostics:transactionDiagnostics.slice(0,30),
      suppressedContractRenewals:transactionDiagnostics.filter(x=>x.type==='contract_renewal').length,
      taxonomySignals:{
        loans:transactionDiagnostics.filter(x=>['loan_in','loan_out','loan_return'].includes(x.type)).length,
        injuryStatus:transactionDiagnostics.filter(x=>x.type==='injury_status').length,
        fitnessReturns:transactionDiagnostics.filter(x=>x.type==='fitness_return').length,
        fitnessDoubts:transactionDiagnostics.filter(x=>x.type==='fitness_doubt').length,
        selectionSignals:transactionDiagnostics.filter(x=>x.type==='selection_signal').length,
        nonPlayerSuppressed:transactionDiagnostics.filter(x=>['non_player','non_player_signing'].includes(x.type)).length
      },
      newCandidates:discovery.reduce((a,d)=>a+Number(d.newCandidates||0),0),
      cachedCandidates:discovery.reduce((a,d)=>a+Number(d.cachedCandidates||0),0),
      recencySource:discovery.some(d=>d.recencySource==='timestamp')?'timestamp':'landing-order',
      articleDatesRecovered:articleDocs.filter(d=>Number(d.articlePublishedAt)).length,
      landingDatesUsed:articleDocs.filter(d=>!Number(d.articlePublishedAt)&&Number(d.landingPublishedAt)).length,
      undatedArticleDocs:articleDocs.filter(d=>!Number(d.publishedAt)).length,
      failedCandidatesRetainedForRetry:perUrl.filter(x=>x.kind==='article'&&x.processedOk===false).length,
      mutableArticlesRevalidated:perUrl.filter(x=>x.revalidated).length,

      dynamicDiscoveryEscalated:discovery.some(d=>d.dynamicEscalated),
      dynamicEscalationReasons:[...new Set(discovery.map(d=>d.dynamicEscalationReason).filter(Boolean))],
      staticUnprocessedCandidates:discovery.reduce((a,d)=>a+Number(d.staticUnprocessedCandidates||0),0),
      renderedUnprocessedCandidates:discovery.reduce((a,d)=>a+Number(d.renderedUnprocessedCandidates||0),0),
      perUrl:perUrl.slice(0,60),
      eventsFromThisScan:events.length,
      evidenceAuthoritative,
      evidenceCarriedForward,
      timestampCoverage: discovery.length?Number((discovery.reduce((a,d)=>a+Number(d.timestampCoverage||0),0)/discovery.length).toFixed(2)):0,
      recencyRankingUsed: discovery.some(d=>d.recencyUsed),
      scanMode: force?'forced-live':'background',
      cacheState: 'MISS'
    },
    roster:{
      players:roster.current.players.length,
      added:roster.added.map(p=>p.name),
      missingUnresolved:roster.missing.map(p=>p.name)
    },
    clubEvents,
    events:finalEvents
  };

  // Log predictions for later calibration. Only events THIS scan produced —
  // carried-forward events were already logged when first discovered.
  if(events.length){try{await recordCalibrationRows(env,team,events,roster)}catch{}}

  await env.ROLE_KV.put(cacheKey,JSON.stringify(payload),{expirationTtl:60*60*24*14});
  return payload;
}

/* -------------------------------------------------------------- surfaces */

async function allLatest(env){const out={};for(const team of Object.keys(CLUB_SOURCES)){const x=await env.ROLE_KV.get(`latest:${team}`,'json');if(x)out[team]=x}return out}

function reportAgeMs(report){
  const t=Date.parse(report?.generatedAt||'');
  return Number.isFinite(t)?Math.max(0,Date.now()-t):Infinity;
}

/** Wraps scanTeam so two callers cannot burn the browser allowance twice on the
 *  same club. A blocked caller gets the cached report rather than an error. */
async function scanTeamGuarded(env,team){
  const lockToken=await acquireScanLock(env,team);
  if(!lockToken){
    const cached=await env.ROLE_KV.get(`latest:${team}`,'json');
    if(cached)return {...cached,status:'ok',scanLocked:true,scanExecuted:false,lockNote:'a scan for this club was already in progress',cache:'HIT',refreshing:true};
    throw new Error(`A scan for ${team} is already in progress. Try again shortly.`);
  }
  try{
    const report=await scanTeam(env,team,{force:true});
    return {...report,scanExecuted:true};
  }finally{
    await releaseScanLock(env,team,lockToken);
  }
}

async function cacheFirstTeamReport(env,team,ctx,{force=false}={}){
  team=String(team||'').toUpperCase();
  if(force)return scanTeamGuarded(env,team);

  const cached=await env.ROLE_KV.get(`latest:${team}`,'json');
  if(!cached)return scanTeamGuarded(env,team);

  const staleAfterMs=Math.max(15,Number(env.STALE_AFTER_MINUTES)||360)*60*1000;
  const stale=reportAgeMs(cached)>staleAfterMs;
  if(stale&&ctx?.waitUntil){
    ctx.waitUntil(scanTeamGuarded(env,team).catch(async error=>{
      await env.ROLE_KV.put(`error:${team}`,JSON.stringify({at:new Date().toISOString(),error:error?.message||String(error)}),{expirationTtl:86400});
    }));
  }
  return {...cached,cache:'HIT',stale,refreshing:stale};
}

/* ==================================================================
   MARKET PROBE  —  VERIFICATION ONLY
   ------------------------------------------------------------------
   Fetches EPL match odds, strips the bookmaker margin, and inverts the
   result into team goal expectations and clean-sheet probabilities.

   This is deliberately NOT wired into projections, and NOT wired into
   cron. It exists to answer three questions that documentation cannot:
     1. What does a call actually cost against the free quota?
     2. How many UK bookmakers really come back on the free tier?
     3. Do the recovered numbers look sane on live fixtures?

   It is inert unless MARKET_API_KEY is set, and admin-only regardless,
   so it cannot burn quota by accident.

   Only the h2h market is requested. The docs note that totals coverage
   is mainly a US-sports thing, and h2h alone is exactly identified:
   two free probabilities (H, D, A sum to 1) determine two unknowns
   (home and away goal expectation). Requesting one market also keeps
   the cost at 1 credit per call rather than 2.
   ================================================================== */

const MARKET_HOST = 'https://api.the-odds-api.com';
const MARKET_SPORT = 'soccer_epl';

/* Dixon-Coles low-score correction. Independent Poisson under-predicts
   0-0 and 1-1; rho < 0 pushes probability back into those scores. */
const DC_RHO = -0.03;
const MAX_GOALS = 12;

function mFact(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function mPois(k, l) { return Math.exp(-l) * Math.pow(l, k) / mFact(k); }

function dcTau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Full match outcome distribution from two goal expectations. */
function matchOutcomes(lh, la, rho = DC_RHO, M = MAX_GOALS) {
  let H = 0, D = 0, A = 0, csH = 0, csA = 0, o25 = 0;
  for (let x = 0; x <= M; x++) {
    for (let y = 0; y <= M; y++) {
      const p = mPois(x, lh) * mPois(y, la) * dcTau(x, y, lh, la, rho);
      if (x > y) H += p; else if (x === y) D += p; else A += p;
      if (y === 0) csH += p;          // home team keeps a clean sheet
      if (x === 0) csA += p;
      if (x + y > 2.5) o25 += p;
    }
  }
  const s = H + D + A || 1;
  return { H: H / s, D: D / s, A: A / s, csH: csH / s, csA: csA / s, over25: o25 / s };
}

/** Newton solve for the goal expectations implied by H/D/A. */
function invertToGoals(tH, tA) {
  let lh = 1.4, la = 1.2;
  for (let it = 0; it < 60; it++) {
    const o = matchOutcomes(lh, la);
    const eH = o.H - tH, eA = o.A - tA;
    if (Math.abs(eH) < 1e-9 && Math.abs(eA) < 1e-9) break;
    const h = 1e-4;
    const oh = matchOutcomes(lh + h, la), oa = matchOutcomes(lh, la + h);
    const j00 = (oh.H - o.H) / h, j01 = (oa.H - o.H) / h;
    const j10 = (oh.A - o.A) / h, j11 = (oa.A - o.A) / h;
    const det = j00 * j11 - j01 * j10;
    if (!det || !Number.isFinite(det)) break;
    lh -= (j11 * eH - j01 * eA) / det;
    la -= (-j10 * eH + j00 * eA) / det;
    lh = Math.max(.05, Math.min(6, lh));
    la = Math.max(.05, Math.min(6, la));
  }
  return { lh, la };
}

/** Naive margin removal: scale implied probabilities to sum to 1. */
function devigProportional(oH, oD, oA) {
  const q = [1 / oH, 1 / oD, 1 / oA], s = q[0] + q[1] + q[2];
  return { H: q[0] / s, D: q[1] / s, A: q[2] / s, overround: (s - 1) * 100 };
}

/** Shin: assumes a fraction z of volume is informed, which shifts margin
    away from longshots. Diverges most on lopsided fixtures, which is
    exactly where the naive method is worst. */
function devigShin(oH, oD, oA) {
  const q = [1 / oH, 1 / oD, 1 / oA], s = q[0] + q[1] + q[2];
  const probs = z => {
    const p = q.map(qi => (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / s) - z) / (2 * (1 - z)));
    const t = p[0] + p[1] + p[2];
    return { p, t };
  };
  let lo = 0, hi = .25;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (probs(mid).t > 1) lo = mid; else hi = mid;
  }
  const z = (lo + hi) / 2, { p, t } = probs(z);
  return { H: p[0] / t, D: p[1] / t, A: p[2] / t, z };
}

function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* Betting exchanges are peer-to-peer: they take commission on winnings
   rather than building margin into the price. Their overround is typically
   1-2% against 6-8% for a sportsbook, so there is far less margin to strip
   and the choice of de-vig method matters far less. The live probe measured
   6.35pp of clean-sheet disagreement between proportional and Shin on a
   lopsided fixture when pooling all 20 books — larger than most model
   improvements are worth. Preferring exchanges attacks that at source. */
const EXCHANGE_BOOKS = ['betfair_ex_uk', 'smarkets'];

/** Median price per outcome across a chosen subset of books.
    Median rather than mean so one stale book cannot skew the result. */
function consensusPrices(ev, only = null) {
  const home = [], draw = [], away = [], names = [];
  for (const bk of ev.bookmakers || []) {
    if (only && !only.includes(bk.key)) continue;
    const mkt = (bk.markets || []).find(m => m.key === 'h2h');
    if (!mkt) continue;
    const g = n => (mkt.outcomes || []).find(o => o.name === n)?.price;
    const h = g(ev.home_team), a = g(ev.away_team), d = g('Draw');
    if (!(h > 1 && a > 1 && d > 1)) continue;
    home.push(h); draw.push(d); away.push(a); names.push(bk.key);
  }
  return { h: median(home), d: median(draw), a: median(away), books: names };
}

/** Full de-vig + inversion for one price set. */
function analysePrices(px) {
  if (!(px.h && px.d && px.a)) return null;
  const prop = devigProportional(px.h, px.d, px.a);
  const shin = devigShin(px.h, px.d, px.a);
  const gP = invertToGoals(prop.H, prop.A);
  const gS = invertToGoals(shin.H, shin.A);
  const oP = matchOutcomes(gP.lh, gP.la);
  const oS = matchOutcomes(gS.lh, gS.la);
  return {
    books: px.books, bookCount: px.books.length,
    medianPrices: { home: px.h, draw: px.d, away: px.a },
    overroundPct: +prop.overround.toFixed(2),
    proportional: {
      H: +prop.H.toFixed(4), D: +prop.D.toFixed(4), A: +prop.A.toFixed(4),
      xgHome: +gP.lh.toFixed(3), xgAway: +gP.la.toFixed(3),
      csHome: +oP.csH.toFixed(4), csAway: +oP.csA.toFixed(4),
      over25: +oP.over25.toFixed(4)
    },
    shin: {
      z: +shin.z.toFixed(4),
      xgHome: +gS.lh.toFixed(3), xgAway: +gS.la.toFixed(3),
      csHome: +oS.csH.toFixed(4), csAway: +oS.csA.toFixed(4)
    },
    devigDivergencePP: +(Math.abs(oP.csH - oS.csH) * 100).toFixed(2),
    refitErrorPP: +(Math.max(
      Math.abs(oP.H - prop.H), Math.abs(oP.D - prop.D), Math.abs(oP.A - prop.A)
    ) * 100).toFixed(6)
  };
}

/* ---- team matching -------------------------------------------------
   The odds feed names teams in prose ("Nott'm Forest", "Man Utd"); the
   engine keys everything on three-letter codes. A silent mismatch would
   quietly drop a fixture from the blend and nobody would notice, so the
   matcher is explicit and every failure is reported. */
const MARKET_TEAM_ALIASES = {
  ARS:['arsenal'], AVL:['aston villa','villa'], BOU:['bournemouth','afc bournemouth'],
  BRE:['brentford'], BHA:['brighton','brighton and hove albion','brighton & hove albion'],
  CHE:['chelsea'], COV:['coventry','coventry city'], CRY:['crystal palace','palace'],
  EVE:['everton'], FUL:['fulham'], HUL:['hull','hull city'],
  IPS:['ipswich','ipswich town'], LEE:['leeds','leeds united'], LIV:['liverpool'],
  MCI:['manchester city','man city'], MUN:['manchester united','man utd','man united'],
  NEW:['newcastle','newcastle united'], NFO:['nottingham forest',"nott'm forest",'notts forest','forest'],
  SUN:['sunderland'], TOT:['tottenham','tottenham hotspur','spurs']
};

function normaliseTeamName(n) {
  return String(n || '').toLowerCase()
    .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/* Aliases are normalised too. Comparing a normalised input against a raw
   alias silently failed on "Nott'm Forest": the input became "nottm forest"
   while the alias still carried its apostrophe. */
const MARKET_ALIAS_INDEX = (() => {
  const idx = new Map();
  for (const [code, aliases] of Object.entries(MARKET_TEAM_ALIASES)) {
    for (const a of aliases) idx.set(normaliseTeamName(a), code);
  }
  return idx;
})();

function marketTeamCode(name) {
  const n = normaliseTeamName(name);
  if (!n) return null;
  const exact = MARKET_ALIAS_INDEX.get(n);
  if (exact) return exact;
  // Fallback: unique prefix match, so "coventry city fc" still resolves.
  const hits = new Set();
  for (const [alias, code] of MARKET_ALIAS_INDEX) {
    if (n.startsWith(alias) || alias.startsWith(n)) hits.add(code);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/* ---- cached public team data --------------------------------------
   Credits are the scarce resource, so only cron refreshes. User requests
   read the cache and never trigger a fetch. */
const MARKET_CACHE_KEY = 'market:teams';

function marketRefreshMinutes(env) {
  const v = Number(env.MARKET_REFRESH_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 180;   // 8/day -> 240/month
}
function marketDailyCap(env) {
  const v = Number(env.MARKET_DAILY_CAP);
  return Number.isFinite(v) && v >= 0 ? v : 12;
}

/** Derived team numbers only: no odds, no bookmaker names. */
function deriveTeamFixtures(probe) {
  const fixtures = [], unmatched = [];
  for (const f of probe.fixtures || []) {
    if (f.skipped) continue;
    const home = marketTeamCode(f.home), away = marketTeamCode(f.away);
    if (!home || !away) {
      unmatched.push({ home: f.home, away: f.away, resolvedHome: home, resolvedAway: away });
      continue;
    }
    fixtures.push({
      home, away, commence: f.commence, basis: f.primary,
      xgHome: f.xgHome, xgAway: f.xgAway,
      csHome: f.csHome, csAway: f.csAway,
      over25: f.over25
    });
  }
  return { fixtures, unmatched };
}

/**
 * Cron-only refresh. Respects a hard daily cap so a misconfigured
 * schedule cannot drain the monthly quota.
 */
async function refreshMarketData(env, now = Date.now()) {
  if (!env.MARKET_API_KEY) return { status: 'disabled' };

  const cached = await env.ROLE_KV.get(MARKET_CACHE_KEY, 'json');
  const ageMin = cached ? (now - Date.parse(cached.fetchedAt)) / 60000 : Infinity;
  if (ageMin < marketRefreshMinutes(env)) {
    return { status: 'fresh', ageMinutes: Math.round(ageMin) };
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const capKey = `market:calls:${day}`;
  const usedToday = Number(await env.ROLE_KV.get(capKey) || 0);
  if (usedToday >= marketDailyCap(env)) {
    return { status: 'capped', usedToday, cap: marketDailyCap(env) };
  }

  const probe = await marketProbe(env, { regions: 'uk' });
  if (probe.status !== 'ok') {
    return { status: 'error', detail: probe.status, httpStatus: probe.httpStatus || null };
  }

  await env.ROLE_KV.put(capKey, String(usedToday + 1), { expirationTtl: 172800 });

  const { fixtures, unmatched } = deriveTeamFixtures(probe);
  const payload = {
    fetchedAt: new Date(now).toISOString(),
    fixtureCount: fixtures.length,
    exchangeCoverage: probe.exchangeCoverage,
    devigDivergencePP: probe.devigDivergencePP,
    unmatched,
    fixtures
  };
  await env.ROLE_KV.put(MARKET_CACHE_KEY, JSON.stringify(payload), { expirationTtl: 604800 });
  return {
    status: 'refreshed', fixtures: fixtures.length,
    unmatched: unmatched.length, credits: probe.credits
  };
}

/**
 * Fetch, de-vig and invert. Returns diagnostics, never throws for
 * ordinary failures.
 */
async function marketProbe(env, { regions = 'uk' } = {}) {
  const key = env.MARKET_API_KEY;
  if (!key) return { status: 'disabled', reason: 'MARKET_API_KEY not set' };

  const url = `${MARKET_HOST}/v4/sports/${MARKET_SPORT}/odds`
    + `?regions=${encodeURIComponent(regions)}&markets=h2h&oddsFormat=decimal`
    + `&apiKey=${encodeURIComponent(key)}`;

  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    return { status: 'error', stage: 'fetch', error: e?.message || String(e) };
  }

  /* These headers are the whole point of the probe: they report the real
     quota cost rather than what the docs imply. */
  const credits = {
    used: res.headers.get('x-requests-used'),
    remaining: res.headers.get('x-requests-remaining'),
    lastCost: res.headers.get('x-requests-last')
  };

  if (!res.ok) {
    return {
      status: 'error', stage: 'http', httpStatus: res.status, credits,
      body: (await res.text()).slice(0, 400)
    };
  }

  let events;
  try { events = await res.json(); }
  catch (e) { return { status: 'error', stage: 'parse', credits, error: e?.message }; }

  if (!Array.isArray(events)) {
    return { status: 'error', stage: 'shape', credits, got: typeof events };
  }

  const allBooksSeen = new Set();
  const fixtures = [];

  for (const ev of events) {
    const allPx = consensusPrices(ev);
    const exPx = consensusPrices(ev, EXCHANGE_BOOKS);
    allPx.books.forEach(b => allBooksSeen.add(b));

    const all = analysePrices(allPx);
    const exch = analysePrices(exPx);

    if (!all && !exch) {
      fixtures.push({
        home: ev.home_team, away: ev.away_team, commence: ev.commence_time,
        skipped: 'no usable h2h prices', bookCount: allPx.books.length
      });
      continue;
    }

    // Exchange prices win when available; soft-book median is the fallback.
    const primary = exch ? 'exchange' : 'allBooks';
    const use = exch || all;

    fixtures.push({
      home: ev.home_team, away: ev.away_team, commence: ev.commence_time,
      primary,
      xgHome: use.proportional.xgHome, xgAway: use.proportional.xgAway,
      csHome: use.proportional.csHome, csAway: use.proportional.csAway,
      over25: use.proportional.over25,
      devigDivergencePP: use.devigDivergencePP,
      refitErrorPP: use.refitErrorPP,
      // Both sets retained so the exchange gain is visible without a
      // second call, which would cost another credit.
      consensus: { exchange: exch, allBooks: all }
    });
  }

  const scored = fixtures.filter(f => !f.skipped);
  const mx = (arr, f) => arr.length ? Math.max(...arr.map(f)) : null;
  const withEx = scored.filter(f => f.consensus.exchange);
  const withAll = scored.filter(f => f.consensus.allBooks);

  return {
    status: 'ok',
    sport: MARKET_SPORT,
    regions,
    credits,
    fetchedAt: new Date().toISOString(),
    eventCount: events.length,
    usableFixtures: scored.length,
    distinctBookmakers: [...allBooksSeen].sort(),
    bookmakerCount: allBooksSeen.size,
    exchangeCoverage: `${withEx.length}/${scored.length}`,
    // The headline comparison: does preferring exchanges shrink the
    // de-vig ambiguity that dominates the error budget?
    devigDivergencePP: {
      exchange: mx(withEx, f => f.consensus.exchange.devigDivergencePP),
      allBooks: mx(withAll, f => f.consensus.allBooks.devigDivergencePP)
    },
    medianOverroundPct: {
      exchange: median(withEx.map(f => f.consensus.exchange.overroundPct)),
      allBooks: median(withAll.map(f => f.consensus.allBooks.overroundPct))
    },
    maxRefitErrorPP: mx(scored, f => f.refitErrorPP),
    fixtures
  };
}

export default {
  async fetch(request,env,ctx){
    env = await withD1(env);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors(env)});
    const u=new URL(request.url);try{
      if(u.pathname==='/'||u.pathname==='/api/health')return json({status:'ok',service:'OTB Role Intelligence',workerBuild:WORKER_BUILD,schemaVersion:SCHEMA_VERSION,season:env.SEASON||'2026/27',teams:Object.keys(CLUB_SOURCES).length,browserAvailable:!!env.BROWSER?.quickAction,generatedAt:new Date().toISOString()},200,env);
      // Derived team numbers for the projection engine. Public and
      // read-only: it never triggers a fetch, so it cannot burn credits.
      if(u.pathname==='/api/market/teams'){
        const d=await env.ROLE_KV.get('market:teams','json');
        if(!d)return json({status:'ok',available:false,fixtures:[]},200,env);
        const ageMin=Math.round((Date.now()-Date.parse(d.fetchedAt))/60000);
        return json({status:'ok',available:true,ageMinutes:ageMin,...d},200,env);
      }
      if(!originAllowed(request,env))return json({status:'error',error:'origin not allowed'},403,env);

      if(u.pathname==='/api/role-intelligence'||u.pathname.startsWith('/api/scout/team/')){
        const pathTeam=u.pathname.startsWith('/api/scout/team/')?u.pathname.split('/').filter(Boolean).pop():null;
        const team=String(u.searchParams.get('team')||pathTeam||'').toUpperCase();
        if(!team)return json({error:'team is required'},400,env);
        if(!CLUB_SOURCES[team])return json({error:`unsupported team code: ${team}`},400,env);
        const force=u.searchParams.get('force')==='1'||u.searchParams.get('fresh')==='1';
        if(force&&!adminAuthorised(request,env)){
          const gate=await forcedScanAllowed(env,team);
          if(!gate.allowed){
            // Never fail a user outright: serve what we have and explain.
            const cached=await env.ROLE_KV.get(`latest:${team}`,'json');
            if(cached)return json({status:'ok',forceThrottled:true,forceThrottleReason:gate.reason,retryAfterSec:gate.retryAfterSec,...cached,cache:'HIT'},200,env);
            return json({status:'error',error:gate.reason,retryAfterSec:gate.retryAfterSec},429,env);
          }
        }
        const result=await cacheFirstTeamReport(env,team,ctx,{force});
        if(force&&!adminAuthorised(request,env)&&result?.status==='ok'&&result?.scanExecuted===true&&!result?.forceThrottled)await noteForcedScan(env,team);
        return json(result,200,env);
      }
      if(u.pathname==='/api/role-sync'&&request.method==='POST'){
        if(!adminAuthorised(request,env))return json({status:'error',error:'unauthorised'},401,env);
        const body=await request.json().catch(()=>({}));if(!body.team)return json({error:'team is required'},400,env);
        return json(await scanTeamGuarded(env,String(body.team).toUpperCase()),200,env);
      }
      if(u.pathname==='/api/role-latest'){
        if(!adminAuthorised(request,env))return json({status:'error',error:'unauthorised'},401,env);
        return json({status:'ok',generatedAt:new Date().toISOString(),teams:await allLatest(env)},200,env);
      }
      if(u.pathname==='/api/scout/club-events'){
        const team=String(u.searchParams.get('team')||'').toUpperCase();
        const mode=String(u.searchParams.get('mode')||'current').toLowerCase();
        if(team){
          const report=await env.ROLE_KV.get(`latest:${team}`,'json'),history=Array.isArray(report?.clubEvents)?report.clubEvents:[],current=history.filter(isCurrentClubEvent);
          return json({status:'ok',team,generatedAt:report?.generatedAt||null,events:mode==='history'?history:current,current,historyCount:history.length},200,env)
        }
        const latest=await allLatest(env),history=[];for(const [code,report] of Object.entries(latest))for(const e of (report?.clubEvents||[]))history.push({...e,team:e.team||code});
        history.sort((a,b)=>Date.parse(b.evidenceDate||0)-Date.parse(a.evidenceDate||0));
        const current=history.filter(isCurrentClubEvent);
        return json({status:'ok',generatedAt:new Date().toISOString(),events:(mode==='history'?history:current).slice(0,100),current:current.slice(0,100),historyCount:history.length},200,env);
      }
      if(u.pathname==='/api/scout/interrogate'){
        const team=String(u.searchParams.get('team')||'').toUpperCase();
        if(!team)return json({error:'team is required'},400,env);
        const report=await env.ROLE_KV.get(`latest:${team}`,'json');
        if(!report)return json({status:'ok',team,report:null},200,env);
        const d=report.diagnostics||{};
        return json({
          status:'ok',team,
          schemaVersion:report.schemaVersion||SCHEMA_VERSION,
          workerBuild:report.workerBuild||null,
          generatedAt:report.generatedAt||null,
          cache:report.cache||null,
          summary:{
            candidates:d.candidates||0,articleDocuments:d.articleDocuments||0,
            cacheHits:d.cacheHits||0,newCandidates:d.newCandidates||0,
            cachedCandidates:d.cachedCandidates||0,
            recencySource:d.recencySource||null,
            timestampCoverage:d.timestampCoverage||0,
            dynamicDiscoveryEscalated:!!d.dynamicDiscoveryEscalated,
            dynamicEscalationReasons:d.dynamicEscalationReasons||[],
            staticUnprocessedCandidates:d.staticUnprocessedCandidates||0,
            renderedUnprocessedCandidates:d.renderedUnprocessedCandidates||0,
            confirmedClubEvents:d.confirmedClubEvents||0,
            acceptedEvents:d.acceptedEvents||0,
            scanExecuted:report.scanExecuted===true,
            scanLocked:report.scanLocked===true
          },
          discovery:(d.discovery||[]).map(x=>({
            source:x.source,mode:x.mode,linksFound:x.linksFound,
            selectionPass:x.selectionPass,timestampCoverage:x.timestampCoverage,
            recencySource:x.recencySource,newCandidates:x.newCandidates,
            cachedCandidates:x.cachedCandidates,dynamicEscalated:x.dynamicEscalated,
            dynamicEscalationReason:x.dynamicEscalationReason,
            staticCandidates:x.staticCandidates,
            staticUnprocessedCandidates:x.staticUnprocessedCandidates,
            renderedCandidates:x.renderedCandidates,
            renderedUnprocessedCandidates:x.renderedUnprocessedCandidates,
            selectedCandidates:x.selectedCandidates,
            rankedCandidates:x.rankedCandidates
          }))
        },200,env);
      }
      if(u.pathname==='/api/scout/diagnostics'){
        const team=String(u.searchParams.get('team')||'').toUpperCase();if(!team)return json({error:'team is required'},400,env);
        const report=await env.ROLE_KV.get(`latest:${team}`,'json');return json({status:'ok',team,report:report||null},200,env);
      }
      if(u.pathname==='/api/scout/calibration'){
        if(!adminAuthorised(request,env))return json({status:'error',error:'unauthorised'},401,env);
        const team=String(u.searchParams.get('team')||'').toUpperCase()||null;
        const resolvedOnly=u.searchParams.get('resolved')==='1';
        return json({status:'ok',windowRounds:CALIB_WINDOW_ROUNDS,...await calibrationExport(env,{team,resolvedOnly})},200,env);
      }
      if(u.pathname==='/api/scout/calibration/resolve'){
        // Mutating, so POST only: GET is fetched by crawlers and prefetchers.
        if(request.method!=='POST')return json({status:'error',error:'use POST'},405,env);
        if(!adminAuthorised(request,env))return json({status:'error',error:'unauthorised'},401,env);
        return json({status:'ok',...await resolveCalibration(env,{limit:Number(u.searchParams.get('limit'))||200})},200,env);
      }
      // Probe was an open SSRF and cost sink: arbitrary URLs went straight into
      // fetch and Browser Run. Now admin-only AND restricted to configured club
      // hosts, so it can only ever touch domains the scanner already visits.
      if(u.pathname==='/api/scout/probe'){
        if(!adminAuthorised(request,env))return json({status:'error',error:'unauthorised'},401,env);
        const target=u.searchParams.get('url');if(!target)return json({error:'url is required'},400,env);
        let parsed;try{parsed=new URL(target)}catch{return json({error:'url is not valid'},400,env)}
        if(parsed.protocol!=='https:')return json({error:'https is required'},400,env);
        const allowedHosts=new Set(Object.values(CLUB_SOURCES).flatMap(c=>c.urls.map(hostOf)));
        if(!allowedHosts.has(hostOf(target)))return json({error:'host is not a configured club source'},400,env);
        const budget=makeBudget(env);
        const {entry}=await readArticle(env,target,budget);
        return json({status:'ok',probe:entry,browserAvailable:!!env.BROWSER?.quickAction,browserCalls:budget.browserCalls},200,env);
      }
      // Market probe: admin-only, no cron, inert without MARKET_API_KEY.
      // Verification tool only - nothing downstream consumes it yet.
      if(u.pathname==='/api/market/probe'){
        if(!adminAuthorised(request,env))return json({status:'error',error:'unauthorised'},401,env);
        const regions=(u.searchParams.get('regions')||'uk').slice(0,32);
        return json(await marketProbe(env,{regions}),200,env);
      }
      return json({error:'not found'},404,env);
    }catch(e){return json({status:'error',error:e?.message||String(e),generatedAt:new Date().toISOString()},500,env)}
  },
  async scheduled(event,env,ctx){
    env = await withD1(env);
    ctx.waitUntil((async()=>{try{const mr=await refreshMarketData(env);if(mr.status!=='fresh'&&mr.status!=='disabled')await env.ROLE_KV.put('market:lastrun',JSON.stringify({at:new Date().toISOString(),...mr}),{expirationTtl:604800})}catch(e){await env.ROLE_KV.put('market:error',JSON.stringify({at:new Date().toISOString(),error:e?.message||String(e)}),{expirationTtl:604800})}
      try{await resolveCalibration(env,{limit:200})}catch{}const configured=Number(env.CRON_TEAMS_PER_RUN);
      // 0 must genuinely disable the sweep. The old expression was
      // Math.max(1,...Number(x)||1), so 0 became 1 and the documented
      // escape hatch did nothing.
      if(Number.isFinite(configured)&&configured<=0)return;
      const teams=Object.keys(CLUB_SOURCES),key='cron:cursor',cursor=Number(await env.ROLE_KV.get(key)||0),count=Math.min(4,Math.max(1,Number.isFinite(configured)?configured:4));for(let i=0;i<count;i++){const team=teams[(cursor+i)%teams.length];try{await scanTeamGuarded(env,team)}catch(e){await env.ROLE_KV.put(`error:${team}`,JSON.stringify({at:new Date().toISOString(),error:e.message}),{expirationTtl:86400})}}await env.ROLE_KV.put(key,String((cursor+count)%teams.length));})());
  }
};
