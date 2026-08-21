// OTB Role Intelligence + Fresh Squad Review Worker
// v2.25.3 — RC5.0.26 conservative evidence-quality hardening
// v2.25.1 — RC5.0.24 key-only Fresh Review authentication
// v2.25.0 — RC5.5.0 durable background review + per-user Access identity
// v2.24.1 — RC5.4.1 public football-name derivation from canonical FPL identity
// v2.24.0 — RC5.4.0 canonical identity, evidence coverage and category freshness
// v2.23.3 — RC5.3.3 evidence publisher and verdict consistency hardening
// v2.23.2 — RC5.3.2 decision recency gate and official-publisher recovery
// v2.23.1 — RC5.3.1 Cloudflare-safe public news search transport fallback
// v2.23.0 — RC5.3.0 authenticated, cached, source-ranked Fresh Squad Review
// v2.22.7 — RC5.2.7 source-read / evidence-authority contract separation
// v2.22.6 — RC5.2.6 order-tolerant rich-text extraction
// v2.22.5 — RC5.2.5 structured short-article acceptance
// v2.22.4 — RC5.2.4 discovery backfill cleanup
// v2.22.3 — RC5.2.3 Tottenham men's-feed isolation
// v2.22.2 — RC5.2.2 structured article-body recovery
// v2.22.1 — RC5.2.1 all-club discovery relevance follow-up
// v2.22 — RC5.2.0 all-club official article discovery hardening
// v2.21 — RC5.1.1 provider-neutral structured availability feed
// v2.19 — RC5.0.19 role-constraint guard: friendly evidence normalization and cache migration
// v2.11 — RC5.0.11 evidence-integrity hardening: source-owned dates, durable transactions, conservative competition mapping
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

import { WorkflowEntrypoint } from 'cloudflare:workers';

const FPL_BOOTSTRAP = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const SCHEMA_VERSION = '1.36.0';
// Single source of truth. This string was previously duplicated in the report
// payload and the /api/health response, which is exactly how a deployment
// smoke test ends up verifying one build while the other reports another.
const WORKER_BUILD = 'v2.33.0-rc5.0.36-doc-visibility';
// Public verification key for Marcus's signed Fresh Review owner capability.
// This is intentionally public: the Ed25519 private signing key and issued
// bearer capability never enter Worker configuration, Git history or HTML.
const FRESH_REVIEW_OWNER_PUBLIC_KEY = 'oNTbK-7hSt-KAWPoEsqzpgyNyMO1bJ5ewZlYk-Og9TM';

const AI_MIN_DOC_CHARS = 250;      // doc must have this much text to reach the model
const ARTICLE_MIN_CHARS = 900;     // below this, try the browser for a fuller body
const LANDING_MIN_CHARS = 800;     // below this, the landing page is a JS shell
const DEFAULT_BROWSER_BUDGET = 3;  // max Browser Run calls per scan (see notes: free tier = 3 new instances/min)
const DEFAULT_BROWSER_SPACING_MS = 2500; // Browser Run enforces a per-second fill rate, not a burst allowance
const DEFAULT_SCAN_BUDGET_MS = 45000;
const DEFAULT_AI_TIMEOUT_MS = 20000;
/* @cf/meta/llama-3.3-70b-instruct-fp8-fast has a 24,000 TOKEN context window,
   and that budget covers the response as well as the prompt. At ~3.5 chars per
   token, 48,000 characters of article text was ~13,700 tokens of documents
   alone, before ~2,600 tokens of rules -- leaving almost nothing for a reply
   and no margin for the constrained-decoding grammar. Sized so prompt plus a
   full response sits comfortably inside the window instead of against it. */
const AI_DOC_CHARS = 4500;
const AI_TOTAL_DOC_CHARS = 28000;
/* Workers AI defaults max_tokens to 256. The extraction schema permits up to
   30 events and ONE event costs roughly 150 tokens, most of it the source URL
   it is required to quote back verbatim. The model could not emit a populated
   response even when it found evidence: under a strict json_schema the
   shortest completion that satisfies the contract is {"events":[]}, which is
   exactly what came back -- eight articles, aiStatus ok, zero proposed. */
const AI_MAX_OUTPUT_TOKENS = 4000;
const BACKGROUND_SCAN_BUDGET_MS = 26000; // HTTP waitUntil is cancelled after 30s
const BACKGROUND_AI_TIMEOUT_MS = 7000;
const BACKGROUND_MAX_ARTICLES = 4;
const ARTICLE_CACHE_DAYS = 45;
const MUTABLE_CACHE_MINUTES = 90;
const MUTABLE_ARTICLE_RE = /(?:team-news|fitness-update|injury-update|press-conference|squad-news|starting-xi|confirmed-line-up|line-up|lineup|availability|ruled-out|doubtful|training|matchday-live|live-blog)/i;
// Relaxed discovery must still reject pages that can never be first-team
// editorial evidence. Keep this list path-segment specific: it surgically
// excludes legal/corporate boilerplate without changing the ranking of real
// club news pages.
const NON_ARTICLE_BOILERPLATE_RE = /(?:^|\/)(?:accessibility(?:-statement)?|msa-statement|modern-slavery(?:-act)?(?:-statement)?|privacy(?:-policy|-notice|-portal)?|terms(?:-of-use|-and-conditions)?|conditions-of-use|contact(?:-us)?|legal(?:-notice|-information)?|cookies?(?:-policy|-notice)?|corporate-(?:information|governance)|company-(?:information|details)|policies-and-reports|careers?|subscribe|partners?|about-us|club-information|attending-matches)(?:\/|$)/i;
const NON_ARTICLE_LISTING_RE = /(?:^|\/)(?:listing|category)(?:\/|$)|\/(?:all|latest)-(?:news|stories)(?:\/|$)|\/(?:news|mens-news|club-news|media-article\/news)\/?$|\/news\/(?:all|men|club|first-team|latest|top-stories)(?:\/\d+)?\/?$/i;
const NON_ARTICLE_ROSTER_RE = /(?:^|\/)(?:first-team-men-squad|mens-first-team-squad|players|teams|squad)(?:\/|$)/i;
const NON_ARTICLE_LOW_VALUE_RE = /how-to-watch|(?:^|\/)watch-|watch-live|live-stream|full-90|90-minutes|highlights?|gallery|photos|tv-guide|broadcast|listen-live|quiz|competition-|matchday-guide|where-to-watch|(?:^|[-\/])(?:third-)?kit(?:[-\/]|$)|shirt|retail|merchandise|programmes?|season-pass|tickets?|general-sale|now-on-sale|seat-move|loyalty-points|mascot|supporters?-club|fan-club|fantasy-premier-league-prices|fpl-prices|cup(?:-[a-z0-9]+){0,4}-draw|cup-games-confirmed|draw-details|will-face-either|round-(?:one|two|three|four|five|six|seven|\d+)-of-the-[a-z0-9-]*cup|fixture-details|fixtures?-confirmed|possible-opponents|partnership|sponsor|charity|giveaway|flutter|betting|beer|bratwurst/i;

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
const DISCOVERY_CANDIDATE_FLOOR = 6;
const SITEMAP_CACHE_SECONDS = 6*60*60;
const SITEMAP_MAX_BYTES = 4*1024*1024;
const SITEMAP_MAX_LINKS = 240;

/* ---------------------------------------------------------------- storage */

let TABLE_READY = false;

async function withD1(env) {
  // Unit and local integration harnesses may provide the storage adapter
  // directly. Production always reaches the D1 branch below.
  if(env?.ROLE_KV)return env;
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
  // Brighton's generic news route mixes men's, women's and academy content.
  // The men's feed is the official first-team surface and exposes structured
  // article records even when it does not render article anchors server-side.
  BHA:{name:'Brighton',urls:['https://www.brightonandhovealbion.com/latest-news-men']},
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
  // Tottenham's generic news surface mixes men's and women's cards whose
  // numeric article URLs do not encode the team. Use the club's own dedicated
  // men's first-team feed so ambiguous slugs never enter the Scout queue.
  TOT:{name:'Tottenham Hotspur',urls:['https://www.tottenhamhotspur.com/teams/mens/latest']}
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
const EVENT_VALUES = new Set(['observed_role','observed_bench','confirmed_start','confirmed_bench','unavailable','fitness_doubt','minutes_restricted','rotation_warning','suspension','departure','signing','loan_in','loan_out','injury','return','manager_positive','manager_negative']);

const EVIDENCE_POLICY = Object.freeze({
  confirmed_start:{channel:'lineup',tier:1,halfLifeHours:18,ttlHours:30,maxMinuteImpact:35,direct:true},
  confirmed_bench:{channel:'lineup',tier:1,halfLifeHours:18,ttlHours:30,maxMinuteImpact:35,direct:true},
  unavailable:{channel:'availability',tier:1,halfLifeHours:72,ttlHours:168,maxMinuteImpact:90,direct:true},
  suspension:{channel:'availability',tier:1,halfLifeHours:168,ttlHours:336,maxMinuteImpact:90,direct:true},
  minutes_restricted:{channel:'availability',tier:1,halfLifeHours:48,ttlHours:96,maxMinuteImpact:45,direct:true},
  fitness_doubt:{channel:'availability',tier:2,halfLifeHours:36,ttlHours:72,maxMinuteImpact:25,direct:true},
  observed_role:{channel:'selection',tier:2,halfLifeHours:240,ttlHours:720,maxMinuteImpact:12,direct:true},
  /* Mirror of observed_role. A non-start previously arrived as
     rotation_warning on the MANAGER channel, which retains only the single
     most recent event per player, so three consecutive benchings counted once
     while three starts counted three times. Same channel and decay, opposite
     sign, so the last three observations decide whichever way they point. */
  observed_bench:{channel:'selection',tier:2,halfLifeHours:240,ttlHours:720,maxMinuteImpact:12,direct:true},
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
  'Access-Control-Allow-Headers':'Content-Type,Authorization,X-OTB-Token',
  'Access-Control-Allow-Credentials':'true',
  'Vary':'Origin',
  'Cache-Control':'no-store'
}}
function json(data,status=200,env={}){return new Response(JSON.stringify(data,null,2),{status,headers:{'Content-Type':'application/json; charset=utf-8',...cors(env)}})}
function clamp(x,a,b){return Math.max(a,Math.min(b,Number(x)||0))}
function cleanText(s){return String(s||'').replace(/\s+/g,' ').trim()}
/** Collapses horizontal whitespace but KEEPS newlines — line structure is what
 *  makes cross-document boilerplate detection possible. */
function cleanLines(s){return String(s||'').replace(/[ \t\u00a0]+/g,' ').replace(/\n{2,}/g,'\n').split('\n').map(l=>l.trim()).filter(Boolean).join('\n')}
function normal(s){return cleanText(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'')}
function isMensFirstTeamSource(url,text=''){
  const u=String(url||'').toLowerCase();
  const t=normal(text||'');
  if(/(?:^|[-_/])(?:women'?s?|academy|[mw]?u21s?|[mw]?u18s?|[mw]?u19s?|[mw]?u23s?|under-21s?|under-18s?|under-23s?|girls?|ladies|lioness(?:es)?)(?:[-_/]|$)/.test(u))return false;
  if(/\bwomen'?s team\b|\bwomen'?s first team\b|\bwomen'?s side\b|\bgirls'? academy\b|\bacademy side\b|\bunder-23s?\b|\bunder-21s?\b|\bunder-18s?\b|\bu23s?\b|\bu21s?\b|\bu18s?\b|\bladies\b/.test(t))return false;
  return true;
}
function isAggregatorTransactionSource(url){
  let p='';try{p=decodeURIComponent(new URL(String(url||'')).pathname).toLowerCase()}catch{p=String(url||'').toLowerCase()}
  return /\/listing\/|\/news\/all(?:\/|$)|\/news\/?$|\/news\/men\/?$|\/mens-news\/?$|\/latest-news\/?$/.test(p);
}
function validTransactionSubject(subject){
  const s=cleanText(subject).trim();
  if(!s||s.length<2||s.length>80)return false;
  if(/^the\b/i.test(s)||/\bcapped by\b|\byears? old\b|\bunder-\d+\b|\bu-?\d+\b|\bteam\b|\bsquad\b|\bclub\b|\bplayer\b$/i.test(s))return false;
  // RC5.0.16 D-04: a JSON/metadata-leak fragment like 'title: "Caleb Yirenkyi'
  // was passing every check above -- short, letters present, no banned phrase
  // -- and produced a duplicate transaction fact under a different canonical
  // key from the clean 'Caleb Yirenkyi' extraction of the same signing.
  // Reject field-label prefixes, metadata punctuation and stray quotes while
  // preserving real internal apostrophes such as O'Riley or D'Angelo.
  if(/^[a-z_]{2,20}\s*:/i.test(s))return false;
  if(/["{}[\]<>]|https?:\/\//i.test(s))return false;
  if(/(^|[^\p{L}])'|'($|[^\p{L}])/u.test(s))return false;
  const words=s.split(/\s+/).filter(Boolean);
  if(words.length>6)return false;
  return words.some(w=>/[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]/.test(w));
}
function sourceHasSubjectTransaction(doc,subject){
  const ns=normal(subject), text=String(doc?.text||'');
  if(!ns||!text)return false;
  const lines=splitLines(text);
  const tx=/\bjoins?\b|\bsigns?(?: for)?\b|\bsigned\b|\bnew signing\b|\bnew recruit\b|\bnew arrival\b|\bcompletes? (?:a )?move\b|\bmoves? to\b|\bleaves?\b|\bdeparts?\b|\bhas left\b|\bon loan\b|\bloan move\b|\breturns? from loan\b/i;
  for(const line of lines){
    const nl=normal(line);
    if(nl.includes(ns)&&tx.test(line))return true;
  }
  try{
    const slug=normal(decodeURIComponent(new URL(doc.url).pathname.split('/').filter(Boolean).pop()||''));
    if(slug.includes(ns)&&tx.test(slug))return true;
  }catch{}
  return false;
}

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
      if(wait>0)await new Promise(r=>{setTimeout(r,wait)});
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

function bearerToken(request){
  return (request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
}

async function sha256Hex(value){
  const bytes=new TextEncoder().encode(String(value||''));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

function constantTimeEqual(a,b){
  a=String(a||'');b=String(b||'');
  if(a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

function base64UrlBytes(value){
  value=String(value||'');
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('invalid base64url');
  const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
  return Uint8Array.from(binary,ch=>ch.charCodeAt(0));
}

async function verifyFreshOwnerCapability(token,publicKey=FRESH_REVIEW_OWNER_PUBLIC_KEY,now=Math.floor(Date.now()/1000)){
  try{
    const parts=String(token||'').split('.');if(parts.length!==3)return false;
    const header=JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
    const payload=JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])));
    if(header.alg!=='EdDSA'||header.typ!=='JWT'||header.kid!=='otb-fresh-2026-01')return false;
    if(payload.iss!=='otb-owner'||payload.aud!=='otb-fresh-review'||payload.sub!=='marcus')return false;
    if(!Array.isArray(payload.scope)||!payload.scope.includes('fresh-review'))return false;
    if(!Number.isFinite(payload.iat)||!Number.isFinite(payload.nbf)||!Number.isFinite(payload.exp))return false;
    if(payload.nbf>now+30||payload.iat>now+300||payload.exp<=now||payload.exp-payload.iat>366*86400)return false;
    const key=await crypto.subtle.importKey('raw',base64UrlBytes(publicKey),{name:'Ed25519'},false,['verify']);
    return crypto.subtle.verify({name:'Ed25519'},key,base64UrlBytes(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
  }catch(e){return false}
}

let ACCESS_CERT_CACHE={issuer:'',expiresAt:0,keys:[]};
function accessIssuer(env){
  const raw=String(env.CF_ACCESS_TEAM_DOMAIN||'').trim().replace(/\/$/,'');
  if(!raw)return'';
  return /^https:\/\//i.test(raw)?raw:`https://${raw}`;
}
function csvSet(value){return new Set(String(value||'').split(/[\s,;]+/).map(x=>x.trim().toLowerCase()).filter(Boolean))}
function accessAudienceAllowed(payload,env){
  const expected=csvSet(env.CF_ACCESS_AUD),aud=Array.isArray(payload?.aud)?payload.aud:[payload?.aud];
  return expected.size>0&&aud.some(value=>expected.has(String(value||'').toLowerCase()));
}
async function accessJwks(env,issuer){
  if(ACCESS_CERT_CACHE.issuer===issuer&&ACCESS_CERT_CACHE.expiresAt>Date.now()&&ACCESS_CERT_CACHE.keys.length)return ACCESS_CERT_CACHE.keys;
  const response=await fetch(`${issuer}/cdn-cgi/access/certs`,{headers:{Accept:'application/json'},cf:{cacheTtl:600,cacheEverything:true}});
  if(!response.ok)throw new Error(`Cloudflare Access certs returned HTTP ${response.status}`);
  const body=await response.json(),keys=Array.isArray(body?.keys)?body.keys:[];
  if(!keys.length)throw new Error('Cloudflare Access certs did not contain keys');
  ACCESS_CERT_CACHE={issuer,expiresAt:Date.now()+10*60*1000,keys};return keys;
}
async function verifyAccessJwt(token,env,now=Math.floor(Date.now()/1000)){
  try{
    const issuer=accessIssuer(env);if(!issuer||!String(env.CF_ACCESS_AUD||'').trim())return null;
    const parts=String(token||'').split('.');if(parts.length!==3)return null;
    const header=JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0]))),payload=JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])));
    if(header.alg!=='RS256'||!header.kid||payload.iss!==issuer||!accessAudienceAllowed(payload,env))return null;
    if(!Number.isFinite(payload.exp)||payload.exp<=now||Number(payload.nbf||0)>now+30)return null;
    const email=String(payload.email||'').trim().toLowerCase();if(!email)return null;
    const allowed=csvSet(env.FRESH_REVIEW_ALLOWED_EMAILS);if(allowed.size&&!allowed.has(email))return null;
    const jwk=(await accessJwks(env,issuer)).find(item=>item.kid===header.kid);if(!jwk)return null;
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const valid=await crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5'},key,base64UrlBytes(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
    if(!valid)return null;
    const admins=csvSet(env.FRESH_REVIEW_ADMIN_EMAILS),actorHash=await sha256Hex(`access:${email}`);
    return{id:`access:${actorHash.slice(0,32)}`,email,role:admins.has(email)?'admin':'reviewer',mode:'cloudflare-access'};
  }catch{return null}
}

/** Access is the production identity boundary. The original signed owner
 * capability remains temporarily accepted so the private app cannot lock its
 * existing user out before the exact-email Access policy is activated. */
async function freshReviewIdentity(request,env){
  const adminExpected=String(env.SCOUT_ADMIN_TOKEN||''),adminSupplied=request.headers.get('x-otb-token')||bearerToken(request);
  if(adminExpected&&constantTimeEqual(adminSupplied,adminExpected))return{id:'worker-admin',email:null,role:'admin',mode:'worker-admin-token'};
  if(await verifyFreshOwnerCapability(bearerToken(request)))return{id:'legacy:marcus',email:null,role:'admin',mode:'signed-owner-transition'};
  return null;
}
async function freshReviewAuthorised(request,env){return Boolean(await freshReviewIdentity(request,env))}

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

/** Modern club sites commonly ship article cards in Nuxt/Next/Contentful
 *  application state instead of anchors. Extract only same-host editorial
 *  paths and feed them through the normal scorer; structured state never gets
 *  a bypass around the first-team, boilerplate or listing exclusions. */
function decodeEmbeddedMarkup(markup){
  return String(markup||'')
    .replace(/&quot;/gi,'"').replace(/&#(?:x27|39);/gi,"'").replace(/&amp;/gi,'&')
    .replace(/\\u002[fF]|\\x2[fF]/g,'/').replace(/\\u003[aA]|\\x3[aA]/g,':')
    .replace(/\\u0026|\\x26/g,'&').replaceAll('\\/','/');
}
function isEditorialDiscoveryPath(path=''){
  return /(?:^|\/)(?:news|article|articles|story|stories|media-article)(?:\/|$)/i.test(String(path||''));
}
function editorialDateFromUrl(url){
  let path='';try{path=decodeURIComponent(new URL(url).pathname).toLowerCase()}catch{return null}
  const months={january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11,jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
  const match=path.match(/\/(20\d{2})\/([a-z]+|\d{1,2})\/(\d{1,2})(?:\/|$)/i);
  if(!match)return null;
  const month=/^\d+$/.test(match[2])?Number(match[2])-1:months[match[2]];
  const year=Number(match[1]),day=Number(match[3]);
  if(!Number.isInteger(month)||month<0||month>11||day<1||day>31)return null;
  return Date.UTC(year,month,day);
}
function embeddedArticlePrefix(host){
  // Most publishers expose complete URLs. Brighton's Contentful state exposes
  // typed Article records as slugs; this is its stable public article route.
  return host==='brightonandhovealbion.com'?'/media-article/':'';
}
function extractEmbeddedArticleCards(markup,baseUrl){
  const raw=String(markup||''),decoded=decodeEmbeddedMarkup(raw);
  const links=[],times=new Map(),sources=new Map(),seen=new Set(),breakdown={jsonLd:0,urlFields:0,typedSlugs:0};
  const baseHost=hostOf(baseUrl);
  const add=(value,source,date=null,index=0)=>{
    const cleaned=cleanText(String(value||'')).replace(/^['"]|['"]$/g,'');
    if(!cleaned||cleaned.length>600||/^(?:data|javascript|mailto|tel):/i.test(cleaned))return;
    let u;try{u=new URL(cleaned,baseUrl)}catch{return}
    u.hash='';
    if(!u.protocol.startsWith('http')||hostOf(u.toString())!==baseHost)return;
    if(!isEditorialDiscoveryPath(u.pathname)||/(?:url\(|[<>{}"'\\])/.test(decodeURIComponent(u.pathname))||/\.(?:jpe?g|png|gif|webp|svg|mp4|webm|pdf|css|js|json|xml)$/i.test(u.pathname))return;
    const url=u.toString();
    if(!seen.has(url)&&links.length<SITEMAP_MAX_LINKS){seen.add(url);links.push(url);if(Object.hasOwn(breakdown,source))breakdown[source]++}
    const parsed=Date.parse(date||'');
    if(Number.isFinite(parsed)){const prior=times.get(url);if(!Number.isFinite(prior)||parsed>prior){times.set(url,parsed);sources.set(url,source==='jsonLd'?'json-ld':'embedded-article-state')}}
    // Chelsea embeds a media upload version close to each card. It is useful
    // for ordering only, and remains explicitly labelled as a fallback.
    if(!Number.isFinite(times.get(url))&&index){
      const nearby=decoded.slice(index,index+5000),mediaVersion=nearby.match(/\/image\/upload\/v(\d{10})(?:\/|$)/i);
      const mediaTime=Number(mediaVersion?.[1]||0)*1000;
      if(mediaTime>=Date.UTC(2020,0,1)&&mediaTime<=Date.now()+7*86400000){times.set(url,mediaTime);sources.set(url,'embedded-media-version')}
    }
  };

  // JSON-LD ItemLists are a high-quality cross-publisher article directory.
  const ldRe=/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while((match=ldRe.exec(raw))){
    let data;try{data=JSON.parse(match[1])}catch{continue}
    const walk=value=>{
      if(!value)return;
      if(Array.isArray(value)){value.forEach(walk);return}
      if(typeof value!=='object')return;
      const type=Array.isArray(value['@type'])?value['@type'].join(' '):String(value['@type']||'');
      const date=value.datePublished||value.dateCreated||value.dateModified||null;
      if(/NewsArticle|Article|BlogPosting|ListItem/i.test(type)){
        const item=typeof value.item==='object'?value.item:{};
        add(value.url||value['@id']||(typeof value.item==='string'?value.item:null)||item.url||item['@id']||value.mainEntityOfPage?.url||value.mainEntityOfPage?.['@id'],'jsonLd',date,match.index);
      }
      for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);
    };
    walk(data);
  }

  // JSON, devalue and assignment-style application state.
  const fieldRe=/(?:["']?(?:url|href|path|canonicalUrl|articleUrl|webUrl|uri)["']?)\s*[:=]\s*["']([^"']{2,600})["']/gi;
  while((match=fieldRe.exec(decoded))&&links.length<SITEMAP_MAX_LINKS)add(match[1],'urlFields',null,match.index);
  const literalRe=/["']((?:https?:\/\/|\/)[^"']{1,580}(?:\/news\/|\/article\/|\/media-article\/)[^"']{1,580})["']/gi;
  while((match=literalRe.exec(decoded))&&links.length<SITEMAP_MAX_LINKS)add(match[1],'urlFields',null,match.index);

  // Typed Contentful records can expose only a slug. Reconstruct the public
  // route only for hosts whose own page state establishes that route.
  const prefix=embeddedArticlePrefix(baseHost);
  if(prefix){
    const typedSlugRe=/([A-Za-z_$][\w$]*)\.slug\s*=\s*["']([^"']{2,180})["']\s*;\s*\1\.mediaType\s*=\s*["']Article["']/g;
    while((match=typedSlugRe.exec(decoded))&&links.length<SITEMAP_MAX_LINKS){
      const tail=decoded.slice(match.index,match.index+1400);
      const variable=match[1].replace(/[$]/g,'\\$&');
      const date=(tail.match(new RegExp(variable+'\\.publishDateTime\\s*=\\s*["\\\']([^"\\\']+)','i'))||[])[1]||null;
      add(prefix+match[2],'typedSlugs',date,match.index);
    }
    const objectSlugRe=/slug\s*:\s*["']([^"']{2,180})["'][\s\S]{0,240}?mediaType\s*:\s*["']Article["']/gi;
    while((match=objectSlugRe.exec(decoded))&&links.length<SITEMAP_MAX_LINKS){
      const nearby=decoded.slice(match.index,match.index+700);
      const date=(nearby.match(/publishDateTime\s*:\s*["']([^"']+)["']/i)||[])[1]||null;
      add(prefix+match[1],'typedSlugs',date,match.index);
    }
  }
  return {links,times,sources,breakdown};
}
function combineLandingSignals(markup,baseUrl,parsed,recency){
  const embedded=extractEmbeddedArticleCards(markup,baseUrl);
  const links=[...new Set([...(parsed.links||[]),...embedded.links])];
  // Explicit publisher dates outrank the media-upload fallback when both exist.
  const times=new Map([...embedded.times,...recency.times]);
  const timeSources=new Map([...embedded.sources,...recency.sources]);
  const coverageLinks=embedded.links.length?embedded.links:links;
  const timestampCoverage=coverageLinks.length
    ? coverageLinks.filter(url=>Number.isFinite(times.get(url))).length/coverageLinks.length
    : Number(recency.coverage||0);
  return {links,times,timeSources,timestampCoverage,embeddedCards:embedded.links.length,embeddedBreakdown:embedded.breakdown};
}
function extractPagePublicationFromHtml(markup,pageUrl=''){
  const html=String(markup||''),hits=[];
  const push=(raw,source,priority)=>{const t=Date.parse(raw||'');if(Number.isFinite(t))hits.push({t,source,priority})};
  let m;
  // Chelsea exposes the authoritative publication timestamp in HTML-escaped
  // application state rather than a meta tag or JSON-LD block.
  if(/\/news\/article\//i.test(String(pageUrl||''))){
    const decoded=html.replace(/&quot;/gi,'"').replace(/\\u002B/gi,'+');
    const embeddedPublishRe=/"content_publish_date"\s*:\s*"([^"]+)"/gi;
    while((m=embeddedPublishRe.exec(decoded)))push(m[1],'embedded:content_publish_date',0);
  }
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

/** Recover a current article's rich-text body from assignment-style SSR state.
 *  Yinzcam/Contentful pages expose typed records such as
 *  `a.slug=...;a.mediaType="Article";...;a.articleBody=...;a.tags=...`.
 *  The page slug and variable identity bound extraction to the requested
 *  article so related-card bodies cannot bleed into the document. */
function extractEmbeddedArticleBody(markup,pageUrl){
  let slug='';try{slug=decodeURIComponent(new URL(pageUrl).pathname.split('/').filter(Boolean).pop()||'')}catch{}
  if(!slug)return {text:'',publishedAt:null,dateSource:null};
  const decoded=decodeEmbeddedMarkup(markup),escapedSlug=slug.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const recordRe=new RegExp('([A-Za-z_$][\\w$]*)\\.slug\\s*=\\s*["\\\']'+escapedSlug+'["\\\']\\s*;\\s*\\1\\.mediaType\\s*=\\s*["\\\']Article["\\\']','g');
  let match;
  while((match=recordRe.exec(decoded))){
    const variable=match[1],escapedVariable=variable.replace(/[$]/g,'\\$&');
    const bodyStart=decoded.indexOf(variable+'.articleBody=',match.index);
    if(bodyStart<0||bodyStart-match.index>12000)continue;
    const tail=decoded.slice(bodyStart,bodyStart+70000);
    const tagsAt=tail.search(new RegExp(';'+escapedVariable+'\\.tags\\s*='));
    const returnAt=tail.search(/;return\s/);
    const endCandidates=[tagsAt,returnAt,60000].filter(index=>index>0);
    const body=tail.slice(0,Math.min(...endCandidates));
    const values=[];
    // Contentful serializers do not guarantee object-key order: both
    // `nodeType:"text",value:"..."` and `value:"...",nodeType:"text"`
    // occur on current club pages. Accept either ordering within the node.
    const textRe=/(?:nodeType\s*:\s*"text"\s*,\s*value\s*:\s*"((?:\\.|[^"\\])*)")|(?:value\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*nodeType\s*:\s*"text")/g;
    let textMatch;
    while((textMatch=textRe.exec(body))&&values.length<240){
      let value=textMatch[1]??textMatch[2]??'';
      try{value=JSON.parse('"'+value+'"')}catch{value=value.replace(/\\n/g,'\n').replace(/\\"/g,'"').replace(/\\'/g,"'")}
      value=cleanText(value);if(value)values.push(value);
    }
    const header=decoded.slice(match.index,bodyStart);
    const name=(header.match(new RegExp(escapedVariable+'\\.name\\s*=\\s*["\\\']([^"\\\']+)["\\\']','i'))||[])[1]||'';
    const publishedRaw=(header.match(new RegExp(escapedVariable+'\\.publishDateTime\\s*=\\s*["\\\']([^"\\\']+)["\\\']','i'))||[])[1]||'';
    const text=cleanLines([name,...values].filter(Boolean).join('\n')).slice(0,65000);
    const publishedAt=Date.parse(publishedRaw);
    if(text.length>=AI_MIN_DOC_CHARS)return {text,publishedAt:Number.isFinite(publishedAt)?publishedAt:null,dateSource:Number.isFinite(publishedAt)?'embedded-article-state:publishDateTime':null};
  }
  return {text:'',publishedAt:null,dateSource:null};
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
  const landing=combineLandingSignals(markup,r.url,parsed,recency);
  const pageDate=extractPagePublicationFromHtml(markup,r.url);
  const embeddedBody=extractEmbeddedArticleBody(markup,r.url);
  const text=embeddedBody.text?cleanLines(`${parsed.text}\n${embeddedBody.text}`).slice(0,65000):parsed.text;
  return {url:r.url,text,links:landing.links,times:landing.times,timeSources:landing.timeSources,timestampCoverage:landing.timestampCoverage,embeddedCards:landing.embeddedCards,embeddedBreakdown:landing.embeddedBreakdown,publishedAt:pageDate.publishedAt||embeddedBody.publishedAt,dateSource:pageDate.dateSource||embeddedBody.dateSource,etag:r.headers.get('etag')||null,lastModified:r.headers.get('last-modified')||null,mode:embeddedBody.text?'fetch-embedded-state':'fetch',status:r.status,redirected:r.url!==url};
}

/* ----------------------------------------------------- sitemap discovery */
// Sitemaps are a publisher-maintained directory, not an evidence source. They
// are consulted only when the normal landing page exposes too few article
// candidates, cached aggressively, and every URL still passes scoreLink.
function parseSitemapXml(xml,baseUrl){
  const body=String(xml||''),rows=[],childSitemaps=[];
  const decode=value=>String(value||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').trim();
  let match;
  const sitemapRe=/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
  while((match=sitemapRe.exec(body))){
    const raw=(match[1].match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)||[])[1];
    try{const url=new URL(decode(raw),baseUrl);url.hash='';if(hostOf(url.toString())===hostOf(baseUrl))childSitemaps.push(url.toString())}catch{}
  }
  const urlRe=/<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  while((match=urlRe.exec(body))){
    const raw=(match[1].match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)||[])[1];
    const date=(match[1].match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i)||[])[1]||null;
    try{
      const url=new URL(decode(raw),baseUrl);url.hash='';
      if(hostOf(url.toString())!==hostOf(baseUrl)||!isEditorialDiscoveryPath(url.pathname))continue;
      const lastmod=Date.parse(decode(date)),urlTime=editorialDateFromUrl(url.toString());
      const time=Number.isFinite(lastmod)?lastmod:urlTime;
      rows.push({url:url.toString(),time:Number.isFinite(time)?time:null,timeSource:Number.isFinite(lastmod)?'sitemap:lastmod':(Number.isFinite(urlTime)?'sitemap:url-date':null)});
    }catch{}
  }
  rows.sort((a,b)=>(Number(b.time)||0)-(Number(a.time)||0));
  return {rows:rows.slice(0,SITEMAP_MAX_LINKS),childSitemaps:[...new Set(childSitemaps)]};
}
async function fetchSitemapDocument(url){
  const response=await fetch(url,{headers:{
    'User-Agent':'OTB-Scout-AI/1.3 (+FPL research; contact via otb-role-intelligence.workers.dev)',
    'Accept':'application/xml,text/xml;q=0.9,*/*;q=0.2'
  },redirect:'follow'});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const length=Number(response.headers.get('content-length')||0);
  if(length>SITEMAP_MAX_BYTES){try{await response.body?.cancel()}catch{}throw new Error(`sitemap exceeds ${SITEMAP_MAX_BYTES} bytes`)}
  const type=(response.headers.get('content-type')||'').toLowerCase();
  if(!/(?:xml|text\/plain)/.test(type))throw new Error(`unsupported sitemap content-type: ${type||'unknown'}`);
  const body=await response.text();
  if(body.length>SITEMAP_MAX_BYTES)throw new Error(`sitemap exceeds ${SITEMAP_MAX_BYTES} bytes`);
  return {url:response.url,body};
}
async function sitemapSignals(env,baseUrl){
  const host=hostOf(baseUrl),key=`sitemap-discovery:v2:${host}`;
  try{
    const cached=await env.ROLE_KV.get(key,'json');
    if(Array.isArray(cached?.links))return {
      links:cached.links,times:new Map(cached.times||[]),sources:new Map(cached.timeSources||[]),
      cache:'HIT',documents:Number(cached.documents||1),error:null
    };
  }catch{}
  const root=new URL('/sitemap.xml',baseUrl).toString();
  try{
    const first=await fetchSitemapDocument(root),parsed=parseSitemapXml(first.body,first.url);
    let rows=parsed.rows,documents=1;
    if(!rows.length&&parsed.childSitemaps.length){
      const ordered=parsed.childSitemaps.slice().sort((a,b)=>{
        const ar=/news|article|post|story/i.test(a)?0:1,br=/news|article|post|story/i.test(b)?0:1;
        return ar-br;
      }).slice(0,2);
      const children=await Promise.allSettled(ordered.map(fetchSitemapDocument));
      for(const child of children){
        if(child.status!=='fulfilled')continue;
        documents++;
        rows.push(...parseSitemapXml(child.value.body,child.value.url).rows);
      }
      rows.sort((a,b)=>(Number(b.time)||0)-(Number(a.time)||0));
    }
    const byUrl=new Map();for(const row of rows)if(!byUrl.has(row.url))byUrl.set(row.url,row);
    const selected=[...byUrl.values()].slice(0,SITEMAP_MAX_LINKS),links=selected.map(row=>row.url);
    const timed=selected.filter(row=>Number.isFinite(row.time)),timeRows=timed.map(row=>[row.url,row.time]),timeSources=timed.map(row=>[row.url,row.timeSource||'sitemap:url-date']);
    try{await env.ROLE_KV.put(key,JSON.stringify({fetchedAt:new Date().toISOString(),documents,links,times:timeRows,timeSources}),{expirationTtl:SITEMAP_CACHE_SECONDS})}catch{}
    return {links,times:new Map(timeRows),sources:new Map(timeSources),cache:'MISS',documents,error:null};
  }catch(error){
    return {links:[],times:new Map(),sources:new Map(),cache:'MISS',documents:0,error:error?.message||String(error)};
  }
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
        await new Promise(r=>{setTimeout(r,Math.min(5000,budget.remainingMs()-2000))});
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
  const landing=combineLandingSignals(markup,url,parsed,recency);
  const pageDate=extractPagePublicationFromHtml(markup,url);
  return {url,text:parsed.text,links:landing.links,times:landing.times,timeSources:landing.timeSources,timestampCoverage:landing.timestampCoverage,embeddedCards:landing.embeddedCards,embeddedBreakdown:landing.embeddedBreakdown,publishedAt:pageDate.publishedAt,dateSource:pageDate.dateSource,mode:'browser-content',status:200,redirected:false};
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
    // RC5.2.2: Brighton's old browser cache entries contained only a short
    // shared shell. Re-fetch just those records so the structured-state body
    // extractor can replace them; do not invalidate healthy caches globally.
    if(hostOf(url)==='brightonandhovealbion.com'&&hit.mode==='browser-content'&&hit.text.length<1200)return null;
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
  if(/(?:url\(|[<>{}"'\\])/.test(p))return {score:-99,reason:'malformed-path'};
  if(/(?:^|\/)[a-z0-9-]+\.(?:co\.uk|com|org|net)(?:\/|$)/i.test(p))return {score:-99,reason:'malformed-path'};
  if(NON_ARTICLE_BOILERPLATE_RE.test(p))return {score:-99,reason:'boilerplate-path'};
  if(NON_ARTICLE_LISTING_RE.test(p)||NON_ARTICLE_ROSTER_RE.test(p))return {score:-99,reason:'listing-path'};
  if(NON_ARTICLE_LOW_VALUE_RE.test(p))return {score:-99,reason:'low-value-path'};
  if(!isMensFirstTeamSource(url,''))return {score:-99,reason:'non-mens-path'};
  if(/\/news\//.test(p))score+=7;
  // RC-fix Aug 2026: these keywords now sit inside \b...\b boundaries. Bare
  // substrings previously matched inside unrelated words -- e.g. `pens?`
  // matched "pen" inside "opening"/"reopening", and `sign(?:s|ed|ing)?`
  // matched "sign" inside "design"/"resign"/"assign" -- which handed a kit-
  // design or stadium-history feature a false positive editorial signal and
  // let it through the new candidate gate. Confirmed live: a forced Arsenal
  // rescan against this exact regex (pre-boundary) selected a stadium
  // opening-day retrospective solely because "opening" contains "pen".
  // RC-fix Aug 2026 (task #16): the relaxed-pass fallback can only ever be as
  // good as this vocabulary. Widened to cover recovery/fitness-boost and
  // squad-hierarchy phrasing (medical-update, fully-recovered, green-light,
  // contention, captain, ...) that genuine current news commonly uses but
  // which the original list -- built mostly around transfer/injury-onset
  // language -- missed, so a real "back in contention"-type article could
  // lose out to structurally-plausible junk in relaxed pass even after the
  // editorial gate landed.
  const editorialKeywordMatch=/\b(?:article|story|interview|press-conference|team-news|fitness-update|injury-update|medical-update|transfer|sign(?:s|ed|ing)?|joins?|join-|completes?|welcome|agree(?:s|d)?|announce(?:s|d|ment)?|departs?|leaves?|arrives?|seals?|pens?|commits?|extends?|new-deal|new-contract|loan|loan-deal|loan-move|returns?|back-in-training|available|unavailable|ruled-out|sidelined|doubtful|starting-xi|confirmed-line-up|line-up|lineup|squad-news|pre-season|preseason|friendly|match-report|injury|contract|fully-fit|fully-recovered|recovered|recovery|green-light|return-timeline|step-closer|closer-to-return|contention|captain|vice-captain|fitness-boost|boost)\b/.test(p);
  if(editorialKeywordMatch)score+=6;
  if(new RegExp(`/${currentYear}/`).test(p))score+=1;
  if(new RegExp(`/${currentYear-1}/`).test(p))score-=2;
  const depth=p.split('/').filter(Boolean).length;if(depth>=2)score+=1;
  if(/press-conference|injury-update|starting-xi|confirmed-line-up|team-news|squad-news/.test(p))score+=4;
  // Information-first Scout: pages that are legitimate club content but have
  // negligible first-team/FPL value must not consume the scarce article budget.
  if(/safeguard|disabled-support|supporters-association|gay-gooners|stadium-access|access-guide|ticketing-guide|membership|community|history|sustainability|advisory-board|local-residents|meeting-and-events|meetings-and-events|hospitality|commercial|partnership|sponsor|charity|foundation/.test(p))score-=24;

  if(/privacy|cookie|terms|ticket|shop|store|account|login|register|video|gallery|women|academy|hospitality|commercial|foundation|sitemap|contact/.test(p))score-=12;
  if(/preview|fixtures|highlights|\/watch-|watch--|match-gallery|photos/.test(p))score-=8;

  // Strong first-team editorial signals.
  const strongEditorialMatch=/\b(?:breaking-down|what-will-he-bring|ready-to-be-your|first-team|manager|press-conference|training|injury|fitness|team-news|squad-news|starting-xi|line-up|lineup|signing|new-signing|joins?|signed|transfer|loan|return)\b/.test(p);
  if(strongEditorialMatch)score+=8;
  if(p==='/'||/\/news\/?$/.test(p))score-=12;
  // RC-fix Aug 2026: the generic `/news/` (+7) and path-depth (+1) bonuses
  // above are, on their own, enough to clear the old score>1 bar with ZERO
  // genuine editorial keyword match -- meaning any not-yet-blocklisted junk
  // slug under /news/ (calendar tools, access guides, lifestyle features,
  // headshot/memorabilia pages, pagination hubs) could pass as a "candidate"
  // and permanently occupy the scarce per-club article budget. A URL must
  // now carry a real positive editorial signal to ever be treated as a
  // candidate, not just structural path shape.
  const editorial=editorialKeywordMatch||strongEditorialMatch;
  return {score,reason:(score>1&&editorial)?'candidate':'low-score',depth,editorial};
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

  // Strict pass requires BOTH a passing score and a genuine positive
  // editorial signal (see scoreLink) -- the generic /news/ + depth
  // structural bonus is not, by itself, enough to qualify a candidate.
  let selected=scored.filter(x=>x.score>1&&x.editorial),pass='strict';
  if(!selected.length){selected=scored.filter(x=>x.score>-99&&(x.depth||0)>=2&&x.score>-6);pass='relaxed'}

  // IMPORTANT: the relaxed pass must stay relaxed. v2.0 accidentally reapplied
  // score>1 here, which made "relaxed" effectively strict again.
  const eligible=pass==='relaxed'?selected:selected.filter(x=>x.score>1&&x.editorial);
  const coverage=Number(timestampCoverage)||0,useTimestamp=coverage>=RECENCY_COVERAGE_MIN;
  const unseenFirst=(a,b)=>(a.seen===b.seen?0:(a.seen?1:-1));
  // RC-fix Aug 2026 (task #16): in strict pass every item in `eligible`
  // already has editorial===true, so this is a no-op there. In RELAXED pass
  // (triggered only when strict pass finds zero editorial candidates in the
  // whole discovered set) `eligible` can mix genuine-but-lightly-penalised
  // editorial links with pure structural junk (calendar tools, merchandise
  // pages) that only cleared the relaxed floor on /news/ shape. Putting
  // editorial first here means a real "back in contention"/"medical update"
  // article that just missed the strict score bar still outranks junk,
  // instead of the fallback being purely structural-score-driven.
  const editorialFirst=(a,b)=>(b.editorial?1:0)-(a.editorial?1:0);

  // Freshness lane:
  //   1) editorial signal, when the pool is mixed (see above);
  //   2) timestamps, when enough are actually available;
  //   3) otherwise the publisher's rendered DOM order;
  // with never-processed URLs ahead of URLs already analysed.
  const freshLane=useTimestamp
    ? eligible.filter(x=>Number.isFinite(x.time)).sort((a,b)=>editorialFirst(a,b)||unseenFirst(a,b)||b.time-a.time||b.score-a.score||a.index-b.index)
    : eligible.slice().sort((a,b)=>editorialFirst(a,b)||unseenFirst(a,b)||a.index-b.index||b.score-a.score);
  const keywordLane=eligible.slice().sort((a,b)=>editorialFirst(a,b)||unseenFirst(a,b)||(useTimestamp?(Number(b.time)||0)-(Number(a.time)||0):0)||b.score-a.score||a.index-b.index);

  const seen=new Set(),chosen=[],add=x=>{if(!x||seen.has(x.url)||chosen.length>=limit)return;seen.add(x.url);chosen.push(x.url)};

  // Transaction/news priority lane. Reserve up to two places for URLs whose
  // slugs strongly indicate transfers, loans, availability or first-team role.
  const firstTeamEligible=eligible.filter(x=>isMensFirstTeamSource(x.url,''));
  const priorityLane=firstTeamEligible.filter(x=>/\b(?:signing|new-signing|joins?|signed|transfer|loan|departure|leaves?|returns?|injury|fitness|team-news|squad-news|starting-xi|line-up|lineup|breaking-down|what-will-he-bring|ready-to-be-your)\b/.test(decodeURIComponent(new URL(x.url).pathname).toLowerCase()))
    .sort((a,b)=>unseenFirst(a,b)||(useTimestamp?(Number(b.time)||0)-(Number(a.time)||0):0)||b.score-a.score||a.index-b.index);

  const unseenPriority=priorityLane.filter(x=>!x.seen);
  if(unseenPriority.length)add(unseenPriority[0]);

  const seenTransaction=priorityLane.find(x=>x.seen && /\b(?:signing|new-signing|joins?|signed|transfer|loan|departure|leaves?|returns?)\b/.test(decodeURIComponent(new URL(x.url).pathname).toLowerCase()));
  if(seenTransaction)add(seenTransaction);

  for(const x of priorityLane){
    if(chosen.length>=Math.min(2,limit))break;
    add(x);
  }

  const reserve=Math.max(1,Math.floor(limit/2));
  for(const x of freshLane){add(x);if(chosen.length>=reserve)break}
  for(const x of keywordLane)add(x);

  const recencySource=useTimestamp?'timestamp':'landing-order';
  pass=`${pass}+${recencySource}${force?'+unprocessed-first':''}`;

  const rejected=scored.filter(x=>!seen.has(x.url)).map(x=>({
    url:x.url,status:x.reason==='off-host'?'rejected-off-host':(x.reason==='boilerplate-path'?'rejected-boilerplate':(x.reason==='listing-path'?'rejected-listing':(x.reason==='low-value-path'?'rejected-low-value':(x.reason==='non-mens-path'?'rejected-non-mens':(x.reason==='malformed-path'?'rejected-malformed':'rejected-low-score'))))),
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
    embeddedCards:0,embeddedBreakdown:{jsonLd:0,urlFields:0,typedSlugs:0},
    sitemapUsed:false,sitemapCache:null,sitemapDocuments:0,sitemapLinks:0,sitemapCandidates:0,sitemapError:null,
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
    record.embeddedCards=Number(landing.embeddedCards||0);
    record.embeddedBreakdown=landing.embeddedBreakdown||record.embeddedBreakdown;
  }catch(e){
    record.fetchError=`${e.kind||'error'}: ${e.message}`;
  }

  const host=hostOf(landing?.url||url);
  const year=new Date().getUTCFullYear();
  const isEligible=(l,h)=>{const s=scoreLink(l,h,year);return s.score>1&&s.editorial};
  let staticEligible=(landing?.links||[]).filter(l=>isEligible(l,host));
  let candidateCount=staticEligible.length;
  let staticUnprocessed=staticEligible.filter(l=>!processedUrls.has(l)).length;
  record.candidatesFromFetch=candidateCount;
  record.staticCandidates=candidateCount;
  record.staticUnprocessedCandidates=staticUnprocessed;

  // A same-host sitemap is both cheaper and more deterministic than rendering
  // a JS shell. Consult it only when the landing/state extractor has too few
  // candidates, then let the normal scorer and selection lanes decide.
  if(landing&&candidateCount<DISCOVERY_CANDIDATE_FLOOR){
    const sitemap=await sitemapSignals(env,landing.url);
    record.sitemapCache=sitemap.cache;
    record.sitemapDocuments=sitemap.documents;
    record.sitemapLinks=sitemap.links.length;
    record.sitemapError=sitemap.error;
    if(sitemap.links.length){
      record.sitemapUsed=true;
      landing={
        ...landing,
        links:[...new Set([...(landing.links||[]),...sitemap.links])],
        times:new Map([...(landing.times?.entries?.()||[]),...sitemap.times]),
        timeSources:new Map([...(landing.timeSources?.entries?.()||[]),...sitemap.sources]),
        timestampCoverage:Math.max(Number(landing.timestampCoverage||0),sitemap.links.length?sitemap.times.size/sitemap.links.length:0)
      };
      staticEligible=landing.links.filter(l=>isEligible(l,hostOf(landing.url)));
      candidateCount=staticEligible.length;
      staticUnprocessed=staticEligible.filter(l=>!processedUrls.has(l)).length;
      record.sitemapCandidates=candidateCount-record.staticCandidates;
    }
  }

  // A manual Fresh Live Scan has a stronger contract than a background fetch.
  // If static HTML yields no new processable URLs OR no usable publication
  // coverage, render the landing page with JavaScript before declaring it fresh.
  // Cloudflare recommends Browser Run /content + networkidle for JS-heavy pages.
  let escalationReason=null;
  if(!landing)escalationReason='static-fetch-failed';
  else if(candidateCount===0)escalationReason='no-static-candidates';
  else if(landing.text.length<LANDING_MIN_CHARS&&candidateCount<DISCOVERY_CANDIDATE_FLOOR)escalationReason='static-shell';
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
        record.embeddedCards=Math.max(record.embeddedCards,Number(landing.embeddedCards||0));
        record.embeddedBreakdown=rendered.embeddedBreakdown||record.embeddedBreakdown;

        const renderedEligible=landing.links.filter(l=>isEligible(l,hostOf(landing.url)));
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

function fetchedArticleUsable(page){
  if(!page?.text)return false;
  if(page.text.length>=ARTICLE_MIN_CHARS)return true;
  // Assignment-style SSR state is the publisher's typed article record, not
  // an unverified page shell. Short transfer notices are legitimately below
  // 900 characters, so accept them at the normal evidence floor instead of
  // spending Browser calls that can only return the surrounding shared shell.
  return page.mode==='fetch-embedded-state'&&page.text.length>=AI_MIN_DOC_CHARS;
}

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
    if(fetchedArticleUsable(page)){
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

async function getBootstrap(){
  const now=Date.now();
  if(BOOTSTRAP_MEMO&&now-BOOTSTRAP_MEMO.at<BOOTSTRAP_MEMO_MS)return BOOTSTRAP_MEMO.data;
  const r=await fetch(FPL_BOOTSTRAP,{headers:{Accept:'application/json'}});
  if(!r.ok)throw new Error(`FPL bootstrap HTTP ${r.status}`);
  const data=await r.json();
  BOOTSTRAP_MEMO={at:now,data};
  return data;
}

async function fplContext(env,team){
  const data=await getBootstrap();const teamRow=(data.teams||[]).find(t=>teamCodeFromFplTeam(t)===team);
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

/** Resolve destination-bearing transfer language without guessing direction.
 *  The named destination is compared with the club whose official site is
 *  being scanned. This covers both buying-club and selling-club phrasing. */
function movementDestination(line){
  const s=String(line||'');
  const patterns=[
    /\b(?:has\s+)?complet(?:e|es|ed)\s+(?:(?:a|his|her|their)\s+)?(?:permanent\s+)?(?:transfer|move)\s+to\s+([^,.!;\n]{2,100})/i,
    /\b(?:has\s+)?(?:moved|moves?|transferred|transfers?)\s+to\s+([^,.!;\n]{2,100})/i,
    /\b(?:has\s+)?signed\s+for\s+([^,.!;\n]{2,100})/i
  ];
  for(const re of patterns){
    const match=s.match(re);
    if(match)return cleanText(match[1]).replace(/\s+from\s+.+$/i,'').trim();
  }
  return '';
}

function classifyClubEvent(doc,clubName){
  if(!isMensFirstTeamSource(doc?.url,doc?.text))return {type:'non_mens',actionable:false,reason:'non-men first-team source suppressed'};
  if(isAggregatorTransactionSource(doc?.url))return {type:'index_page',actionable:false,reason:'listing/index page cannot establish a transaction'};
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

    // "permanent transfer to X", "move to X" and "signs for X" all name a
    // destination. Chelsea's Chalobah announcement uses the first form.
    const destination=movementDestination(line);
    if(destination)return normal(destination).includes(club)
      ? {type:'signing',actionable:true,reason:'headline/opening line: completes move to current club'}
      : {type:'departure',actionable:true,reason:'headline/opening line: completes move to another club'};

    // Selling clubs frequently headline departures as "Player leaves Chelsea
    // for Como". This is self-evidently outbound even though neither generic
    // "leaves the club" nor "moves to" is present.
    const normalizedLine=normal(line);
    if(/\bleaves?\s+(?:us|the club)\b/i.test(line)
      ||normalizedLine.includes(`leaves ${club}`)
      ||normalizedLine.includes(`leave ${club}`))
      return {type:'departure',actionable:true,reason:'headline confirms departure from current club'};

    if(/\bdeparts? (?:from )?(?:us|the club)\b/i.test(line)
      ||normalizedLine.includes(`departs ${club}`)
      ||normalizedLine.includes(`departs from ${club}`))
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
  const bodyDestination=movementDestination(hay);
  if(bodyDestination)return normal(bodyDestination).includes(club)
    ? {type:'signing',actionable:true,reason:'body confirms move to current club'}
    : {type:'departure',actionable:true,reason:'body confirms move to another club'};

  if(/\bhas left the club\b|\bhas left us\b|\bleaves? the club\b|\bdeparts? the club\b|\bhas joined [^.\n]{2,80} (?:on|in) a permanent transfer\b/i.test(hay))
    return {type:'departure',actionable:true,reason:'explicit outbound transfer language'};


  // 5b) Transaction recovery from official follow-up content.
  // Clubs often stop using the original "joins/signs" headline after day one.
  // Subsequent official articles may say "our new signing", "summer signing",
  // "new recruit", "new number 39", etc. That is enough to preserve the FACT
  // of the transaction in News, but NOT enough to assign xMins to an incumbent.
  if(/\b(?:our|the club'?s?)\s+new signing\b|\bnew signing\b|\bsummer signing\b|\bnew recruit\b|\bnew arrival\b|\bour new number\s+\d+\b/i.test(hay))
    return {type:'signing',actionable:true,reason:'official follow-up confirms new signing'};
  if(/\bformer [^.]{2,60} player\b|\bafter leaving (?:us|the club)\b|\bdeparted (?:the club|us)\b|\bcompleted (?:a )?move away\b/i.test(hay))
    return {type:'departure',actionable:true,reason:'official follow-up confirms departure'};

  // 6) Operational football news classification stays broad.
  if(termHit('injuryOut',hay))return {type:'injury_status',actionable:false,reason:'official unavailable/injury language'};
  if(termHit('doubt',hay))return {type:'fitness_doubt',actionable:false,reason:'official doubt/assessment language'};
  if(termHit('return',hay))return {type:'fitness_return',actionable:false,reason:'official return/availability language'};
  if(termHit('selectionPositive',hay))return {type:'selection_signal',actionable:false,reason:'official selection/role language'};
  if(termHit('selectionNegative',hay))return {type:'selection_signal',actionable:false,reason:'official bench/rest language'};
  return {type:'unknown',actionable:false,reason:'insufficient event semantics'};
}

function clubEventLedgerKey(team){return `club-events:${team}`}
function canonicalClubEventKey(e){
  // RC5.0.17 D-06: counterpartTeam is EVIDENCE about a transaction, not part
  // of the transaction's identity. It was previously in this key, which
  // meant the same real-world signing produced two different canonical keys
  // whenever the fast-path regex extractor and the AI-recovery pass resolved
  // the counterpart club with different success on the same article -- one
  // path finds "from Newcastle United" in the text, the other doesn't. Both
  // records are the SAME transaction fact; only their confidence about the
  // counterpart differs. A player+type+club can only be involved in one
  // open transaction of a given type at a time, so identity is exactly that
  // triple. counterpartTeam is still carried on the record and merged
  // forward in mergeClubEventRows below -- it is enrichment, not a key.
  return [String(e?.team||''),String(e?.type||''),normal(e?.subject)].join('|');
}
function validStoredClubEvent(e){
  if(!e||!['signing','departure','loan_in','loan_out','loan_return'].includes(String(e.type||'')))return false;
  if(!validTransactionSubject(e.subject))return false;
  if(!isMensFirstTeamSource(e.source,''))return false;
  if(isAggregatorTransactionSource(e.source))return false;
  // Old information-recovery events from team-news/friendly pages are retained only
  // when they were backed by explicit same-line subject+transaction evidence.
  if(e.recovered&&/team-news|friendly|match-report/i.test(String(e.source||''))&&!e.subjectTransactionVerified)return false;
  return true;
}
function mergeClubEventRows(rows){
  const byKey=new Map();
  for(const e0 of rows||[]){
    if(!validStoredClubEvent(e0))continue;
    const k=canonicalClubEventKey(e0),old=byKey.get(k);
    const evidence=[...(old?.evidence||[]),...(e0.evidence||[]),e0.source].filter(Boolean);
    const firstSeenAt=old?.firstSeenAt||old?.detectedAt||e0.firstSeenAt||e0.detectedAt||new Date().toISOString();
    const newer=!old||Date.parse(e0.evidenceDate||e0.detectedAt||0)>=Date.parse(old.evidenceDate||old.detectedAt||0);
    const base=newer?e0:old;
    // RC5.0.17: counterpartTeam is no longer part of the key (see
    // canonicalClubEventKey above), so a group can now contain rows that
    // disagree on it -- typically one resolved, one empty, from the two
    // extraction paths. Whichever side actually resolved a counterpart must
    // not be discarded just because it lost the recency tiebreak, or
    // cross-club mirroring silently stops firing depending on which
    // extraction pass happened to run last. Non-empty wins; on a genuine
    // conflict between two DIFFERENT non-empty values, prefer the newer row
    // (base), since that is a real disagreement worth surfacing via evidence
    // rather than a resolved/unresolved split.
    const counterpartTeam=base.counterpartTeam||old?.counterpartTeam||e0.counterpartTeam||'';
    byKey.set(k,{...base,counterpartTeam,firstSeenAt,evidence:[...new Set(evidence)].slice(0,8)});
  }
  return [...byKey.values()].sort((a,b)=>Date.parse(b.evidenceDate||b.detectedAt||0)-Date.parse(a.evidenceDate||a.detectedAt||0)).slice(0,120);
}
async function loadClubEventLedger(env,team){
  const row=await env.ROLE_KV.get(clubEventLedgerKey(team),'json');
  return mergeClubEventRows(Array.isArray(row?.events)?row.events:[]);
}
async function saveClubEventLedger(env,team,events){
  const prior=await loadClubEventLedger(env,team);
  const merged=mergeClubEventRows([...prior,...(events||[])]);
  await env.ROLE_KV.put(clubEventLedgerKey(team),JSON.stringify({updatedAt:new Date().toISOString(),events:merged}),{expirationTtl:60*60*24*180});
}
function clubEventCurrentWindowMs(e){
  const t=String(e?.type||'');
  return ['signing','departure','loan_in','loan_out','loan_return'].includes(t)?30*86400000:7*86400000;
}
function isCurrentClubEvent(e){
  const t=Date.parse(e?.evidenceDate||e?.detectedAt||e?.createdAt||'');
  // Unknown-age events stay in history but never remain "current" indefinitely.
  return Number.isFinite(t) ? (Date.now()-t)<=clubEventCurrentWindowMs(e) : false;
}

function teamCodeFromNameText(text,currentTeam=''){
  const n=normal(text);
  const aliases=Object.entries(TEAM_ALIASES).sort((a,b)=>b[0].length-a[0].length);
  for(const [alias,code] of aliases){
    if(code===currentTeam)continue;
    if(n.includes(alias))return code;
  }
  return '';
}
function transactionCounterpart(doc,currentTeam,type){
  const text=String(doc?.text||'');
  const lines=splitLines(text).slice(0,80);
  const subject=subjectFromHeadlineOrSlug(doc);
  const candidateLines=subject?lines.filter(l=>normal(l).includes(normal(subject))):lines;
  const search=candidateLines.length?candidateLines:lines;
  for(const line of search){
    let m=null;
    if(['signing','loan_in'].includes(type)){
      m=line.match(/\bfrom\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿĀ-ž .'&-]{2,80})/i);
    }else if(['departure','loan_out'].includes(type)){
      m=line.match(/\b(?:to|joins?|signed for)\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿĀ-ž .'&-]{2,80})/i);
    }
    if(m){
      const code=teamCodeFromNameText(m[1],currentTeam);
      if(code)return code;
    }
  }
  return '';
}
function mirrorType(type){
  return ({signing:'departure',departure:'signing',loan_in:'loan_out',loan_out:'loan_in'})[type]||'';
}
async function mirrorClubTransactions(env,events){
  const writes=[];
  for(const e of events||[]){
    if(!e.counterpartTeam)continue;
    const mt=mirrorType(e.type);if(!mt)continue;
    const mirrored={
      ...e,
      id:`club-${hashString([e.counterpartTeam,mt,normal(e.subject),e.team].join('|'))}`,
      team:e.counterpartTeam,type:mt,counterpartTeam:e.team,
      // RC5.0.16 D-05: this referenced an undeclared `TEAMS` global. Every
      // call threw a ReferenceError before it ever reached env.ROLE_KV.put,
      // and both call sites wrap this function in a bare try{}catch{} with
      // no logging -- so cross-club mirroring has been silently failing on
      // every single invocation since it was introduced, not intermittently.
      // CLUB_SOURCES is the table that actually exists and carries `.name`.
      reason:`Mirrored from an official ${CLUB_SOURCES[e.team]?.name||e.team} transaction announcement. ${e.subject} ${mt==='departure'?'left':'joined'} ${CLUB_SOURCES[e.counterpartTeam]?.name||e.counterpartTeam}.`,
      mirrored:true,mirrorSourceTeam:e.team
    };
    writes.push(saveClubEventLedger(env,e.counterpartTeam,[mirrored]));
  }
  if(writes.length)await Promise.allSettled(writes);
}

function fastPathClubEvents(team,clubName,documents){
  const out=[];
  for(const d of documents||[]){
    const tx=classifyClubEvent(d,clubName);
    if(!['signing','departure','loan_in','loan_out','loan_return'].includes(tx.type))continue;
    const subject=subjectFromHeadlineOrSlug(d);
    if(!validTransactionSubject(subject))continue;
    const subjectTransactionVerified=sourceHasSubjectTransaction(d,subject);
    // Follow-up recovery must tie the player and transaction language together.
    if(/follow-up confirms/i.test(tx.reason)&&!subjectTransactionVerified)continue;
    const counterpartTeam=transactionCounterpart(d,team,tx.type);
    out.push({
      id:`club-${hashString([team,tx.type,normal(subject),counterpartTeam].join('|'))}`,
      team,type:tx.type,subject,confidence:1,source:d.url,counterpartTeam:counterpartTeam||'',
      reason:`Official ${clubName} ${tx.type.replaceAll('_',' ')} announcement detected. Role/xMins impact remains separate until a current FPL player can be mapped safely.`,
      evidenceDate:Number(d.publishedAt)?new Date(Number(d.publishedAt)).toISOString():'',
      detectedAt:new Date().toISOString(),
      official:true,fastPath:true,subjectTransactionVerified,classificationReason:tx.reason
    });
  }
  return mergeClubEventRows(out);
}

/* ------------------------------------------------ confirmed departures */
// FPL's bootstrap can legitimately lag an official transfer announcement. The
// club-news fact therefore has a tiny, deterministic bridge into the xMins
// contract: while the departed player is still present in this club's FPL
// roster, publish direct unavailability with availability=0. No beneficiary or
// tactical knock-on effect is inferred.

function departureEvidenceKey(team){return `direct-departure:${team}`}
function roleEvidenceIdentity(e){
  return String(e?.id||[e?.team,e?.type,normal(e?.subject),normal(e?.affected),e?.source].join('|'));
}
function mergeRoleEvidence(rows){
  const byId=new Map();
  for(const e of rows||[]){if(e&&e.type)byId.set(roleEvidenceIdentity(e),e)}
  return [...byId.values()].sort((a,b)=>Number(b.createdAt||Date.parse(b.evidenceDate||0)||0)-Number(a.createdAt||Date.parse(a.evidenceDate||0)||0));
}
function rosterPlayerForSubject(players,subject){
  const wanted=normal(subject);if(!wanted)return null;
  const exact=(players||[]).filter(p=>wanted===normal(p.fullName)||wanted===normal(p.name));
  if(exact.length===1)return exact[0];
  // Official headlines normally use the full name while FPL may expose only a
  // surname. Accept a suffix match only when it identifies exactly one player.
  const suffix=(players||[]).filter(p=>{
    const full=normal(p.fullName),short=normal(p.name);
    return (short&&wanted.endsWith(` ${short}`))||(full&&full.endsWith(` ${wanted}`));
  });
  return suffix.length===1?suffix[0]:null;
}
function confirmedDepartureEvidence(team,players,clubEvents){
  const out=[];
  for(const fact of clubEvents||[]){
    if(!['departure','loan_out'].includes(String(fact?.type||'')))continue;
    if(fact.official===false||!fact.subjectTransactionVerified||!isCurrentClubEvent(fact))continue;
    const player=rosterPlayerForSubject(players,fact.subject);if(!player)continue;
    const evidenceDate=fact.evidenceDate||fact.detectedAt||new Date().toISOString();
    const effectiveMs=Date.parse(evidenceDate)||Date.now();
    const movement=fact.type==='loan_out'?'official loan away':'official permanent departure';
    out.push({
      id:`direct-${hashString([team,fact.type,normal(fact.subject),player.id,fact.source].join('|'))}`,
      createdAt:effectiveMs,team,type:'unavailable',rawType:'unavailable',originType:`confirmed_${fact.type}`,
      transactionType:fact.type,subject:player.name,role:null,affected:player.name,affectedApiId:player.id,
      overlap:1,hierarchy:1,confidence:1,source:fact.source,
      reason:`${movement} confirmed by ${CLUB_SOURCES[team]?.name||team}. FPL still lists ${player.name} at the club, so availability is held at zero until the roster feed catches up.`,
      evidenceDate,evidenceDateSource:'official-club',evidenceClass:'availability',authorityTier:1,sourceAuthority:1,
      effectiveFrom:new Date(effectiveMs).toISOString(),expiresAt:new Date(effectiveMs+45*86400000).toISOString(),
      halfLifeHours:8760,maxMinuteImpact:90,directImpact:true,preseasonCalibrated:false,
      verificationStatus:'official-source',minutesCap:0,directAvailability:0,selectionCertainty:0,
      productionImpact:0,fixtureId:null,competition:null,kickoff:null,gameweek:null,
      auto:true,worker:true,oop:false
    });
  }
  return mergeRoleEvidence(out);
}
async function saveDepartureEvidence(env,team,events){
  await env.ROLE_KV.put(departureEvidenceKey(team),JSON.stringify({updatedAt:new Date().toISOString(),events:events||[]}),{expirationTtl:60*60*24*60});
}
async function loadDepartureEvidence(env,team){
  const row=await env.ROLE_KV.get(departureEvidenceKey(team),'json');
  const now=Date.now();
  return mergeRoleEvidence((Array.isArray(row?.events)?row.events:[]).filter(e=>{
    const expiry=Date.parse(e?.expiresAt||'');
    return String(e?.originType||'').startsWith('confirmed_')&&(!Number.isFinite(expiry)||expiry>now);
  }));
}

/* -------------------------------- provider-neutral structured football feed */

/* Structured providers are supplemental adapters. They can state direct
   availability or confirmed lineup facts for the same FPL player, but they
   never infer tactical roles, beneficiaries, competitors, role probabilities
   or xMin. Provider failures are isolated and a failed refresh never replaces
   a previously valid cached feed.

   RC5.1.1 intentionally starts with the official FPL bootstrap already used
   for roster identity. FotMob, RotoWire and Sofascore were technically
   prototyped but are not production adapters because their published terms
   prohibit automated extraction. A licensed adapter can be added to the
   registry below without changing normalization or scan/carry-forward logic. */
const STRUCTURED_FEED_VERSION='provider-neutral-v1';
const STRUCTURED_FEED_CACHE_TTL=60*60*24*14;
const STRUCTURED_PROVIDER_CATALOG=Object.freeze([
  Object.freeze({id:'fpl-bootstrap',version:'bootstrap-static-v1',capabilities:['availability'],authority:'official-current-state'}),
  Object.freeze({id:'fpl-live-starts',version:'event-live-v1',capabilities:['selection'],authority:'official-match-record'}),
  Object.freeze({id:'pl-announced-xi',version:'pulse-teamlists-v1',capabilities:['lineup'],authority:'official-team-sheet'})
]);

function structuredFeedCacheKey(team){return 'structured-feed:v2:'+team}

function fplAvailabilityFact(player){
  const status=String(player?.status||'').toLowerCase();
  const chanceRaw=player?.chance;
  const chance=chanceRaw===null||chanceRaw===undefined||chanceRaw===''?null:Number(chanceRaw);
  if(status==='s')return {type:'suspension',confidence:.99,directAvailability:0,ttlHours:48};
  if(status==='u'||status==='n'||chance===0)return {type:'unavailable',confidence:.96,directAvailability:0,ttlHours:48};
  if(status==='i'&&!Number.isFinite(chance))return {type:'unavailable',confidence:.94,directAvailability:0,ttlHours:36};
  if(status==='i'||status==='d'||(Number.isFinite(chance)&&chance<100)){
    return {type:'fitness_doubt',confidence:.86,directAvailability:Number.isFinite(chance)?clamp(chance/100,0,1):null,ttlHours:24};
  }
  return null;
}

function fplStructuredAvailabilityEvents(team,players,fetchedAt=new Date().toISOString()){
  const events=[],fetchedMs=Date.parse(fetchedAt)||Date.now();
  for(const player of players||[]){
    const fact=fplAvailabilityFact(player);if(!fact)continue;
    const detail=cleanText(player.news).slice(0,240);
    const label=fact.type==='suspension'?'suspended':(fact.type==='unavailable'?'unavailable':'a fitness doubt');
    events.push({
      // One identity per provider/player availability lane. If FPL moves a
      // player from OUT to doubtful, the newer fact replaces the older one
      // during carry-forward instead of both adjustments being applied.
      id:'structured-'+hashString([team,'fpl-bootstrap','availability',player.id].join('|')),
      createdAt:fetchedMs,team,type:fact.type,rawType:fact.type,originType:'structured_fpl_availability',
      subject:player.name,role:null,affected:player.name,affectedApiId:player.id,structuredPlayerId:null,
      overlap:1,hierarchy:1,confidence:fact.confidence,source:FPL_BOOTSTRAP,
      reason:'Fantasy Premier League currently lists '+player.name+' as '+label+(detail?': '+detail:'')+'. No beneficiary or tactical role is inferred.',
      evidenceDate:new Date(fetchedMs).toISOString(),evidenceDateSource:'fpl-bootstrap-current-state',
      evidenceClass:'availability',authorityTier:2,sourceAuthority:.9,
      effectiveFrom:new Date(fetchedMs).toISOString(),expiresAt:new Date(fetchedMs+fact.ttlHours*3600000).toISOString(),
      halfLifeHours:fact.type==='fitness_doubt'?24:48,maxMinuteImpact:fact.type==='fitness_doubt'?25:90,
      directImpact:true,preseasonCalibrated:false,verificationStatus:'structured-feed',
      minutesCap:fact.type==='fitness_doubt'?null:0,directAvailability:fact.directAvailability,
      selectionCertainty:null,productionImpact:0,fixtureId:null,competition:'Premier League',
      kickoff:null,gameweek:null,auto:true,worker:true,structuredFeed:true,provider:'fpl-bootstrap',oop:false
    });
  }
  return mergeRoleEvidence(events);
}

/* ---------------------------------------------- lineup + selection feeds */
/* Until now every structured event came from bootstrap availability, so the
   two highest-weighted evidence types in the whole policy table --
   confirmed_start and confirmed_bench (k=+/-4) -- had nothing feeding them,
   and a club could play a match without producing one selection signal.
   Two providers close that: the official post-match record (who actually
   started) and the official pre-kickoff team sheet (who is about to). */

const FPL_EVENT_LIVE=round=>`https://fantasy.premierleague.com/api/event/${round}/live/`;
const FPL_EVENT_FIXTURES=round=>`https://fantasy.premierleague.com/api/fixtures/?event=${round}`;
const PULSE_FIXTURE=pulseId=>`https://footballapi.pulselive.com/football/fixtures/${pulseId}`;
const PULSE_ORIGIN='https://www.premierleague.com';
const SELECTION_ROUNDS=3; // resolveRoleIntelEvents keeps at most 3 selection events per player
/* These feeds run inside the scan budget, so a provider that hangs would eat
   the whole allowance and starve article reading. Every request is bounded. */
const FEED_TIMEOUT_MS=6000;
function feedSignal(){try{return AbortSignal.timeout(FEED_TIMEOUT_MS)}catch{return undefined}}

const LIVE_MEMO=new Map();
const LIVE_MEMO_MS=90000;
const LIVE_MEMO_MAX=6;

/* A cron sweep scans clubs one at a time but every club reads the SAME live
   round payload. Without memoisation that is one ~300KB fetch and parse per
   club per round -- sixty requests a tick for identical bytes. */
async function getEventLive(round,fetchFn=fetch){
  const key=String(round),now=Date.now(),hit=LIVE_MEMO.get(key);
  if(hit&&now-hit.at<LIVE_MEMO_MS)return hit.data;
  const r=await fetchFn(FPL_EVENT_LIVE(round),{headers:{Accept:'application/json'},signal:feedSignal()});
  if(!r.ok)throw new Error(`FPL live HTTP ${r.status} for round ${round}`);
  const data=await r.json();
  if(LIVE_MEMO.size>=LIVE_MEMO_MAX)LIVE_MEMO.delete(LIVE_MEMO.keys().next().value);
  LIVE_MEMO.set(key,{at:now,data});
  return data;
}

function recentFinishedEvents(bootstrap,limit=SELECTION_ROUNDS){
  return (bootstrap?.events||[])
    .filter(e=>e?.finished===true&&Number.isFinite(Number(e?.id)))
    .sort((a,b)=>Number(b.id)-Number(a.id))
    .slice(0,limit);
}

function selectionEvent({team,player,round,type,confidence,reason,at,source}){
  const policy=EVIDENCE_POLICY[type]||EVIDENCE_POLICY.observed_role;
  return {
    // Round is part of the identity so consecutive gameweeks accumulate as
    // separate observations instead of overwriting one another.
    id:'structured-'+hashString([team,'fpl-live-starts',type,round,player.id].join('|')),
    createdAt:at,team,type,rawType:type,originType:'structured_fpl_selection',
    subject:player.name,role:null,affected:player.name,affectedApiId:player.id,structuredPlayerId:null,
    overlap:1,hierarchy:1,confidence,source,reason,
    evidenceDate:new Date(at).toISOString(),evidenceDateSource:'fpl-event-live',
    evidenceClass:policy.channel,authorityTier:policy.tier,sourceAuthority:.9,
    effectiveFrom:new Date(at).toISOString(),
    expiresAt:new Date(at+policy.ttlHours*3600000).toISOString(),
    halfLifeHours:policy.halfLifeHours,maxMinuteImpact:policy.maxMinuteImpact,
    directImpact:false,preseasonCalibrated:false,verificationStatus:'structured-feed',
    minutesCap:null,directAvailability:null,selectionCertainty:null,productionImpact:0,
    fixtureId:null,competition:'Premier League',kickoff:null,gameweek:round,
    auto:true,worker:true,structuredFeed:true,provider:'fpl-live-starts',oop:false
  };
}

/** Pure: turns one round of official live stats into selection evidence. */
function fplLiveSelectionEvents(team,players,round,liveElements,{deadlineTime=null}={}){
  const stats=new Map();
  for(const el of liveElements||[]){
    const id=Number(el?.id);
    if(Number.isFinite(id))stats.set(id,el?.stats||{});
  }
  const roster=(players||[]).filter(p=>Number.isFinite(Number(p.id)));
  /* Blank-gameweek guard. event/live lists EVERY player in the game with zero
     minutes, so a club that did not play this round is indistinguishable from
     a club whose entire squad was benched. If nobody on this roster recorded a
     single minute, treat it as no data rather than inventing fifteen benchings
     out of an absence. */
  if(!roster.some(p=>Number(stats.get(Number(p.id))?.minutes)>0))return {events:[],skipped:'no-minutes-recorded'};
  const at=Date.parse(deadlineTime||'')||Date.now();
  const events=[];
  for(const player of roster){
    const row=stats.get(Number(player.id));
    if(!row)continue;
    const minutes=Number(row.minutes)||0,starts=Number(row.starts)||0;
    if(starts>=1){
      const confidence=minutes>=85?.95:minutes>=60?.9:.82;
      events.push(selectionEvent({team,player,round,type:'observed_role',confidence,at,source:FPL_EVENT_LIVE(round),
        reason:`Official Premier League match record: ${player.name} started gameweek ${round} and played ${minutes} minutes.`}));
      continue;
    }
    if(minutes>0){
      events.push(selectionEvent({team,player,round,type:'observed_bench',confidence:.85,at,source:FPL_EVENT_LIVE(round),
        reason:`Official Premier League match record: ${player.name} did not start gameweek ${round} and came off the bench for ${minutes} minutes.`}));
      continue;
    }
    /* Zero minutes is ambiguous -- unused substitute, omitted from the squad,
       or simply injured. An already-unavailable player is fully described by
       the availability provider, so adding a rotation signal on top would
       double-count one injury as a separate selection decision. */
    if(String(player.status||'a').toLowerCase()!=='a')continue;
    events.push(selectionEvent({team,player,round,type:'observed_bench',confidence:.7,at,source:FPL_EVENT_LIVE(round),
      reason:`Official Premier League match record: ${player.name} was available but did not play in gameweek ${round}.`}));
  }
  return {events,skipped:null};
}

function pulsePlayerName(entry){
  const name=entry?.name||{};
  return cleanText(name.display||[name.first,name.last].filter(Boolean).join(' ')||entry?.matchName||'');
}

/** Pure: picks the team list belonging to our roster by counting name matches. */
function pulseTeamListForRoster(teamLists,players){
  let best=null,bestScore=0;
  for(const list of Array.isArray(teamLists)?teamLists:[]){
    const named=[...(list?.lineup||[]),...(list?.substitutes||[])].map(pulsePlayerName).filter(Boolean);
    const score=named.filter(name=>rosterPlayerForSubject(players,name)).length;
    if(score>bestScore){bestScore=score;best=list}
  }
  /* Identify our side by roster overlap rather than by mapping Pulselive team
     ids to FPL ones: the id spaces are unrelated and the name formats differ,
     but a starting eleven that matches our roster can only be ours. */
  return bestScore>=6?{list:best,matched:bestScore}:{list:null,matched:bestScore};
}

/** Pure: turns an official pre-kickoff team sheet into lineup evidence. */
function announcedXiEvents(team,players,teamList,{fixtureId=null,kickoff=null,round=null,at=Date.now(),source=''}={}){
  const events=[],seen=new Set();
  const push=(entry,type)=>{
    const name=pulsePlayerName(entry);
    const player=name?rosterPlayerForSubject(players,name):null;
    if(!player||seen.has(player.id))return;
    seen.add(player.id);
    const policy=EVIDENCE_POLICY[type];
    const started=type==='confirmed_start';
    events.push({
      id:'structured-'+hashString([team,'pl-announced-xi',fixtureId||round||'',player.id].join('|')),
      createdAt:at,team,type,rawType:type,originType:'structured_announced_xi',
      subject:player.name,role:null,affected:player.name,affectedApiId:player.id,structuredPlayerId:null,
      overlap:1,hierarchy:1,confidence:.99,source,
      reason:`Official Premier League team sheet: ${player.name} was named ${started?'in the starting eleven':'among the substitutes'}.`,
      evidenceDate:new Date(at).toISOString(),evidenceDateSource:'pulse-teamlists',
      evidenceClass:policy.channel,authorityTier:policy.tier,sourceAuthority:1,
      effectiveFrom:new Date(at).toISOString(),
      expiresAt:new Date(at+policy.ttlHours*3600000).toISOString(),
      halfLifeHours:policy.halfLifeHours,maxMinuteImpact:policy.maxMinuteImpact,
      directImpact:true,preseasonCalibrated:false,verificationStatus:'structured-feed',
      minutesCap:null,directAvailability:started?1:null,selectionCertainty:.99,productionImpact:0,
      fixtureId:fixtureId?String(fixtureId):null,competition:'Premier League',
      kickoff:kickoff||null,gameweek:round,
      auto:true,worker:true,structuredFeed:true,provider:'pl-announced-xi',oop:false
    });
  };
  for(const entry of teamList?.lineup||[])push(entry,'confirmed_start');
  for(const entry of teamList?.substitutes||[])push(entry,'confirmed_bench');
  return events;
}

const STRUCTURED_PROVIDER_ADAPTERS=Object.freeze([
  Object.freeze({
    id:'fpl-bootstrap',version:'bootstrap-static-v1',capabilities:['availability'],
    enabled:env=>String(env.STRUCTURED_FEED_DISABLED||'')!=='1',
    async collect({team,players,fetchedAt}){
      const events=fplStructuredAvailabilityEvents(team,players,fetchedAt);
      return {
        status:'ok',events,sources:[FPL_BOOTSTRAP],errors:[],unmatched:[],
        diagnostics:{availabilityEvents:events.length,lineupEvents:0,requestCount:0}
      };
    }
  }),
  Object.freeze({
    id:'fpl-live-starts',version:'event-live-v1',capabilities:['selection'],
    enabled:env=>String(env.STRUCTURED_FEED_DISABLED||'')!=='1'&&String(env.LIVE_STARTS_DISABLED||'')!=='1',
    async collect({team,players}){
      const bootstrap=await getBootstrap();
      const rounds=recentFinishedEvents(bootstrap);
      if(!rounds.length)return {
        status:'ok',events:[],sources:[],errors:[],unmatched:[],
        diagnostics:{availabilityEvents:0,lineupEvents:0,selectionEvents:0,requestCount:0,reason:'no-finished-gameweek'}
      };
      const collected=[],sources=[],errors=[],skipped=[];
      let requestCount=0;
      for(const round of rounds){
        try{
          const live=await getEventLive(round.id);
          requestCount+=1;
          const out=fplLiveSelectionEvents(team,players,Number(round.id),live?.elements,{deadlineTime:round.deadline_time});
          if(out.skipped)skipped.push(`${round.id}:${out.skipped}`);
          if(out.events.length){collected.push(...out.events);sources.push(FPL_EVENT_LIVE(round.id))}
        }catch(error){errors.push(`round ${round.id}: ${error?.message||String(error)}`)}
      }
      const events=mergeRoleEvidence(collected);
      return {
        status:errors.length&&!events.length?'error':(errors.length?'partial':'ok'),
        events,sources,errors,unmatched:[],
        diagnostics:{
          availabilityEvents:0,lineupEvents:0,selectionEvents:events.length,requestCount,
          roundsRead:rounds.map(r=>Number(r.id)),skippedRounds:skipped
        }
      };
    }
  }),
  Object.freeze({
    id:'pl-announced-xi',version:'pulse-teamlists-v1',capabilities:['lineup'],
    enabled:env=>String(env.STRUCTURED_FEED_DISABLED||'')!=='1'&&String(env.ANNOUNCED_XI_DISABLED||'')!=='1',
    async collect({team,players}){
      const empty=(reason,extra={})=>({
        status:'ok',events:[],sources:[],errors:[],unmatched:[],
        diagnostics:{availabilityEvents:0,lineupEvents:0,requestCount:0,reason,...extra}
      });
      const bootstrap=await getBootstrap();
      const next=(bootstrap?.events||[]).find(e=>e?.is_next)||(bootstrap?.events||[]).find(e=>!e?.finished);
      if(!next)return empty('no-upcoming-gameweek');
      const teamRow=(bootstrap?.teams||[]).find(t=>teamCodeFromFplTeam(t)===team);
      if(!teamRow)return empty('club-not-in-bootstrap');
      let requestCount=0;
      const fixturesResponse=await fetch(FPL_EVENT_FIXTURES(next.id),{headers:{Accept:'application/json'},signal:feedSignal()});
      requestCount+=1;
      if(!fixturesResponse.ok)throw new Error(`FPL fixtures HTTP ${fixturesResponse.status}`);
      const fixtures=await fixturesResponse.json();
      const fixture=(Array.isArray(fixtures)?fixtures:[]).find(f=>f?.team_h===teamRow.id||f?.team_a===teamRow.id);
      if(!fixture)return empty('no-fixture-this-gameweek',{gameweek:Number(next.id),requestCount});
      // A finished match is the post-match provider's territory. confirmed_start
      // pins start probability at ~0.995, so replaying it over a completed
      // fixture would assert the NEXT match's lineup from the last one's.
      if(fixture.finished===true)return empty('fixture-already-finished',{gameweek:Number(next.id),requestCount});
      const pulseId=Number(fixture.pulse_id)||0;
      if(!pulseId)return empty('no-pulse-id-yet',{gameweek:Number(next.id),requestCount});
      const response=await fetch(PULSE_FIXTURE(pulseId),{headers:{Accept:'application/json',Origin:PULSE_ORIGIN},signal:feedSignal()});
      requestCount+=1;
      if(!response.ok)throw new Error(`Pulse fixture HTTP ${response.status} for ${pulseId}`);
      const payload=await response.json();
      const lists=payload?.teamLists||payload?.teamList||[];
      // Team sheets appear roughly an hour before kickoff. Before that the
      // feed is legitimately empty; that is a wait, not a failure.
      if(!Array.isArray(lists)||!lists.length)return empty('awaiting-team-sheet',{gameweek:Number(next.id),pulseId,requestCount});
      const {list,matched}=pulseTeamListForRoster(lists,players);
      if(!list)return empty('team-sheet-did-not-match-roster',{gameweek:Number(next.id),pulseId,rosterMatches:matched,requestCount});
      const events=announcedXiEvents(team,players,list,{
        fixtureId:pulseId,kickoff:fixture.kickoff_time||null,round:Number(next.id),
        at:Date.now(),source:PULSE_FIXTURE(pulseId)
      });
      return {
        status:'ok',events,sources:[PULSE_FIXTURE(pulseId)],errors:[],unmatched:[],
        diagnostics:{
          availabilityEvents:0,lineupEvents:events.length,requestCount,
          gameweek:Number(next.id),pulseId,rosterMatches:matched,
          starters:events.filter(e=>e.type==='confirmed_start').length,
          benched:events.filter(e=>e.type==='confirmed_bench').length
        }
      };
    }
  })
]);

async function runStructuredProviders(context,adapters=STRUCTURED_PROVIDER_ADAPTERS){
  const active=(adapters||[]).filter(adapter=>{
    try{return typeof adapter?.enabled==='function'?adapter.enabled(context.env)!==false:true}
    catch{return false}
  });
  if(!active.length)return {
    status:'disabled',enabled:false,feedVersion:STRUCTURED_FEED_VERSION,providers:[],
    fetchedAt:context.fetchedAt,events:[],sources:[],errors:[],unmatched:[],
    diagnostics:{providers:[],availabilityEvents:0,lineupEvents:0,requestCount:0}
  };
  const results=await Promise.all(active.map(async adapter=>{
    try{
      const out=await adapter.collect(context);
      return {
        provider:adapter.id,providerVersion:adapter.version,capabilities:adapter.capabilities||[],
        status:out?.status||'ok',events:Array.isArray(out?.events)?out.events:[],
        sources:Array.isArray(out?.sources)?out.sources:[],errors:Array.isArray(out?.errors)?out.errors:[],
        unmatched:Array.isArray(out?.unmatched)?out.unmatched:[],diagnostics:out?.diagnostics||{}
      };
    }catch(error){
      return {
        provider:adapter.id,providerVersion:adapter.version,capabilities:adapter.capabilities||[],
        status:'error',events:[],sources:[],unmatched:[],
        errors:[error?.message||String(error)],diagnostics:{stage:'adapter'}
      };
    }
  }));
  const errors=results.flatMap(result=>(result.errors||[]).map(error=>result.provider+': '+error));
  const events=mergeRoleEvidence(results.flatMap(result=>result.events||[]));
  const providers=results.map(result=>({
    id:result.provider,version:result.providerVersion,capabilities:result.capabilities,
    status:result.status,eventCount:result.events.length,diagnostics:result.diagnostics
  }));
  const hardFailures=results.filter(result=>result.status==='error').length;
  return {
    status:hardFailures===results.length&&!events.length?'error':(errors.length||hardFailures?'partial':'ok'),
    enabled:true,feedVersion:STRUCTURED_FEED_VERSION,providers,
    fetchedAt:context.fetchedAt,events,
    sources:[...new Set(results.flatMap(result=>result.sources||[]).filter(Boolean))],
    errors,unmatched:results.flatMap(result=>result.unmatched||[]).slice(0,40),
    diagnostics:{
      providers,
      availabilityEvents:events.filter(event=>event.evidenceClass==='availability').length,
      lineupEvents:events.filter(event=>event.evidenceClass==='lineup').length,
      // Selection evidence lands in two channels: repeated observations sit in
      // 'selection' and a single most-recent benching sits in 'manager', so
      // counting one channel alone would under-report the feed's real yield.
      selectionEvents:events.filter(event=>['selection','manager'].includes(event.evidenceClass)).length,
      requestCount:results.reduce((sum,result)=>sum+Number(result.diagnostics?.requestCount||0),0)
    }
  };
}

async function structuredFeedForTeam(env,team,players,{profile='foreground',force=false}={}){
  const fetchedAt=new Date().toISOString();
  const result=await runStructuredProviders({env,team,players,profile,force,fetchedAt});
  // A provider outage must never overwrite the last valid normalized feed.
  if(result.status!=='error'){
    try{await env.ROLE_KV.put(structuredFeedCacheKey(team),JSON.stringify(result),{expirationTtl:STRUCTURED_FEED_CACHE_TTL})}catch{}
  }
  return result;
}

async function cachedStructuredFeedForTeam(env,team){
  const cached=await env.ROLE_KV.get(structuredFeedCacheKey(team),'json');
  if(!cached)return {
    status:'cache-miss',enabled:true,feedVersion:STRUCTURED_FEED_VERSION,
    providers:STRUCTURED_PROVIDER_CATALOG,events:[],sources:[],errors:[],unmatched:[],
    diagnostics:{cache:'MISS',providers:[],availabilityEvents:0,lineupEvents:0,requestCount:0}
  };
  const fetchedMs=Date.parse(cached.fetchedAt||'');
  const ageMinutes=Number.isFinite(fetchedMs)?Math.max(0,(Date.now()-fetchedMs)/60000):null;
  const events=(Array.isArray(cached.events)?cached.events:[]).filter(event=>{
    const expiry=Date.parse(event?.expiresAt||'');
    return !Number.isFinite(expiry)||expiry>Date.now();
  });
  return {
    ...cached,status:'cached',events,cache:'HIT',ageMinutes:ageMinutes===null?null:Math.round(ageMinutes),
    diagnostics:{...(cached.diagnostics||{}),cache:'HIT',ageMinutes:ageMinutes===null?null:Math.round(ageMinutes)}
  };
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

async function aiExtract(env,team,clubName,players,documents,rosterDelta,{timeoutMs=DEFAULT_AI_TIMEOUT_MS}={}){
  const started=Date.now();
  if(!env.AI?.run)return {events:[],status:'unavailable',elapsedMs:0,error:'Workers AI binding is unavailable'};
  const playerList=players.map(p=>`${p.name} [${p.fplPosition}]`).join(', ');
  let remaining=AI_TOTAL_DOC_CHARS;
  const docs=documents.map((d,i)=>{
    const take=Math.max(0,Math.min(AI_DOC_CHARS,remaining));
    const body=String(d.text||'').slice(0,take);remaining-=body.length;
    return `SOURCE ${i+1}: ${d.url}\nSOURCE_PUBLISHED_AT: ${Number(d.publishedAt)?new Date(Number(d.publishedAt)).toISOString():'unknown'}\nSOURCE_DATE_ORIGIN: ${d.dateSource||'unknown'}\n${body}`;
  }).join('\n\n');
  const prompt=`You are the OTB football role-intelligence extractor. Analyse only the supplied official-club text and FPL roster evidence for ${clubName} (${team}).
Return current, source-grounded structured events that can materially change EXPECTED MINUTES for players registered in FPL.

CURRENT FPL PLAYERS: ${playerList}
ROSTER ADDED: ${rosterDelta.added.map(p=>p.name).join(', ')||'none'}
ROSTER MISSING SINCE LAST SNAPSHOT: ${rosterDelta.missing.map(p=>p.name).join(', ')||'none'}

WHAT YOU ARE LOOKING FOR
Official club articles routinely carry exactly the evidence this task wants: match reports naming who started, manager press-conference quotes about selection and fitness, injury updates, and confirmed transfers. When such a statement is present about a CURRENT FPL player, extract it. Withholding a well-supported event is as much a failure as inventing one.

WORKED EXAMPLES

Text: "Fabian Hurzeler confirmed Lewis Dunk will captain the side against Tromso, with Pascal Struijk keeping his place alongside him."
Event: {"type":"observed_role","subject":"Dunk","affected":"Dunk","overlap":0.9,"hierarchy":0.9,"confidence":0.9,"source":"<the SOURCE url this text came from>","reason":"Manager confirmed he captains the side and keeps his place."}
Why: explicit selection language about a named current player. A second event for Struijk ("keeping his place") is equally valid.

Text: "The midfielder will be assessed ahead of the weekend after picking up a knock in training."
Event: {"type":"fitness_doubt","subject":"<that player>","affected":"<that player>","overlap":1,"hierarchy":1,"confidence":0.6,"source":"<the SOURCE url>","reason":"To be assessed after a training knock; fitness uncertain."}
Why: explicit fitness uncertainty about a named current player.

Text: "Danny Welbeck has completed a permanent move to Chelsea."
Event: {"type":"departure","subject":"Danny Welbeck","affected":"<the current FPL forward named in the SAME article who benefits>","overlap":0.8,"hierarchy":0.7,"confidence":1,"source":"<the SOURCE url>","reason":"Welbeck departed permanently, freeing minutes in attack."}
Why: a confirmed departure. Only name an affected player if that player appears in the same article text.

Text: "Read our matchday guide and see how to watch Saturday's fixture."
Event: none. Fixture, TV and ticket guides carry no role evidence.

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
- For departure/injury events, affected is the beneficiary. For signing/return events, affected is the threatened incumbent. Do not apply an injury event to the injured player himself.\n- PLAYER-SPECIFIC COMPETITION EFFECTS MUST BE EXPLICIT. For signing, departure, loan_in, loan_out, injury or return, only name an affected CURRENT FPL player when that affected player's name is present in the cited official source. Do not nominate a threatened/beneficiary player from squad knowledge alone.
- Confirmed official statements: confidence 0.9-1.0. Repeated official preseason lineup evidence: 0.70-0.90. One ambiguous mention: <=0.55.
- overlap measures direct role competition. hierarchy measures expected selection strength of subject/role evidence.
- directAvailability is optional and only for direct availability evidence. Use 0 for definitely unavailable/suspended; use a supported intermediate probability only for explicit uncertainty; use 1 for explicitly available.
- selectionCertainty is optional and only for confirmed lineup or explicit start/bench language.
- productionImpact is optional and should normally be 0. Use a small non-zero value only when the source explicitly establishes a sustained tactical role that plausibly changes per-minute production.
- Include a concise reason citing the concrete evidence (for example: started two consecutive friendlies at RW, manager named him first choice, competitor signed). Include the exact source URL and an ISO evidenceDate when available.
- The source field MUST be one of the SOURCE URLs supplied above, copied exactly.
- Return no event when evidence is insufficient, when the text is a fixture/TV/ticket/kit/commercial page, or when the claim would rest on squad knowledge rather than the supplied text.
- Insufficient evidence must produce no event. But do NOT withhold an event the rules above permit: an article that plainly states selection, fitness, availability or a completed transfer for a CURRENT FPL player SHOULD produce one. Returning an empty list when such a statement is present is an error.

OFFICIAL MATERIAL:\n${docs}`;
  const run=env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast',{
    messages:[{role:'system',content:'Extract conservative, source-grounded Premier League team-role events as JSON. Never invent facts.'},{role:'user',content:prompt}],
    response_format:{type:'json_schema',json_schema:{name:'otb_role_events',strict:true,schema:extractionSchema()}},
    max_tokens:AI_MAX_OUTPUT_TOKENS,
    temperature:0
  });
  const limit=Math.max(1000,Math.min(60000,Number(timeoutMs)||DEFAULT_AI_TIMEOUT_MS));
  let timer;
  const settled=await Promise.race([
    run.then(value=>({value}),error=>({error})),
    new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),limit)})
  ]);
  if(timer)clearTimeout(timer);
  if(settled.timedOut)return {events:[],status:'timeout',elapsedMs:Date.now()-started,error:`Workers AI exceeded ${limit}ms`};
  if(settled.error)return {events:[],status:'error',elapsedMs:Date.now()-started,error:settled.error?.message||String(settled.error)};
  let out=settled.value?.response ?? settled.value;
  if(typeof out==='string'){
    try{out=JSON.parse(out)}
    catch{return {events:[],status:'parse-error',elapsedMs:Date.now()-started,error:'Workers AI returned invalid JSON'}}
  }
  /* out.events missing is NOT the same as the model finding nothing, and
     returning [] with status 'ok' for both made them indistinguishable. */
  if(!out||typeof out!=='object'||!Array.isArray(out.events)){
    return {events:[],status:'malformed',elapsedMs:Date.now()-started,
      error:`Workers AI response had no events array (received ${out===null?'null':typeof out})`};
  }
  return {events:out.events,status:'ok',elapsedMs:Date.now()-started,error:null,docCount:documents.length,promptChars:prompt.length,docChars:docs.length,maxOutputTokens:AI_MAX_OUTPUT_TOKENS};
}

function isPreseasonOrFriendlySource(url,text=''){
  const s=`${String(url||'')} ${String(text||'')}`.toLowerCase();
  return /pre-season|preseason|friendly|tour match|emirates cup|summer series/.test(s);
}
function hasCompetitiveAbsenceLanguage(text=''){
  return /\bwill miss\b|\bset to miss\b|\bruled out of (?:the )?(?:premier league|league|opening|opener|gameweek|gw)\b|\bunavailable for (?:the )?(?:premier league|league|opening|opener|gameweek|gw)\b|\bsuspended for\b/i.test(String(text||''));
}
function normalizeFriendlyEvidenceEvent(e){
  if(!e?.preseasonCalibrated)return e;
  const sourceType=String(e.sourceType||e.rawType||e.type||'');
  if(!/confirmed_(?:start|bench)|friendly_(?:start|bench)/.test(`${sourceType} ${e.type||''}`))return e;
  const type=/bench/.test(`${sourceType} ${e.type||''}`)?'friendly_bench':'friendly_start';
  return {...e,type,rawType:type,sourceType,evidenceClass:'selection',authorityTier:Math.max(3,Number(e.authorityTier)||3),
    halfLifeHours:Math.min(96,Number(e.halfLifeHours)||96),maxMinuteImpact:Math.min(8,Number(e.maxMinuteImpact)||8),
    directImpact:false,selectionCertainty:null};
}

/* Every rejection below used to be a bare `continue`. Eight Brighton articles
   were read successfully with aiStatus ok and produced zero role events, and
   nothing anywhere could say whether the model proposed nothing or proposed
   plenty that this gauntlet threw away. Same silent-zero shape as the club
   calendar. Each gate now names itself. */
function validateEvents(team,players,events,sourceDocuments,stats=null){
  const byName=new Map;for(const p of players){byName.set(normal(p.name),p);byName.set(normal(p.fullName),p)}const out=[];
  const drop={proposed:Array.isArray(events)?events.length:0,unknownPlayer:0,unknownType:0,subjectMismatch:0,
    malformedSource:0,offHost:0,notASuppliedDocument:0,selfReferential:0,affectedNotNamedInText:0,tooOld:0,duplicate:0,accepted:0};
  const reject=key=>{drop[key]=(drop[key]||0)+1};
  /* Citation matching has to defeat hallucination without punishing
     formatting. A model that cites the right article with a trailing slash, a
     stray query string or different host casing has not invented anything --
     dropping it silently loses real evidence. Compare host plus path with all
     of that normalised away; the anti-hallucination property (it must be a
     document we actually supplied) is unchanged. */
  const canonicalUrl=u=>{
    try{
      const x=new URL(String(u||''));
      return x.hostname.replace(/^www\./,'').toLowerCase()+x.pathname.replace(/\/+$/,'').toLowerCase();
    }catch{return String(u||'').trim().toLowerCase()}
  };
  const docs=Array.isArray(sourceDocuments)?sourceDocuments:[];
  const sourceMeta=new Map(docs.map(d=>[canonicalUrl(d.url),{publishedAt:Number(d.publishedAt)||null,dateSource:d.dateSource||null,text:String(d.text||'')}]));
  const allowedExact=new Set(sourceMeta.keys());
  const allowedHosts=new Set(docs.map(d=>hostOf(d.url)).filter(Boolean));
  for(const e of events||[]){
    const p=byName.get(normal(e.affected));
    if(!p){reject('unknownPlayer');continue}
    if(!EVENT_VALUES.has(e.type)){reject('unknownType');continue}
    /* A missing position is no longer fatal. The extraction schema lists
       `role` as OPTIONAL, then this line dropped every event that omitted it
       -- so a manager quote or a plain "he started", which carry no position
       by nature, could never survive. The model was being punished for
       following its own contract. eventRole was already nullable downstream. */
    const eventRole=ROLE_VALUES.has(e.role)?e.role:null;
    // observed_role describes the subject's OWN selection, so subject and
    // affected must be the same player. When they differ the model has
    // described a competitor being selected, which is a threat to `affected`,
    // not a boost -- and the sign would come out backwards.
    if(e.type==='observed_role'&&normal(e.subject)&&normal(e.subject)!==normal(p.name)&&normal(e.subject)!==normal(p.fullName)){reject('subjectMismatch');continue}
    const source=String(e.source||'');if(!/^https?:\/\//i.test(source)){reject('malformedSource');continue}
    // Guard against a hallucinated URL: the citation must point at a document
    // that was actually supplied to the model.
    if(allowedHosts.size&&!allowedHosts.has(hostOf(source))){reject('offHost');continue}
    if(allowedExact.size&&!allowedExact.has(canonicalUrl(source))){reject('notASuppliedDocument');continue}
    if(e.type==='injury'&&normal(e.subject)===normal(p.name)){reject('selfReferential');continue}
    if(e.type==='loan_in'&&normal(e.subject)===normal(p.name)){reject('selfReferential');continue} // arrival threatens incumbent; affected is incumbent
    if(e.type==='loan_out'&&normal(e.subject)!==normal(p.name)&&normal(e.subject)!==normal(p.fullName)){reject('subjectMismatch');continue} // outbound loan should name departing current player
    if(['confirmed_start','confirmed_bench','unavailable','fitness_doubt','minutes_restricted','suspension'].includes(e.type)
       && normal(e.subject)!==normal(p.name)&&normal(e.subject)!==normal(p.fullName)){reject('subjectMismatch');continue}

    const meta=sourceMeta.get(canonicalUrl(source))||{};
    const authoritativeMs=Number(meta.publishedAt)||null;
    const evidenceDate=authoritativeMs?new Date(authoritativeMs).toISOString():'';
    const evidenceTime=authoritativeMs||Date.now();
    if(['signing','departure','loan_in','loan_out','injury','return'].includes(e.type)){
      const sourceNorm=normal(meta.text||'');
      const affectedNamed=sourceNorm.includes(normal(p.name)) || (p.fullName&&sourceNorm.includes(normal(p.fullName)));
      if(!affectedNamed){reject('affectedNotNamedInText');continue}
    }
    if(Number.isFinite(evidenceTime)&&Date.now()-evidenceTime>120*86400000&&!['departure','signing'].includes(e.type)){reject('tooOld');continue}
    let normalizedType=e.type==='loan_in'?'signing':(e.type==='loan_out'?'departure':e.type);
    let policy=EVIDENCE_POLICY[e.type]||EVIDENCE_POLICY[normalizedType]||{channel:'other',tier:4,halfLifeHours:168,ttlHours:336,maxMinuteImpact:8,direct:false};

    // Pre-season/friendly evidence updates the prior; it must not masquerade as
    // a confirmed Premier League lineup or a confirmed competitive absence.
    const preseason=isPreseasonOrFriendlySource(source,meta.text);
    const preseasonLineup=preseason&&['confirmed_start','confirmed_bench'].includes(e.type);
    if(preseasonLineup){
      normalizedType=e.type==='confirmed_bench'?'friendly_bench':'friendly_start';
      policy={...EVIDENCE_POLICY.observed_role,channel:'selection',tier:3,halfLifeHours:96,ttlHours:240,maxMinuteImpact:8,direct:false};
    }
    if(preseason&&['unavailable','minutes_restricted','fitness_doubt'].includes(e.type)&&!hasCompetitiveAbsenceLanguage(meta.text)){
      normalizedType='fitness_doubt';
      policy={...EVIDENCE_POLICY.fitness_doubt,tier:3,halfLifeHours:24,ttlHours:72,maxMinuteImpact:15,direct:false};
    }

    const effectiveMs=authoritativeMs||Date.now();
    out.push({id:`auto-${hashString([team,normalizedType,e.subject,p.name,e.role,source,e.evidenceDate].join('|'))}`,createdAt:Date.now(),team,type:normalizedType,rawType:preseasonLineup?normalizedType:e.type,sourceType:e.type,subject:cleanText(e.subject).slice(0,120),role:eventRole,affected:p.name,affectedApiId:p.id,overlap:clamp(e.overlap,0,1),hierarchy:clamp(e.hierarchy,0,1),confidence:clamp(e.confidence,0,1),source,reason:cleanText(e.reason).slice(0,320),evidenceDate,evidenceDateSource:meta.dateSource||null,evidenceClass:policy.channel,authorityTier:policy.tier,sourceAuthority:.98,effectiveFrom:new Date(effectiveMs).toISOString(),expiresAt:new Date(effectiveMs+policy.ttlHours*3600000).toISOString(),halfLifeHours:policy.halfLifeHours,maxMinuteImpact:policy.maxMinuteImpact,directImpact:!!policy.direct,preseasonCalibrated:preseason,verificationStatus:'official-source',minutesCap:Number.isFinite(Number(e.minutesCap))?clamp(Number(e.minutesCap),0,90):null,directAvailability:Number.isFinite(Number(e.directAvailability))?clamp(Number(e.directAvailability),0,1):null,selectionCertainty:preseasonLineup?null:(Number.isFinite(Number(e.selectionCertainty))?clamp(Number(e.selectionCertainty),0,1):null),productionImpact:Number.isFinite(Number(e.productionImpact))?clamp(Number(e.productionImpact),-.25,.25):0,fixtureId:cleanText(e.fixtureId).slice(0,80)||null,competition:cleanText(e.competition).slice(0,80)||null,kickoff:cleanText(e.kickoff).slice(0,40)||null,gameweek:Number.isFinite(Number(e.gameweek))?Number(e.gameweek):null,auto:true,worker:true,oop:(p.fplPosition==='DEF'&&['LW','RW','AM','ST'].includes(e.role))||(p.fplPosition==='MID'&&['FB','CB'].includes(e.role))});
  }
  const seen=new Set;
  const deduped=out.filter(e=>{const k=[e.type,normal(e.subject),normal(e.affected),e.role,e.source].join('|');if(seen.has(k)){reject('duplicate');return false}seen.add(k);return true});
  drop.accepted=deduped.length;
  if(stats&&typeof stats==='object')Object.assign(stats,drop);
  return deduped;
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
  const data=await getBootstrap();
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



function buildRecencySummary(discovery,articleDocs){
  const landingCoverage=discovery.length
    ? discovery.reduce((a,d)=>a+Number(d.timestampCoverage||0),0)/discovery.length
    : 0;
  const dated=articleDocs.filter(d=>Number(d.publishedAt)>0);
  const articleCoverage=articleDocs.length?dated.length/articleDocs.length:0;
  const landingUsable=landingCoverage>=RECENCY_COVERAGE_MIN;
  return {
    mode: landingUsable ? 'landing-timestamps' : (dated.length ? 'article-confirmed' : 'landing-order'),
    landingCoverage:Number(landingCoverage.toFixed(2)),
    landingCoveragePct:Math.round(landingCoverage*100),
    articleCoverage:Number(articleCoverage.toFixed(2)),
    articleCoveragePct:Math.round(articleCoverage*100),
    articlesDated:dated.length,
    articleDocuments:articleDocs.length,
    label: landingUsable
      ? `landing ${Math.round(landingCoverage*100)}% · ${dated.length}/${articleDocs.length} articles dated`
      : `${dated.length?'article-confirmed':'landing-order'} · ${dated.length}/${articleDocs.length} articles dated`,
    publisherStructureLimited:!landingUsable
  };
}

// Source retrieval and evidence replacement are deliberately separate states.
// A scan can read every selected article and still be non-authoritative when
// the later role-extraction step times out. Keep the replacement safeguard as
// strict as before while making the retrieval result independently observable.
function sourceReadState({articleDocuments=0,attempted=0,browserQuotaExhausted=false,aiStatus='not-needed'}={}){
  const sourceDocumentsRead=Math.max(0,Number(articleDocuments)||0);
  const sourceDocumentsAttempted=Math.max(0,Number(attempted)||0);
  const coverage=sourceDocumentsAttempted?sourceDocumentsRead/sourceDocumentsAttempted:0;
  const sourceCoverageSufficient=sourceDocumentsRead>0
    && !browserQuotaExhausted
    && (sourceDocumentsRead>=3||coverage>=0.5);
  return {
    sourceDocumentsRead,
    sourceDocumentsAttempted,
    coverage,
    sourceCoverageSufficient,
    evidenceAuthoritative:aiStatus==='ok'&&sourceCoverageSufficient
  };
}

async function scanTeam(env,team,{force=false,profile='foreground'}={}){
  team=String(team||'').toUpperCase();
  const club=CLUB_SOURCES[team];
  if(!club)throw new Error(`Unsupported team code: ${team}`);
  profile=['foreground','background','scheduled'].includes(profile)?profile:'foreground';

  const cacheKey=`latest:${team}`;
  if(!force){
    const cached=await env.ROLE_KV.get(cacheKey,'json');
    if(cached)return {...cached,cache:'HIT'};
  }

  const background=profile==='background';
  const configuredBrowserBudget=Number.isFinite(Number(env.BROWSER_BUDGET))
    ? Math.max(0,Number(env.BROWSER_BUDGET))
    : DEFAULT_BROWSER_BUDGET;
  // An HTTP waitUntil task is cancelled 30 seconds after the response. Keep
  // stale-while-revalidate scans below that ceiling and reserve them for
  // deterministic discovery; cron/manual scans perform full AI extraction.
  const scanEnv=background?{
    ...env,
    SCAN_BUDGET_MS:Math.min(Math.max(10000,Number(env.SCAN_BUDGET_MS)||DEFAULT_SCAN_BUDGET_MS),BACKGROUND_SCAN_BUDGET_MS),
    BROWSER_BUDGET:Math.min(1,configuredBrowserBudget)
  }:env;
  const budget=makeBudget(scanEnv);
  const roster=await fplContext(env,team);
  const configuredMax=Math.max(3,Math.min(12,Number(env.MAX_ARTICLES_PER_SCAN)||8));
  const max=background?Math.min(BACKGROUND_MAX_ARTICLES,configuredMax):configuredMax;

  const documents=[];
  const errors=[];
  const warnings=[];
  const discovery=[];
  const perUrl=[];
  // Start the supplemental feed beside official-site discovery so its bounded
  // network wait does not extend the scan's critical path. A provider failure
  // is captured as diagnostics and can never clear official or carried evidence.
  const structuredFeedPromise=structuredFeedForTeam(env,team,roster.current.players,{profile,force}).catch(e=>({
    status:'error',enabled:true,feedVersion:STRUCTURED_FEED_VERSION,providers:[],events:[],sources:[],unmatched:[],
    errors:[e?.message||String(e)],diagnostics:{stage:'unexpected'}
  }));
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
        embeddedCards:record.embeddedCards,
        embeddedBreakdown:record.embeddedBreakdown,
        sitemapUsed:record.sitemapUsed,
        sitemapCache:record.sitemapCache,
        sitemapDocuments:record.sitemapDocuments,
        sitemapLinks:record.sitemapLinks,
        sitemapCandidates:record.sitemapCandidates,
        sitemapError:record.sitemapError,
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
        warnings.push(`${landing.url}: landing loaded, but ${landing.links.length} discovered links produced no first-team article candidates`);
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
  const recencySummary=buildRecencySummary(discovery,articleDocs);
  const currentClubEvents=fastPathClubEvents(team,club.name,articleDocs);
  const priorClubEvents=await loadClubEventLedger(env,team);
  const priorLatest=await env.ROLE_KV.get(cacheKey,'json');
  const priorLatestClubEvents=Array.isArray(priorLatest?.clubEvents)?priorLatest.clubEvents:[];
  const clubEvents=mergeClubEventRows([...currentClubEvents,...priorClubEvents,...priorLatestClubEvents]);
  try{await saveClubEventLedger(env,team,clubEvents)}catch{}
  // Persist this before the model call. Even if Workers AI is slow or the
  // request disconnects, confirmed outgoing transfers are already reflected
  // in both the News ledger and the direct-availability overlay.
  let departureEvents=confirmedDepartureEvidence(team,roster.current.players,clubEvents);
  try{await saveDepartureEvidence(env,team,departureEvents)}catch{}
  // RC5.0.16: a bare catch{} here is exactly what let the TEAMS bug above
  // fail silently on every call for the life of RC5.0.15. Record failures
  // where they can actually be found (mirror-error:<team>), without letting
  // a mirroring problem take down the scan that discovered the transaction.
  try{await mirrorClubTransactions(env,currentClubEvents)}
  catch(e){await env.ROLE_KV.put(`mirror-error:${team}`,JSON.stringify({at:new Date().toISOString(),error:e?.message||String(e)}),{expirationTtl:86400}).catch(()=>{})}
  const transactionDiagnostics=articleDocs.map(d=>{
    const tx=classifyClubEvent(d,club.name);
    return {url:d.url,type:tx.type,actionable:tx.actionable,reason:tx.reason};
  }).filter(x=>x.type!=='unknown');

  // Only run the model when at least one real article was read, and send ONLY
  // the articles. The landing page is a headline list whose every line recurs
  // across the site, so it survives boilerplate stripping intact and would
  // otherwise dominate the model input with ~26k chars of teasers.
  const modelInput=articleDocs;
  let aiResult={events:[],status:'not-needed',elapsedMs:0,error:null};
  if(modelInput.length){
    const configuredAiTimeout=Math.max(1000,Number(env.AI_TIMEOUT_MS)||DEFAULT_AI_TIMEOUT_MS);
    const profileTimeout=background?Math.min(configuredAiTimeout,BACKGROUND_AI_TIMEOUT_MS):configuredAiTimeout;
    const available=Math.max(0,budget.remainingMs()-1200);
    aiResult=available>=1000
      ? await aiExtract(env,team,club.name,roster.current.players,modelInput,roster,{timeoutMs:Math.min(profileTimeout,available)})
      : {events:[],status:'deferred-budget',elapsedMs:0,error:'scan budget was exhausted before Workers AI extraction'};
  }
  const raw=aiResult.events;

  // Information-only transaction recovery.
  // A raw AI event can restore the transaction FACT into clubEvents only when:
  // - the source is one of the official documents actually read,
  // - the subject name is present in that source text,
  // - the event type is a transaction,
  // - the source text itself contains transaction language.
  // It never creates an xMins effect by itself.
  const docByUrl=new Map(modelInput.map(d=>[d.url,d]));
  const aiRecoveredClubEvents=[];
  for(const e of Array.isArray(raw)?raw:[]){
    if(!['signing','departure','loan_in','loan_out','loan_return'].includes(e?.type))continue;
    const d=docByUrl.get(String(e.source||''));
    const subject=cleanText(e.subject).slice(0,100);
    if(!d||!subject)continue;
    if(!isMensFirstTeamSource(d.url,d.text))continue;
    if(subject.length>80||/^the\s+\d|^the\s+\w+[- ]year[- ]old|capped by|under-\d|years? old/i.test(subject))continue;
    const nt=normal(d.text||''),ns=normal(subject);
    if(!nt.includes(ns))continue;
    if(!sourceHasSubjectTransaction(d,subject))continue;
    const tx=classifyClubEvent(d,club.name);
    if(!['signing','departure','loan_in','loan_out','loan_return'].includes(tx.type))continue;
    const counterpartTeam=transactionCounterpart(d,team,tx.type);
    aiRecoveredClubEvents.push({
      id:`club-${hashString([team,tx.type,normal(subject),counterpartTeam].join('|'))}`,
      team,type:tx.type,subject,confidence:0.95,source:d.url,counterpartTeam:counterpartTeam||'',
      reason:`Official ${club.name} ${tx.type.replaceAll('_',' ')} information recovered from a current club article. Role/xMins impact remains separate until player-specific evidence justifies it.`,
      evidenceDate:Number(d.publishedAt)?new Date(Number(d.publishedAt)).toISOString():'',
      detectedAt:new Date().toISOString(),
      firstSeenAt:new Date().toISOString(),
      official:true,fastPath:false,recovered:true,subjectTransactionVerified:true,classificationReason:tx.reason
    });
  }

  // Merge any recovered transaction FACTS into the persistent News ledger before
  // validating player-specific xMins events.
  if(aiRecoveredClubEvents.length){
    const mergedRecovered=mergeClubEventRows([...clubEvents,...aiRecoveredClubEvents]);
    clubEvents.splice(0,clubEvents.length,...mergedRecovered);
    try{await saveClubEventLedger(env,team,clubEvents)}catch{}
    try{await mirrorClubTransactions(env,aiRecoveredClubEvents)}
    catch(e){await env.ROLE_KV.put(`mirror-error:${team}`,JSON.stringify({at:new Date().toISOString(),error:e?.message||String(e)}),{expirationTtl:86400}).catch(()=>{})}
    departureEvents=confirmedDepartureEvidence(team,roster.current.players,clubEvents);
    try{await saveDepartureEvidence(env,team,departureEvents)}catch{}
  }

  const extractionStats={};
  const modelEvents=validateEvents(team,roster.current.players,raw,modelInput,extractionStats);
  const structuredFeed=await structuredFeedPromise;
  const structuredEvents=Array.isArray(structuredFeed.events)?structuredFeed.events:[];
  if(['error','partial'].includes(structuredFeed.status)){
    for(const error of structuredFeed.errors||[])errors.push(`Structured feed: ${error}`);
  }
  const scanEvents=mergeRoleEvidence([...modelEvents,...departureEvents,...structuredEvents]);

  const browserFallbackUsed=perUrl.some(x=>x.browserUsed)||discovery.some(d=>d.browserUsed);

  // ---- Evidence authority -------------------------------------------------
  // A scan is AUTHORITATIVE only if it read a meaningful share of the articles
  // it set out to read. Reading 1 of 8 because the browser allowance ran out is
  // NOT grounds for clearing evidence that an earlier full scan gathered.
  const {
    sourceDocumentsRead,
    sourceDocumentsAttempted,
    coverage,
    sourceCoverageSufficient,
    evidenceAuthoritative
  }=sourceReadState({
    articleDocuments:articleDocs.length,
    attempted,
    browserQuotaExhausted:budget.quotaExhausted,
    aiStatus:aiResult.status
  });
  const maxCarryMs=Math.max(1,Number(env.MAX_CARRY_DAYS)||7)*86400000;

  const nonAuthoritativeReason=sourceCoverageSufficient
    ? `Role extraction was not authoritative (${aiResult.status}) after reading ${sourceDocumentsRead} of ${sourceDocumentsAttempted} current article document(s)`
    : budget.quotaExhausted
      ? `The Browser Run daily allowance was exhausted after reading ${sourceDocumentsRead} of ${sourceDocumentsAttempted} article document(s)`
      : `Source coverage was incomplete (${sourceDocumentsRead} of ${sourceDocumentsAttempted} article document(s) read)`;

  let finalEvents=scanEvents;
  let evidenceGeneratedAt=new Date().toISOString();
  let evidenceCarriedForward=false;
  let evidenceNote=evidenceAuthoritative
    ? `Evidence derived from ${articleDocs.length} of ${attempted} article document(s) read in this scan.`
    : `${nonAuthoritativeReason}; confirmed club transactions were still processed deterministically.`;

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
      finalEvents=mergeRoleEvidence([...stillValid,...departureEvents,...structuredEvents]);
      evidenceGeneratedAt=prior.evidenceGeneratedAt||prior.generatedAt;
      evidenceCarriedForward=true;
      const ageDays=Math.floor((Date.now()-anchor)/86400000);
      const dropped=priorEvents.length-stillValid.length;
      evidenceNote=`${nonAuthoritativeReason}, so ${stillValid.length} evidence item(s) from ${ageDays} day(s) ago were retained rather than cleared`
        +(dropped?`; ${dropped} were dropped because the player is no longer in the club's FPL roster.`:'.');
    }else if(priorEvents.length){
      evidenceNote=withinCarryWindow
        ? `${nonAuthoritativeReason}, and no previous evidence remained valid against the current roster.`
        : `${nonAuthoritativeReason}, and the previous evidence has aged out of the carry-forward window.`;
    }
  }

  if(structuredEvents.length)evidenceNote+=` The structured feed contributed ${structuredEvents.length} direct event(s); no tactical role or beneficiary was inferred.`;

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
    sourceDocumentsRead,
    sourceDocumentsAttempted,
    sourceCoverageSufficient,
    sourcesScanned:[...new Set([...useful.map(d=>d.url),...(structuredFeed.sources||[])])],
    // sourceErrors stays reserved for conditions worth surfacing in the UI —
    // the frontend styles the panel 'warn' whenever this array is non-empty.
    sourceErrors:errors.slice(0,10),
    // Discovery gaps are not network failures. Expose them separately so a
    // successful landing request is never reported to users as a failed source.
    discoveryWarnings:warnings.slice(0,10),
    diagnostics:{
      discovery,
      linksFound,
      candidates:candidateCount,
      attempted,
      documentsRead:retrieved.length,      // retained for frontend compatibility
      documentsUsed:useful.length,
      articleDocuments:articleDocs.length,
      sourceDocumentsRead,
      sourceDocumentsAttempted,
      sourceCoverageSufficient,
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
      acceptedEvents:scanEvents.length,
      modelAcceptedEvents:modelEvents.length,
      confirmedDepartureGuards:departureEvents.length,
      structuredFeedStatus:structuredFeed.status,
      structuredEvents:structuredEvents.length,
      structuredAvailabilityEvents:structuredFeed.diagnostics?.availabilityEvents||0,
      structuredLineupEvents:structuredFeed.diagnostics?.lineupEvents||0,
      structuredSelectionEvents:structuredFeed.diagnostics?.selectionEvents||0,
      extraction:extractionStats,
      /* What the model actually SEES. Every layer above this was verified and
         exonerated while this stayed assumed. If none of the supplied
         documents contain selection or availability language, a zero is the
         model behaving CORRECTLY and the real fault is upstream in which
         articles discovery chose -- a completely different repair. URLs and
         lengths only; no article text is exposed. */
      aiDocuments:(Array.isArray(modelInput)?modelInput:[]).slice(0,12).map(d=>{
        const text=String(d?.text||'');
        return {
          url:d?.url||null,chars:text.length,
          hasSelectionLanguage:/\b(?:start(?:s|ed|ing)?|line[- ]?up|lined up|xi|bench(?:ed)?|rested|substitut|kept his place|first choice|recalled|dropped|omitted)\b/i.test(text),
          hasAvailabilityLanguage:/\b(?:injur|fit(?:ness)?|doubt|ruled out|unavailable|sidelined|assessed|knock|suspend|miss(?:es|ed)?\b|return(?:s|ed|ing)?)\b/i.test(text),
          hasNamedPlayer:(roster?.current?.players||[]).some(pl=>normal(text).includes(normal(pl.name))),
        };
      }),
      // Prompt sizing travels with the yield: a context overrun is invisible
      // from the outside and reads exactly like a model that found nothing.
      aiPromptChars:aiResult.promptChars??null,
      aiDocChars:aiResult.docChars??null,
      aiDocCount:aiResult.docCount??null,
      aiMaxOutputTokens:aiResult.maxOutputTokens??null,
      aiElapsedMs:aiResult.elapsedMs??null,
      structuredProviders:structuredFeed.providers||[],
      structuredFeedErrors:(structuredFeed.errors||[]).slice(0,10),
      structuredFeedUnmatched:(structuredFeed.unmatched||[]).slice(0,40),
      structuredFeed:structuredFeed.diagnostics||{},
      aiStatus:aiResult.status,
      aiElapsedMs:aiResult.elapsedMs,
      aiError:aiResult.error||null,
      rawCompetitionEvents:Array.isArray(raw)?raw.filter(e=>['signing','departure','loan_in','loan_out','injury','return'].includes(e?.type)).length:0,
      acceptedCompetitionEvents:modelEvents.filter(e=>['signing','departure','injury','return'].includes(e?.type)).length,
      workerOwnedEvidenceDates:scanEvents.filter(e=>!!e.evidenceDate).length,
      confirmedClubEvents:clubEvents.length,
      recoveredClubEvents:clubEvents.filter(e=>e.recovered).length,
      mirroredClubEvents:clubEvents.filter(e=>e.mirrored).length,
      canonicalTransactionCount:mergeClubEventRows(clubEvents).length,
      preseasonCalibratedEvents:modelEvents.filter(e=>e.preseasonCalibrated).length,
      nonMensClubEventsSuppressed:transactionDiagnostics.filter(x=>x.type==='non_mens').length,
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
      recencySummary,
      publisherStructureNote:recencySummary.publisherStructureLimited
        ? 'Landing page exposes insufficient per-link timestamps; final freshness is confirmed from article publication metadata when available.'
        : 'Landing page exposes sufficient per-link timestamps for timestamp-based discovery ranking.',
      articleDatesRecovered:articleDocs.filter(d=>Number(d.articlePublishedAt)).length,
      landingDatesUsed:articleDocs.filter(d=>!Number(d.articlePublishedAt)&&Number(d.landingPublishedAt)).length,
      undatedArticleDocs:articleDocs.filter(d=>!Number(d.publishedAt)).length,
      failedCandidatesRetainedForRetry:perUrl.filter(x=>x.kind==='article'&&x.processedOk===false).length,
      mutableArticlesRevalidated:perUrl.filter(x=>x.revalidated).length,

      dynamicDiscoveryEscalated:discovery.some(d=>d.dynamicEscalated),
      dynamicEscalationReasons:[...new Set(discovery.map(d=>d.dynamicEscalationReason).filter(Boolean))],
      embeddedArticleCards:discovery.reduce((a,d)=>a+Number(d.embeddedCards||0),0),
      sitemapDiscoveryUsed:discovery.some(d=>d.sitemapUsed),
      sitemapLinks:discovery.reduce((a,d)=>a+Number(d.sitemapLinks||0),0),
      sitemapCandidates:discovery.reduce((a,d)=>a+Number(d.sitemapCandidates||0),0),
      discoveryWarnings:warnings.slice(0,10),
      staticUnprocessedCandidates:discovery.reduce((a,d)=>a+Number(d.staticUnprocessedCandidates||0),0),
      renderedUnprocessedCandidates:discovery.reduce((a,d)=>a+Number(d.renderedUnprocessedCandidates||0),0),
      perUrl:perUrl.slice(0,60),
      eventsFromThisScan:scanEvents.length,
      evidenceAuthoritative,
      evidenceCarriedForward,
      timestampCoverage:recencySummary.landingCoverage,
      recencyRankingUsed: discovery.some(d=>d.recencyUsed),
      scanMode:profile==='foreground'?(force?'forced-live':'foreground'):profile,
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
  const calibratableEvents=mergeRoleEvidence([...modelEvents,...structuredEvents]);
  if(calibratableEvents.length){try{await recordCalibrationRows(env,team,calibratableEvents,roster)}catch{}}

  await env.ROLE_KV.put(cacheKey,JSON.stringify(payload),{expirationTtl:60*60*24*14});
  return payload;
}

/* -------------------------------------------------------------- surfaces */

/* RC5.0.16 -- ONE TRANSACTION TRUTH LAYER.
 *
 * Root cause of the RC5.0.15 defects (Bruno/Newcastle mirror missing,
 * Jessie Gale contamination, Horniceck/Yirenkyi duplicates, historical bad
 * records surviving the new validator): every client-facing route returned
 * `report.clubEvents` -- a snapshot frozen into `latest:${team}` at the
 * moment of the LAST SCAN of that specific club -- while the canonical
 * ledger at `club-events:${team}` (which loadClubEventLedger/
 * mergeClubEventRows re-validates and re-deduplicates on every single read)
 * was written correctly by both scanTeam and mirrorClubTransactions but was
 * never read back by any client-facing endpoint. It was write-only.
 *
 * That explains all four defects as one bug:
 *  - a cross-club mirror lands correctly in the counterpart club's ledger,
 *    but only that club's OWN next scan would ever merge it into that
 *    club's served snapshot -- which may not happen for days.
 *  - a malformed subject rejected by today's validator during a scan stays
 *    visible forever if it was ever written into a snapshot, because the
 *    snapshot is served verbatim and never re-validated.
 *  - two spellings/extractions of one signing can each get merged into
 *    *different* club snapshots at *different* times and never collapse,
 *    because collapsing only happens inside a scan's merge step, which the
 *    read path skips entirely.
 *
 * The fix is not another special case: every place that hands clubEvents to
 * a client now overlays a fresh ledger read (loadClubEventLedger) on top of
 * whatever the frozen snapshot says. This is one extra KV read -- no
 * Browser Run cost, no change to scan cadence or budget -- and it makes it
 * structurally impossible for a served response to diverge from the
 * validated canonical ledger, regardless of how stale the snapshot is or
 * which club's scan last touched it.
 */
async function withCurrentClubEvents(env,team,report){
  if(!report)return report;
  const [clubEvents,directEvents]=await Promise.all([
    loadClubEventLedger(env,team).catch(()=>null),
    loadDepartureEvidence(env,team).catch(()=>null)
  ]);
  const next={...report};
  if(clubEvents!==null)next.clubEvents=clubEvents;
  const base=(Array.isArray(report.events)?report.events:[])
    .filter(e=>!String(e?.originType||'').startsWith('confirmed_'))
    .map(normalizeFriendlyEvidenceEvent);
  next.events=directEvents!==null?mergeRoleEvidence([...base,...directEvents]):mergeRoleEvidence(base);
  return next;
}

async function allLatest(env){
  const out={};
  for(const team of Object.keys(CLUB_SOURCES)){
    const x=await env.ROLE_KV.get(`latest:${team}`,'json');
    if(x)out[team]=await withCurrentClubEvents(env,team,x);
  }
  return out;
}

function reportAgeMs(report){
  const t=Date.parse(report?.generatedAt||'');
  return Number.isFinite(t)?Math.max(0,Date.now()-t):Infinity;
}

/** Wraps scanTeam so two callers cannot burn the browser allowance twice on the
 *  same club. A blocked caller gets the cached report rather than an error. */
async function scanTeamGuarded(env,team,{profile='foreground'}={}){
  const lockToken=await acquireScanLock(env,team);
  if(!lockToken){
    const cached=await env.ROLE_KV.get(`latest:${team}`,'json');
    if(cached)return withCurrentClubEvents(env,team,{...cached,status:'ok',scanLocked:true,scanExecuted:false,lockNote:'a scan for this club was already in progress',cache:'HIT',refreshing:true});
    throw new Error(`A scan for ${team} is already in progress. Try again shortly.`);
  }
  try{
    const report=await scanTeam(env,team,{force:true,profile});
    return withCurrentClubEvents(env,team,{...report,scanExecuted:true});
  }finally{
    await releaseScanLock(env,team,lockToken);
  }
}

async function cacheFirstTeamReport(env,team,ctx,{force=false}={}){
  team=String(team||'').toUpperCase();
  if(force){
    /* A forced scan renders pages and reads articles, so it routinely outruns
       the caller's HTTP timeout. Without waitUntil the request context is torn
       down the moment the client gives up and the scan dies before it persists
       -- while still holding the club's scan lock for its full TTL. The user
       then retries, gets 'a scan for this club was already in progress', and
       the report never advances. Observed three times in a row against BHA.
       The stale-refresh path below already had this protection; the forced
       path, which is the one a person actually triggers from the UI, did not. */
    const scan=scanTeamGuarded(env,team,{profile:'foreground'});
    ctx?.waitUntil?.(scan.catch(()=>{}));
    return scan;
  }

  const cached=await env.ROLE_KV.get(`latest:${team}`,'json');
  if(!cached)return scanTeamGuarded(env,team,{profile:'foreground'});

  // Transfer-window reports must not look current for most of a working day.
  // A request after 90 minutes returns the cache immediately, then schedules
  // the bounded background scan that the HTML auto-polls to completion.
  const staleAfterMs=Math.max(15,Number(env.STALE_AFTER_MINUTES)||90)*60*1000;
  const stale=reportAgeMs(cached)>staleAfterMs;
  const refreshScheduled=!!(stale&&ctx?.waitUntil);
  if(refreshScheduled){
    ctx.waitUntil(scanTeamGuarded(env,team,{profile:'background'}).catch(async error=>{
      await env.ROLE_KV.put(`error:${team}`,JSON.stringify({at:new Date().toISOString(),error:error?.message||String(error)}),{expirationTtl:86400});
    }));
  }
  // The team's OWN scan may not run again for hours (or, for a quiet club,
  // days). A transaction can legitimately reach this team's truth through a
  // DIFFERENT club's scan -- via mirrorClubTransactions -- entirely between
  // this team's own scans. Cache hits must not wait for that scan to arrive.
  return withCurrentClubEvents(env,team,{
    ...cached,cache:'HIT',stale,refreshing:refreshScheduled,
    refreshDeferred:stale&&!refreshScheduled,
    refreshAfterMs:refreshScheduled?3000:null
  });
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

/* ----------------------------------------------------- Fresh Squad Review */

const FRESH_REVIEW_VERSION='1.2.0';
const FRESH_CLASSIFICATIONS=new Set(['STRONG UPGRADE','UPGRADE','AGREE','MONITOR','DOWNGRADE','STRONG DOWNGRADE','UNKNOWN']);
const FRESH_STATUSES=new Set(['GREEN','AMBER','RED','OPPORTUNITY']);
const FRESH_CHIPS=new Set(['NONE','BENCH_BOOST','TRIPLE_CAPTAIN','FREE_HIT','WILDCARD']);
const FRESH_JOB_TTL_SECONDS=60*60*24*7;
const FRESH_NEWS_MAX_ITEMS=6;

function activeChipValue(value){
  const key=String(value||'NONE').trim().toUpperCase().replace(/[\s-]+/g,'_');
  const aliases={BB:'BENCH_BOOST',BENCHBOOST:'BENCH_BOOST',TC:'TRIPLE_CAPTAIN',TRIPLECAPTAIN:'TRIPLE_CAPTAIN',FH:'FREE_HIT',FREEHIT:'FREE_HIT',WC:'WILDCARD',NO_CHIP:'NONE'};
  const resolved=aliases[key]||key;
  return FRESH_CHIPS.has(resolved)?resolved:'NONE';
}
function freshPosition(value){
  const key=String(value||'').trim().toUpperCase();
  return ({GK:'GKP',GOALKEEPER:'GKP',GKP:'GKP',DEFENDER:'DEF',DEF:'DEF',MIDFIELDER:'MID',MID:'MID',FORWARD:'FWD',FWD:'FWD',STRIKER:'FWD'})[key]||key;
}
function freshRole(value){return /^(XI|START|STARTER|STARTING)/i.test(String(value||''))?'XI':'BENCH'}
function normalProbability(value){
  let n=Number(value);if(!Number.isFinite(n))return null;
  if(n>1&&n<=100)n/=100;
  return clamp(n,0,1);
}
function finiteOr(value,fallback=0){const n=Number(value);return Number.isFinite(n)?n:fallback}
function cleanAlert(alert){
  if(typeof alert==='string')return {message:cleanText(alert).slice(0,500)};
  if(!alert||typeof alert!=='object')return null;
  return {code:cleanText(alert.code||'').slice(0,80),severity:cleanText(alert.severity||alert.level||'').toUpperCase().slice(0,20),message:cleanText(alert.message||alert.text||alert.title||'').slice(0,500)};
}

/** Validate the legal FPL 15 before any external resource is spent. */
function validateFreshReviewContext(raw){
  const errors=[];
  const source=raw&&typeof raw==='object'?raw:{};
  const inputPlayers=Array.isArray(source.players)?source.players:[];
  if(inputPlayers.length!==15)errors.push('A valid Fresh Review requires exactly 15 players.');
  const players=inputPlayers.slice(0,15).map((p,index)=>{
    const playerId=String(p?.playerId??p?.id??'').trim();
    const position=freshPosition(p?.position||p?.pos);
    const squadRole=freshRole(p?.squadRole||p?.role||(index<11?'XI':'BENCH'));
    const benchOrder=squadRole==='BENCH'?Math.max(1,Math.min(4,Math.round(finiteOr(p?.benchOrder,p?.order??index-10)))):null;
    return {
      playerId,name:cleanText(p?.name||p?.webName||p?.playerName).slice(0,100),
      club:String(p?.club||p?.team||'').trim().toUpperCase().slice(0,8),position,squadRole,benchOrder,
      captain:Boolean(p?.captain),viceCaptain:Boolean(p?.viceCaptain),
      xPts:Number(finiteOr(p?.xPts??p?.projectedPoints,0).toFixed(2)),
      // xMins is a gameweek total, so doubles can legitimately exceed 90.
      expectedMinutes:Number(clamp(p?.expectedMinutes??p?.xMins,0,240).toFixed(1)),
      startProbability:normalProbability(p?.startProbability??p?.startProb),
      availability:normalProbability(p?.availability??1)
    };
  });
  const ids=players.map(p=>p.playerId);
  if(ids.some(id=>!id))errors.push('Every player requires a playerId.');
  if(new Set(ids).size!==ids.length)errors.push('Player IDs must be unique.');
  for(const p of players){
    if(!p.name)errors.push(`Player ${p.playerId||'?'} requires a name.`);
    if(!CLUB_SOURCES[p.club])errors.push(`${p.name||p.playerId}: unsupported club code ${p.club||'(blank)'}.`);
    if(!['GKP','DEF','MID','FWD'].includes(p.position))errors.push(`${p.name||p.playerId}: invalid position ${p.position||'(blank)'}.`);
    if(p.startProbability===null)errors.push(`${p.name||p.playerId}: start probability is required.`);
    if(p.availability===null)errors.push(`${p.name||p.playerId}: availability is required.`);
  }
  const counts=Object.fromEntries(['GKP','DEF','MID','FWD'].map(pos=>[pos,players.filter(p=>p.position===pos).length]));
  if(counts.GKP!==2||counts.DEF!==5||counts.MID!==5||counts.FWD!==3)errors.push('Squad must contain 2 GKP, 5 DEF, 5 MID and 3 FWD.');
  if(players.filter(p=>p.squadRole==='XI').length!==11||players.filter(p=>p.squadRole==='BENCH').length!==4)errors.push('Squad must contain a starting XI and four bench players.');
  const benchOrders=players.filter(p=>p.squadRole==='BENCH').map(p=>p.benchOrder).sort();
  if(benchOrders.join(',')!=='1,2,3,4')errors.push('Bench order must contain positions 1 through 4 exactly once.');
  const captainId=String(source.captainId??players.find(p=>p.captain)?.playerId??'');
  const viceCaptainId=String(source.viceCaptainId??players.find(p=>p.viceCaptain)?.playerId??'');
  const captain=players.find(p=>p.playerId===captainId),vice=players.find(p=>p.playerId===viceCaptainId);
  if(!captain||captain.squadRole!=='XI')errors.push('Captain must be one of the starting XI.');
  if(!vice||vice.squadRole!=='XI'||viceCaptainId===captainId)errors.push('Vice-captain must be a different member of the starting XI.');
  players.forEach(p=>{p.captain=p.playerId===captainId;p.viceCaptain=p.playerId===viceCaptainId});
  const activeChip=activeChipValue(source.activeChip);
  players.forEach(p=>{p.scoring=activeChip==='BENCH_BOOST'||p.squadRole==='XI'});
  const gameweek=Math.round(finiteOr(source.gameweek,0));
  if(gameweek<1||gameweek>60)errors.push('Selected gameweek must be between 1 and 60.');
  const deadline=source.deadline&&Number.isFinite(Date.parse(source.deadline))?new Date(source.deadline).toISOString():null;
  const context={
    season:cleanText(source.season||'2026/27').slice(0,20),gameweek,activeChip,
    formation:cleanText(source.formation||'').slice(0,20),captainId,viceCaptainId,deadline,
    players,otbAlerts:(Array.isArray(source.otbAlerts)?source.otbAlerts:[]).map(cleanAlert).filter(x=>x?.message).slice(0,50)
  };
  return {ok:errors.length===0,errors,context};
}

function freshCommonIdentityName(element){
  if(!element)return '';
  const first=cleanText(element.first_name).split(' ')[0]||'',second=cleanText(element.second_name),web=cleanText(element.web_name),full=cleanText(`${element.first_name||''} ${element.second_name||''}`);
  if(!web)return full;
  const dot=web.indexOf('.');if(dot>=0){const suffix=cleanText(web.slice(dot+1));return cleanText(`${first} ${suffix}`)||full}
  const secondWords=normal(second).split(' ').filter(Boolean),webNormal=normal(web),firstNormal=normal(first);
  if(webNormal===firstNormal)return full;
  if(secondWords.includes(webNormal)||secondWords.join(' ')===webNormal)return cleanText(`${first} ${web}`);
  // Nicknames/mononyms that are not a token of the legal surname are the name
  // supporters and publishers actually use (for example Beto).
  return web;
}
function freshIdentityAliases(player,element=null){
  const canonicalName=cleanText(element?`${element.first_name||''} ${element.second_name||''}`:player.canonicalName||'').trim();
  const commonName=cleanText(element?freshCommonIdentityName(element):player.searchName||'').trim();
  const webName=cleanText(element?.web_name||player.webName||'').trim();
  return [...new Set([canonicalName,commonName,webName,cleanText(player.name)].filter(Boolean).map(value=>value.slice(0,100)))];
}
/** Resolve the browser's compact display names against the authoritative FPL
 *  element ID. The display name is preserved for OTB; only research identity
 *  and matching use the canonical full name. */
function enrichFreshReviewIdentitiesFromBootstrap(context,data){
  const elements=new Map((data?.elements||[]).map(element=>[String(element.id),element]));
  const teams=new Map((data?.teams||[]).map(team=>[team.id,teamCodeFromFplTeam(team)]));
  return {
    ...context,
    players:context.players.map(player=>{
      const element=elements.get(String(player.playerId))||null;
      const aliases=freshIdentityAliases(player,element),searchName=freshCommonIdentityName(element)||player.searchName||aliases[0]||player.name;
      const canonicalName=aliases[0]||player.name;
      const identityClub=element?teams.get(element.team)||null:null;
      // FPL's broad DEF/MID/FWD buckets are not tactical roles. Goalkeeper is
      // the only safe roster-level peer set; outfield competition requires an
      // explicit role relationship until a tactical-role feed is available.
      const competitionAliases=element&&element.element_type===1?(data?.elements||[]).filter(peer=>peer.id!==element.id&&peer.team===element.team&&peer.element_type===1).flatMap(peer=>freshIdentityAliases({},peer)).filter(Boolean):[];
      return {
        ...player,canonicalName,webName:cleanText(element?.web_name||player.webName||player.name).slice(0,100),
        searchName:cleanText(searchName).slice(0,100),identityAliases:aliases,identitySource:element?'FPL_BOOTSTRAP':'OTB_CONTEXT',
        identityClub,identityClubMismatch:Boolean(identityClub&&identityClub!==player.club),competitionAliases:[...new Set(competitionAliases)].slice(0,16)
      };
    })
  };
}
async function enrichFreshReviewIdentities(context){
  try{return enrichFreshReviewIdentitiesFromBootstrap(context,await getBootstrap())}
  catch{return enrichFreshReviewIdentitiesFromBootstrap(context,null)}
}

function stableJson(value){
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function freshContextHash(context){return sha256Hex(stableJson(context))}
function freshPlayerSignature(player){return stableJson({playerId:player.playerId,club:player.club,position:player.position,squadRole:player.squadRole,benchOrder:player.benchOrder,captain:player.captain,viceCaptain:player.viceCaptain,xPts:player.xPts,expectedMinutes:player.expectedMinutes,startProbability:player.startProbability,availability:player.availability})}
function freshContextDiff(previous,current){
  const before=new Map((previous?.players||[]).map(p=>[String(p.playerId),p]));
  const after=new Map((current?.players||[]).map(p=>[String(p.playerId),p]));
  const added=[...after.keys()].filter(id=>!before.has(id));
  const removed=[...before.keys()].filter(id=>!after.has(id));
  const changed=[...after.keys()].filter(id=>before.has(id)&&freshPlayerSignature(before.get(id))!==freshPlayerSignature(after.get(id)));
  const chipChanged=activeChipValue(previous?.activeChip)!==activeChipValue(current?.activeChip);
  return {added,removed,changed,chipChanged,hasChanges:Boolean(added.length||removed.length||changed.length||chipChanged)};
}
function freshCacheMinutes(context,now=Date.now()){
  const deadline=Date.parse(context?.deadline||'');
  if(!Number.isFinite(deadline))return 180;
  const hours=(deadline-now)/3600000;
  if(hours<=2)return 20;
  if(hours<=6)return 45;
  if(hours<=48)return 180;
  return 360;
}
function freshProjectedTotal(context){
  const base=context.players.filter(p=>p.scoring).reduce((sum,p)=>sum+finiteOr(p.xPts,0),0);
  const captain=context.players.find(p=>p.captain);
  const extra=finiteOr(captain?.xPts,0)*(context.activeChip==='TRIPLE_CAPTAIN'?2:1);
  return Number((base+extra).toFixed(2));
}

function decodeXml(value){return String(value||'').replace(/^<!\[CDATA\[|\]\]>$/g,'').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim()}
function stripXml(value){return cleanText(decodeXml(String(value||'').replace(/<[^>]*>/g,' ')))}
function xmlTag(block,tag){const hit=String(block||'').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));return hit?stripXml(hit[1]):''}
function freshPublisherTier(publisher,url,title=''){
  const host=hostOf(url);
  const officialHosts=new Set([...Object.values(CLUB_SOURCES).flatMap(c=>c.urls.map(hostOf)),'premierleague.com','fantasy.premierleague.com','thefa.com','efl.com','uefa.com','fifa.com']);
  const publisherName=normal(publisher).replace(/^www\s+/,'');
  const officialNames=new Set([
    ...Object.values(CLUB_SOURCES).flatMap(c=>{const value=normal(c.name);return [value,`${value} fc`,`${value} football club`]}),
    'premier league','fantasy premier league','the football association','the fa','english football league','the english football league','efl','uefa','fifa'
  ]);
  // Authority is source-owned. A headline containing "official club" must
  // never promote an aggregator or supporter site to Tier 1.
  if(officialHosts.has(host)||officialNames.has(publisherName))return 1;
  const hay=normal(`${publisher} ${host}`);void title;
  if(/rotowire|\bbbc\b|sky sports|the athletic|guardian|telegraph|independent|reuters|associated press|espn|new york times|the times|mail sport|liverpool echo|manchester evening news|evening standard|standard co uk|yorkshire evening post|chronicle live|football london|pa media|optus sport|the argus|sussex world|fantasy football scout/.test(hay))return 2;
  if(/reddit|supporter|fans? network|fan site|forum|blog|arsenal vision|anfield watch|this is anfield|leeds live|geordie boot boys|roker report|we are brighton|true faith|cartilage free captain|royal blue mersey|toffeeweb/.test(hay))return 3;
  return 4;
}
function freshSignal(text,type=''){
  const t=normal(`${type} ${text}`);
  if(/back in training|returned to training|returns? from injury|fit to (?:play|face)|available for|confirmed start|starting xi|starts|first choice|kept (?:his|her) place|played (?:the )?full 90|competitor (?:injured|leaves|departed)/.test(t))return 'positive';
  if(/ruled out|unavailable|suspension|suspended|fitness doubt|doubtful|injury doubt|set to miss|will miss|minutes restricted|confirmed bench|benched|omitted|rotation warning|competition for|selection doubt|not in (?:the )?squad/.test(t))return 'negative';
  return 'neutral';
}
function freshEvidenceCategory(source={}){
  const text=normal(`${source.eventType||source.type||''} ${source.sourceType||''} ${source.title||''} ${source.summary||''}`);
  if(/injur|fitness|available|unavailable|ruled out|doubt|suspension|suspended|illness|concussion|return date|team news/.test(text))return 'AVAILABILITY';
  if(/predicted lineup|predicted line up|predicted xi|likely xi/.test(text))return 'PREDICTED_LINEUP';
  if(/training|trained|recovery session/.test(text))return 'TRAINING';
  if(/confirmed start|confirmed bench|starting xi|starting line up|starting lineup|lineup|line up|starts|started|full 90|substitut|friendly|preseason|pre season/.test(text))return 'LINEUP';
  if(/transfer|signing|signed|joins|joined|move|loan|depart|leaves|left club|competition for|shirt competition|depth chart|hierarchy/.test(text))return 'ROLE_COMPETITION';
  if(/penalt|corner|free kick|set piece/.test(text))return 'SET_PIECE_ROLE';
  if(/tactical|formation|position|role|first choice|minutes pattern/.test(text))return 'TACTICAL_ROLE';
  return 'GENERAL';
}
function freshEvidenceWindowDays(category){return ({AVAILABILITY:21,PREDICTED_LINEUP:7,TRAINING:14,LINEUP:30,ROLE_COMPETITION:120,SET_PIECE_ROLE:120,TACTICAL_ROLE:90,GENERAL:30})[category]||30}
function freshRecency(date,category='GENERAL',now=Date.now()){
  const windowDays=freshEvidenceWindowDays(category),ms=Date.parse(date||'');
  if(!Number.isFinite(ms))return {band:'DATE UNKNOWN',weight:0.08,ageHours:null,windowDays,decisionEligible:false};
  if(ms-now>6*3600000)return {band:'FUTURE DATE',weight:0,ageHours:Math.round((now-ms)/3600000),windowDays,decisionEligible:false};
  const hours=Math.max(0,(now-ms)/3600000);
  const decisionEligible=hours<=windowDays*24;
  if(hours<=24)return {band:'TODAY',weight:1,ageHours:Math.round(hours),windowDays,decisionEligible};
  if(hours<=72)return {band:'1–2 DAYS',weight:0.9,ageHours:Math.round(hours),windowDays,decisionEligible};
  if(hours<=14*24)return {band:'RECENT',weight:0.68,ageHours:Math.round(hours),windowDays,decisionEligible};
  if(decisionEligible){const progress=hours/(windowDays*24);return {band:category==='ROLE_COMPETITION'||category==='TACTICAL_ROLE'||category==='SET_PIECE_ROLE'?'CURRENT ROLE WINDOW':'CURRENT DECISION WINDOW',weight:Number(Math.max(0.34,0.66-progress*0.28).toFixed(3)),ageHours:Math.round(hours),windowDays,decisionEligible}}
  return {band:'HISTORICAL',weight:0.08,ageHours:Math.round(hours),windowDays,decisionEligible:false};
}
function freshSourceWeight(source){
  const authority=({1:1,2:0.78,3:0.52,4:0.25})[Number(source.authorityTier)]||0.2;
  const category=source.evidenceCategory||freshEvidenceCategory(source);
  let weight=authority*freshRecency(source.relevantDate,category).weight;
  if(/final (?:pre-season|preseason)|final friendly/i.test(`${source.title} ${source.summary}`))weight*=1.12;
  else if(/pre-season|preseason|friendly/i.test(`${source.title} ${source.summary}`))weight*=0.82;
  if(source.preferredSource===true)weight*=1.08; // preference within a tier; never outranks Tier 1
  return Number(clamp(weight,0,1).toFixed(3));
}
function freshAnnotateEvidence(source){
  const evidenceCategory=source.evidenceCategory||freshEvidenceCategory(source),recency=freshRecency(source.relevantDate,evidenceCategory);
  const decisionRelevant=source.decisionRelevant!==false&&source.signal!=='neutral'&&evidenceCategory!=='GENERAL';
  const item={...source,evidenceCategory,recency:recency.band,decisionWindowDays:recency.windowDays,decisionEligible:recency.decisionEligible&&decisionRelevant,decisionRelevant};
  return {...item,weight:freshSourceWeight(item)};
}
function freshEvidenceCoverage(evidence){
  const current=evidence.filter(item=>item.decisionEligible===true&&item.decisionRelevant===true&&item.signal!=='neutral'),direct=current.filter(item=>item.hierarchyInference!==true),tier1=direct.filter(item=>Number(item.authorityTier)===1),tier2=direct.filter(item=>Number(item.authorityTier)===2);
  const distinctTier2=new Set(tier2.map(item=>`${normal(item.publisher)}:${hostOf(item.publisherUrl||item.url)}`));
  if(tier1.length||distinctTier2.size>=2)return {status:'VERIFIED',decisionEvidenceCount:current.length,historicalEvidenceCount:evidence.length-current.length,note:tier1.length?'Current direct Tier 1 evidence validates a decision-relevant claim.':'Independent direct Tier 2 reporting supports the same decision-relevant review.'};
  if(current.length)return {status:'PARTIAL',decisionEvidenceCount:current.length,historicalEvidenceCount:evidence.length-current.length,note:current.some(item=>item.hierarchyInference===true)?'Current indirect role-competition evidence was found; it is capped at partial until direct player evidence corroborates it.':'Some current decision-relevant evidence was found, but source depth is not strong enough for independent verification.'};
  return {status:'UNVERIFIED',decisionEvidenceCount:0,historicalEvidenceCount:evidence.length,note:evidence.length?'Only historical or undated context was found; it is retained for audit but cannot drive this gameweek verdict.':'No usable current external evidence was found.'};
}

function officialPlayerEvidence(report,player){
  const targets=new Set((player.identityAliases?.length?player.identityAliases:freshIdentityAliases(player)).map(normal));
  const events=Array.isArray(report?.events)?report.events:[];
  return events.filter(e=>targets.has(normal(e.affected))||targets.has(normal(e.subject))).map((e,index)=>{
    const source=String(e.source||'');
    const type=String(e.type||e.rawType||'official update').replace(/_/g,' ');
    let signal='neutral';
    if(['confirmed_start','observed_role','manager_positive'].includes(e.type))signal='positive';
    if(['confirmed_bench','observed_bench','unavailable','fitness_doubt','minutes_restricted','suspension','manager_negative','rotation_warning','injury'].includes(e.type))signal='negative';
    const tier=freshPublisherTier(report?.club||player.club,source,e.reason||type);
    const item={
      id:`official-${hashString(`${player.playerId}:${e.id||index}:${source}`)}`,title:`${report?.club||player.club}: ${type}`,
      publisher:report?.club||hostOf(source)||'Official source',publisherUrl:source,url:source,
      relevantDate:e.evidenceDate||report?.evidenceGeneratedAt||report?.generatedAt||null,authorityTier:Math.min(2,tier),
      sourceType:'OFFICIAL / STRUCTURED',summary:cleanText(e.reason||`${player.name}: ${type}`).slice(0,500),
      signal,communityInference:false,eventType:e.type||e.rawType||type
    };
    return freshAnnotateEvidence(item);
  });
}

function freshSearchName(player){return cleanText(player.searchName||player.canonicalName||player.name)}
function freshTextHasPhrase(text,phrase){const needle=normal(phrase);return Boolean(needle&&` ${normal(text)} `.includes(` ${needle} `))}
function freshRegExpEscape(value){return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function freshPlayerEvidenceMatches(player,text){
  const hay=cleanText(text),aliases=player.identityAliases?.length?player.identityAliases:freshIdentityAliases(player);
  const primary=normal(player.searchName||player.canonicalName||player.name),primaryParts=primary.split(' ').filter(Boolean);
  for(const alias of aliases){const parts=normal(alias).split(' ').filter(Boolean);if(parts.length>=2&&freshTextHasPhrase(hay,alias))return true}
  const web=normal(player.webName||player.name),surname=primaryParts.at(-1)||normal(player.name).split(' ').filter(Boolean).at(-1)||'';
  const clubName=CLUB_SOURCES[player.club]?.name||'',clubPresent=freshTextHasPhrase(hay,clubName)||freshTextHasPhrase(hay,player.club);
  if(!surname||!freshTextHasPhrase(hay,surname))return false;
  // A compact surname is only safe with club context. If the headline names a
  // different first name (Joe Gomez vs Diego Gomez), reject it explicitly.
  if(primaryParts.length>=2){
    if(!clubPresent)return false;
    const nh=normal(hay),match=nh.match(new RegExp(`\\b([a-z][a-z0-9]+)\\s+${freshRegExpEscape(surname)}\\b`));
    const stop=new Set(['the','for','with','from','after','before','about','and','but','not','new','latest','update','injury','on','of','to','vs']);
    if(match&&match[1]!==primaryParts[0]&&!stop.has(match[1]))return false;
    return true;
  }
  return freshTextHasPhrase(hay,web)||freshTextHasPhrase(hay,player.name);
}
function freshHierarchyPeerMatches(player,text){
  if(player.position!=='GKP'&&player.position!=='GK')return null;
  const hay=cleanText(text),club=CLUB_SOURCES[player.club]?.name||player.club,clubPresent=freshTextHasPhrase(hay,club)||freshTextHasPhrase(hay,player.club);
  if(!clubPresent)return null;
  if(!/first choice|number 1|no 1|preferred starter|backup|goalkeeper|keeper|hierarchy|competition|contract|transfer|depart|leav|join|loan|injur|ruled out|available|starts|starting/i.test(hay))return null;
  for(const alias of player.competitionAliases||[]){
    const parts=normal(alias).split(' ').filter(Boolean),surname=parts.at(-1)||'';
    if(parts.length>=2&&freshTextHasPhrase(hay,alias))return alias;
    if(surname&&freshTextHasPhrase(hay,surname))return alias;
  }
  return null;
}
function freshHierarchySignal(player,text,peerName=''){
  if(freshPlayerEvidenceMatches(player,text))return freshSignal(text);
  const t=normal(text);void peerName;
  if(/(?:not in|outside|out of) (?:the )?(?:manager'?s )?plans|set to (?:leave|join)|ready to (?:leave|join)|close to (?:leaving|joining)|loan-to-buy|loan to buy|transfer|depart|leaves|left club|sold|released/.test(t))return 'positive';
  if(/first choice|number 1|no 1|preferred starter|preferred as (?:the )?starter|starts|starting xi|new contract|contract extension/.test(t))return 'negative';
  return 'neutral';
}
function freshLowQualitySource(publisher,url,title=''){
  const hay=normal(`${publisher} ${hostOf(url)} ${title}`);
  return /\bmshale\b|ysscores|the hans india|roundtable io/.test(hay);
}
function freshNonDecisionStory(text){
  const t=normal(text);
  return /club store|city store|guide dogs?|charity|award|shortlisted|vote for|commercial appearance|meet and greet|podcast appearance/.test(t);
}
function freshStoryFingerprint(item){
  const title=normal(item?.title||'').replace(/\s+-\s+(?:bbc|sky sports|the athletic|the new york times|new york times|guardian|independent|espn|[^-]{2,50})$/,'').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  return `${normal(item?.publisher||'')}:${title}`;
}
function freshNewsQueries(player,now=Date.now()){
  const club=CLUB_SOURCES[player.club]?.name||player.club;
  const name=freshSearchName(player),date=days=>new Date(now-days*86400000).toISOString().slice(0,10);
  const peers=[...new Set((player.competitionAliases||[]).map(cleanText).filter(Boolean))].slice(0,6),queries=[
    `"${name}" "${club}" (injury OR training OR fitness OR "press conference" OR "predicted lineup" OR "starting XI" OR rotation OR RotoWire) after:${date(45)}`,
    `"${name}" "${club}" (role OR competition OR transfer OR signing OR preseason OR penalties OR corners OR "free kicks") after:${date(120)}`
  ];
  if(peers.length)queries.push(`"${club}" (${[name,...peers].map(value=>`"${value}"`).join(' OR ')}) ("first choice" OR "number one" OR goalkeeper OR hierarchy OR transfer OR leaving OR backup OR competition) after:${date(120)}`);
  return queries;
}
function freshNewsQuery(player,now=Date.now()){return freshNewsQueries(player,now)[0]}
function freshNewsDate(value,now=Date.now()){
  value=stripXml(value);if(!value)return null;
  const relative=normal(value).match(/\b(\d+)\s+(minute|hour|day)s?\s+ago\b/);
  if(relative){const unitMs={minute:60000,hour:3600000,day:86400000}[relative[2]];return new Date(now+0-Number(relative[1])*unitMs).toISOString()}
  if(/^today\b/i.test(value))value=value.replace(/^today\b/i,new Date(now).toISOString().slice(0,10));
  if(/^yesterday\b/i.test(value))value=value.replace(/^yesterday\b/i,new Date(now-86400000).toISOString().slice(0,10));
  if(!/\b\d{4}\b/.test(value))value+=` ${new Date(now).getUTCFullYear()}`;
  if(!/\b\d{1,2}:\d{2}(?::\d{2})?/.test(value))value+=' 12:00:00 UTC';
  else if(/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?$/.test(value))value+=' UTC';
  const parsed=Date.parse(value);return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
function freshNewsItem(player,{title,link,relevantDate,publisher,publisherUrl='',summary='',index=0,provider='Google News'}){
  title=stripXml(title);summary=stripXml(summary);link=decodeXml(link);publisher=stripXml(publisher)||provider;
  if(!title||!link||freshLowQualitySource(publisher,publisherUrl,title))return null;
  const evidenceText=`${title} ${summary}`,direct=freshPlayerEvidenceMatches(player,evidenceText),hierarchyPeer=direct?'':freshHierarchyPeerMatches(player,evidenceText);
  if(!direct&&!hierarchyPeer)return null;
  const authorityTier=freshPublisherTier(publisher,publisherUrl,title),preferredSource=/rotowire/i.test(`${publisher} ${publisherUrl} ${title}`);
  const item={
    id:`news-${hashString(`${player.playerId}:${link}:${index}`)}`,title:title.slice(0,240),publisher:publisher.slice(0,120),publisherUrl,
    relevantDate:freshNewsDate(relevantDate),authorityTier,sourceType:authorityTier===3?'COMMUNITY SIGNAL':'NEWS / LINEUP SIGNAL',
    summary:(summary||`Headline signal: ${title}`).slice(0,500),url:link,signal:direct?freshSignal(evidenceText):freshHierarchySignal(player,evidenceText,hierarchyPeer),communityInference:authorityTier>=3||!direct,preferredSource,searchProvider:provider,
    evidenceCategory:direct?undefined:'ROLE_COMPETITION',hierarchyInference:!direct,relatedPlayer:hierarchyPeer||null,decisionRelevant:!freshNonDecisionStory(evidenceText)
  };
  return freshAnnotateEvidence(item);
}
function freshNewsItemsFromRss(xml,player,provider='Google News'){
  const blocks=String(xml||'').match(/<item>[\s\S]*?<\/item>/gi)||[],items=[];
  for(const [index,block] of blocks.entries()){
    const sourceHit=block.match(/<(?:source|News:Source)(?:\s+url="([^"]+)")?[^>]*>([\s\S]*?)<\/(?:source|News:Source)>/i);
    const item=freshNewsItem(player,{title:xmlTag(block,'title'),link:xmlTag(block,'link'),summary:xmlTag(block,'description'),relevantDate:xmlTag(block,'pubDate'),publisher:sourceHit?stripXml(sourceHit[2]):provider,publisherUrl:sourceHit?decodeXml(sourceHit[1]||''):'',index,provider});
    if(item)items.push(item);if(items.length>=FRESH_NEWS_MAX_ITEMS)break;
  }
  return items;
}
function htmlAttr(tag,name){const match=String(tag||'').match(new RegExp(`\\b${name}=["']([^"']+)["']`,'i'));return match?decodeXml(match[1]):''}
function freshNewsItemsFromHtml(markup,player){
  const html=String(markup||''),items=[],anchorRe=/<a\b[^>]*>[\s\S]*?<\/a>/gi;let hit,index=0;
  while((hit=anchorRe.exec(html))){
    const anchor=hit[0];
    if(!/(?:\bclass=["'][^"']*\bJtKRv\b|\bdata-n-tid=["']29["'])/i.test(anchor))continue;
    const href=htmlAttr(anchor,'href'),visible=stripXml((anchor.match(/>([\s\S]*?)<\/a>$/i)||[])[1]||''),aria=htmlAttr(anchor,'aria-label');
    if(!href||!visible)continue;
    let publisher='Google News result',relevantDate='';
    if(aria.startsWith(visible)){
      const tail=aria.slice(visible.length).replace(/^\s*-\s*/,'').split(/\s+-\s+/).filter(Boolean);
      publisher=tail[0]||publisher;relevantDate=tail[1]||'';
    }
    const card=html.slice(Math.max(0,hit.index-1200),Math.min(html.length,hit.index+anchor.length+2600));
    if(!relevantDate){const time=card.match(/<time\b[^>]*(?:datetime|data-time|data-date)=["']([^"']+)["'][^>]*>/i);relevantDate=time?.[1]||''}
    let link='';try{link=new URL(href,'https://news.google.com').toString()}catch{continue}
    const item=freshNewsItem(player,{title:visible,link,relevantDate,publisher,index,provider:'Google News HTML'});
    if(item)items.push(item);index++;if(items.length>=FRESH_NEWS_MAX_ITEMS)break;
  }
  return items;
}
async function freshBrowserSearchPermit(env){
  if(!env.BROWSER?.quickAction)return {allowed:false,reason:'Browser binding unavailable'};
  const cap=Math.max(0,Number(env.FRESH_REVIEW_BROWSER_DAILY_CAP??75)),day=new Date().toISOString().slice(0,10),countKey=`fresh-review:browser-count:${day}`;
  const used=Number(await env.ROLE_KV.get(countKey))||0;if(cap&&used>=cap)return {allowed:false,reason:`daily Fresh Review browser cap of ${cap} reached`};
  const spacing=Math.max(0,Number(env.FRESH_REVIEW_BROWSER_SPACING_MS??6500)),last=Number(await env.ROLE_KV.get('fresh-review:browser-last'))||0,wait=spacing-(Date.now()-last);
  if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
  await Promise.all([
    env.ROLE_KV.put(countKey,String(used+1),{expirationTtl:172800}),
    env.ROLE_KV.put('fresh-review:browser-last',String(Date.now()),{expirationTtl:3600})
  ]);
  return {allowed:true};
}
async function googleNewsEvidence(env,player){
  const queries=freshNewsQueries(player),errors=[],providers=[],collected=[];
  const merge=items=>{for(const item of items||[]){const key=freshStoryFingerprint(item),existing=collected.findIndex(row=>freshStoryFingerprint(row)===key||normal(row.title)===normal(item.title));if(existing<0)collected.push(item);else if(collected[existing].authorityTier>item.authorityTier)collected[existing]=item}};
  for(const query of queries){
    const rssUrl=`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`,htmlUrl=`https://news.google.com/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
    let controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch(rssUrl,{headers:{'User-Agent':'OTB-Fresh-Squad-Review/1.1','Accept':'application/rss+xml,application/xml;q=0.9'},signal:controller.signal});
      if(response.ok){const items=freshNewsItemsFromRss(await response.text(),player);merge(items);if(items.length)providers.push('google-rss')}
      else errors.push(`Google RSS HTTP ${response.status}`);
    }catch(error){errors.push(error?.message||String(error))}finally{clearTimeout(timer)}
    controller=new AbortController();timer=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch(htmlUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; OTB-Fresh-Squad-Review/1.1)','Accept':'text/html,application/xhtml+xml','Accept-Language':'en-GB,en;q=0.9'},redirect:'follow',signal:controller.signal});
      if(response.ok){const items=freshNewsItemsFromHtml(await response.text(),player);merge(items);if(items.length)providers.push('google-html')}
      else errors.push(`Google HTML HTTP ${response.status}`);
    }catch(error){errors.push(error?.message||String(error))}finally{clearTimeout(timer)}
  }
  // Browser Run is the expensive fallback. Use it only when direct public
  // transport failed to produce decision-eligible evidence, and stop as soon
  // as a query does so.
  if(!collected.some(item=>item.decisionEligible))for(const query of queries){
    const htmlUrl=`https://news.google.com/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
    try{
      const permit=await freshBrowserSearchPermit(env);if(!permit.allowed)throw new Error(permit.reason);
      const rendered=await quickActionJson(env,'content',{url:htmlUrl,gotoOptions:GOTO}),markup=typeof rendered==='string'?rendered:(rendered?.content||rendered?.html||''),items=freshNewsItemsFromHtml(markup,player);
      merge(items);if(items.length)providers.push('google-browser');
      if(items.some(item=>item.decisionEligible))break;
      errors.push('Google Browser search returned no current player-specific results');
    }catch(error){errors.push(error?.message||String(error))}
  }
  const items=collected.sort((a,b)=>Number(b.decisionEligible)-Number(a.decisionEligible)||a.authorityTier-b.authorityTier||Number(b.preferredSource)-Number(a.preferredSource)||b.weight-a.weight).slice(0,FRESH_NEWS_MAX_ITEMS);
  if(items.length)return {status:items.some(item=>item.decisionEligible)?'ok':'historical-only',provider:[...new Set(providers)].join('+')||'google-public',query:queries[0],queries,items,error:errors.filter(Boolean).join(' · ').slice(0,600)||null};
  return {status:'error',provider:'unavailable',query:queries[0],queries,items:[],error:errors.filter(Boolean).join(' · ').slice(0,600)};
}

function playerReviewSchema(){return {
  type:'object',additionalProperties:false,
  required:['freshEvidenceSummary','classification','status','confidence','rationale','monitorPoint','evidenceIds'],
  properties:{
    freshEvidenceSummary:{type:'string'},classification:{type:'string',enum:[...FRESH_CLASSIFICATIONS]},
    status:{type:'string',enum:[...FRESH_STATUSES]},confidence:{type:'string',enum:['HIGH','MEDIUM','LOW']},
    rationale:{type:'string'},monitorPoint:{type:'string'},evidenceIds:{type:'array',items:{type:'string'},maxItems:8}
  }
}}
async function aiFreshPlayerReview(env,context,player,evidence){
  if(!env.AI?.run)return {status:'unavailable',value:null,error:'Workers AI binding unavailable'};
  const sources=evidence.map(e=>({id:e.id,tier:e.authorityTier,date:e.relevantDate,recency:e.recency,evidenceCategory:e.evidenceCategory,decisionWindowDays:e.decisionWindowDays,decisionEligible:e.decisionEligible===true,decisionRelevant:e.decisionRelevant===true,weight:e.weight,signal:e.signal,publisher:e.publisher,title:e.title,summary:e.summary,communityInference:e.communityInference,hierarchyInference:e.hierarchyInference===true,relatedPlayer:e.relatedPlayer||null,preferredSource:e.preferredSource===true}));
  const chipNote=context.activeChip==='BENCH_BOOST'?'All 15 score: treat this player as decision-critical.':context.activeChip==='TRIPLE_CAPTAIN'&&player.captain?'Triple Captain: apply enhanced scrutiny to this captain.':player.scoring?'This player scores in the selected gameweek.':'Ordinary bench player: preserve risk information but weight immediate squad impact lower.';
  const prompt=`Audit one Fantasy Premier League selection for gameweek ${context.gameweek}. Compare OTB's quantitative assumption with only the supplied current evidence.\n\nPLAYER: ${player.canonicalName||player.name} (OTB display: ${player.name}; ${player.club}, ${player.position}, ${player.squadRole})\nOTB: ${Math.round(player.startProbability*100)}% start band; ${player.expectedMinutes} xMins; ${player.xPts} xPts; availability ${Math.round(player.availability*100)}%.\nCHIP: ${context.activeChip}. ${chipNote}\n\nEVIDENCE JSON:\n${JSON.stringify(sources)}\n\nRULES:\n- Keep three layers distinct: OTB assumption, external evidence, and verdict.\n- Tier 1 official/confirmed evidence outranks contradictory Tier 2, Tier 3 or Tier 4 signals. Tier 3/4 is inference, never fact. RotoWire is preferred within Tier 2 when publicly accessible, but never outranks Tier 1.\n- Only evidence marked decisionEligible may drive the gameweek verdict. Other evidence is audit context only.\n- Category-specific recency matters: availability and predicted-lineup evidence expires quickly; transfers, shirt competition and tactical roles remain relevant longer.\n- Look for both positive and negative disagreement. Do not default to concern.\n- Never invent a source, fact, percentage, lineup, injury, rival, quote or role. Do not create a new numeric start probability.\n- UNKNOWN when evidence is absent or too weak. MONITOR when signals conflict.\n- evidenceIds must contain only IDs from EVIDENCE JSON.\n- Summarise; do not quote copyrighted passages. Return compact JSON.`;
  const run=env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast',{
    messages:[{role:'system',content:'You are a conservative FPL evidence auditor. Evidence authority and recency outrank narrative confidence.'},{role:'user',content:prompt}],
    response_format:{type:'json_schema',json_schema:{name:'otb_fresh_player_review',strict:true,schema:playerReviewSchema()}},temperature:0
  });
  let timer;const settled=await Promise.race([
    run.then(value=>({value}),error=>({error})),new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),25000)})
  ]);if(timer)clearTimeout(timer);
  if(settled.timedOut)return {status:'timeout',value:null,error:'Workers AI exceeded 25000ms'};
  if(settled.error)return {status:'error',value:null,error:settled.error?.message||String(settled.error)};
  let value=settled.value?.response??settled.value;if(typeof value==='string'){try{value=JSON.parse(value)}catch{return {status:'parse-error',value:null,error:'Workers AI returned invalid JSON'}}}
  return {status:'ok',value,error:null};
}

function fallbackFreshClassification(player,evidence){
  if(!evidence.length)return 'UNKNOWN';
  const meaningful=evidence.filter(e=>e.signal!=='neutral'&&e.weight>=0.2);
  const positive=meaningful.filter(e=>e.signal==='positive').reduce((s,e)=>s+e.weight,0);
  const negative=meaningful.filter(e=>e.signal==='negative').reduce((s,e)=>s+e.weight,0);
  if(!positive&&!negative)return 'UNKNOWN';
  if(positive>0&&negative>0&&Math.min(positive,negative)>=0.35*Math.max(positive,negative))return 'MONITOR';
  if(negative>positive){
    if(player.startProbability>=0.78&&negative>=0.75)return 'STRONG DOWNGRADE';
    return player.startProbability<=0.45?'AGREE':'DOWNGRADE';
  }
  if(player.startProbability<=0.55&&positive>=0.7)return 'STRONG UPGRADE';
  return player.startProbability>=0.86?'AGREE':'UPGRADE';
}
function statusForFreshPlayer(context,player,classification){
  const critical=player.scoring||context.activeChip==='BENCH_BOOST';
  if(player.availability<0.5)return critical?'RED':'AMBER';
  if(context.activeChip==='BENCH_BOOST'&&(player.startProbability<0.5||player.expectedMinutes<45))return 'RED';
  if(context.activeChip==='TRIPLE_CAPTAIN'&&player.captain&&(player.startProbability<0.78||player.expectedMinutes<65))return 'RED';
  if(classification==='STRONG DOWNGRADE')return critical?'RED':'AMBER';
  if(classification==='DOWNGRADE'||classification==='MONITOR')return 'AMBER';
  if(classification==='STRONG UPGRADE'||classification==='UPGRADE')return 'OPPORTUNITY';
  if(critical&&(player.startProbability<0.7||player.expectedMinutes<55))return 'AMBER';
  return 'GREEN';
}
function enforceFreshVerdict(context,player,evidence,draft){
  const annotatedEvidence=(evidence||[]).map(item=>item.decisionEligible===undefined?freshAnnotateEvidence(item):item),decisionEvidence=annotatedEvidence.filter(item=>item.decisionEligible===true&&item.decisionRelevant===true&&item.signal!=='neutral'),coverage=freshEvidenceCoverage(annotatedEvidence);
  const draftClassification=FRESH_CLASSIFICATIONS.has(draft?.classification)?draft.classification:null;
  let classification=draftClassification||fallbackFreshClassification(player,decisionEvidence);
  const supportingPositive=decisionEvidence.some(e=>e.signal==='positive'&&e.weight>=0.2),supportingNegative=decisionEvidence.some(e=>e.signal==='negative'&&e.weight>=0.2);
  if(['STRONG UPGRADE','UPGRADE'].includes(classification)&&!supportingPositive)classification=fallbackFreshClassification(player,decisionEvidence);
  if(['STRONG DOWNGRADE','DOWNGRADE'].includes(classification)&&!supportingNegative)classification=fallbackFreshClassification(player,decisionEvidence);
  if(classification==='AGREE'&&!supportingPositive&&!supportingNegative)classification=fallbackFreshClassification(player,decisionEvidence);
  const authoritative=decisionEvidence.filter(e=>e.authorityTier===1&&e.weight>=0.45&&e.signal!=='neutral');
  const positive=authoritative.some(e=>e.signal==='positive'),negative=authoritative.some(e=>e.signal==='negative');
  if(positive&&negative)classification='MONITOR';
  else if(negative&&['STRONG UPGRADE','UPGRADE'].includes(classification))classification=player.startProbability>0.55?'DOWNGRADE':'MONITOR';
  else if(positive&&['STRONG DOWNGRADE','DOWNGRADE'].includes(classification))classification=player.startProbability<0.8?'UPGRADE':'MONITOR';
  if(!decisionEvidence.length)classification='UNKNOWN';
  const directDecisionEvidence=decisionEvidence.filter(item=>item.hierarchyInference!==true);
  if(!directDecisionEvidence.length&&decisionEvidence.some(item=>item.hierarchyInference===true))classification='MONITOR';
  const status=statusForFreshPlayer(context,player,classification);
  const allowedIds=new Set(decisionEvidence.map(e=>e.id));
  const cited=[...new Set(Array.isArray(draft?.evidenceIds)?draft.evidenceIds.filter(id=>allowedIds.has(id)):[])];
  const strongest=decisionEvidence[0];
  const defaultSummary=strongest?`${strongest.publisher}: ${strongest.summary}`:coverage.note;
  let rationale=cleanText(draft?.rationale||'');
  if(draftClassification&&classification!==draftClassification)rationale='';
  if(!decisionEvidence.length)rationale='The live audit did not independently verify or contradict OTB for this player; no directional conclusion was invented.';
  else if(!rationale){
    if(classification==='UNKNOWN')rationale='External evidence is unavailable or too weak to challenge the OTB assumption.';
    else if(classification==='AGREE')rationale="Current source-ranked evidence does not materially contradict OTB's minutes and start assumption.";
    else if(classification==='MONITOR')rationale="Current source-ranked evidence is mixed; monitor rather than forcing a directional change to OTB's assumption.";
    else rationale=`The source-ranked evidence supports a ${classification.toLowerCase()} relative to OTB's current minutes and start assumption.`;
  }
  if(context.activeChip==='BENCH_BOOST'&&(player.startProbability<0.5||player.expectedMinutes<45))rationale=`Bench Boost makes this player scoring-critical, while OTB itself gives only ${Math.round(player.startProbability*100)}% start and ${player.expectedMinutes} xMins. ${rationale}`;
  if(context.activeChip==='TRIPLE_CAPTAIN'&&player.captain)rationale=`Triple Captain increases the decision weight of this evidence. ${rationale}`;
  if(player.scoring&&context.activeChip!=='BENCH_BOOST'&&(player.startProbability<0.7||player.expectedMinutes<55))rationale=`OTB itself flags start security at ${Math.round(player.startProbability*100)}% and ${player.expectedMinutes} xMins. ${rationale}`;
  return {
    freshEvidenceSummary:cleanText(decisionEvidence.length?(draft?.freshEvidenceSummary||defaultSummary):defaultSummary).slice(0,700),classification,status,
    confidence:!decisionEvidence.length||!decisionEvidence.some(e=>e.authorityTier<=2)?'LOW':(['HIGH','MEDIUM','LOW'].includes(draft?.confidence)?draft.confidence:(decisionEvidence.some(e=>e.authorityTier===1)?'HIGH':'MEDIUM')),
    rationale:rationale.slice(0,900),monitorPoint:cleanText(draft?.monitorPoint||(classification==='UNKNOWN'?'Check final official team news and predicted lineups.':'Re-check if later official evidence changes the current signal.')).slice(0,500),
    evidenceIds:cited,evidenceCoverage:coverage.status,coverageNote:coverage.note,
    decisionEvidenceCount:coverage.decisionEvidenceCount,historicalEvidenceCount:coverage.historicalEvidenceCount
  };
}

/* A competitor who has left the club, or who is himself unavailable, cannot
   take anyone's place this week.

   Observed 21 Aug 2026: the review raised a Tier 1 NEGATIVE signal against
   Kinsky's start "due to Vicario's availability" -- while the structured feed
   inside the very same report already carried "Vicario: has joined Juventus on
   loan for the rest of the season". The role-competition path only fires for
   goalkeepers and only when the story does NOT mention our player, so a story
   about a departed keeper in a "first choice / starting" context reads as a
   threat to the man who replaced him. That is systematic, not a one-off, and
   it argued against a starting goalkeeper hours before a deadline.

   Only NEGATIVE inferences are suppressed. "The competitor is leaving" is real
   evidence in our player's favour and must keep counting. */
function unavailableCompetitorNames(report){
  const names=new Set();
  const add=value=>{
    const full=normal(value);if(!full)return;
    names.add(full);
    const surname=full.split(' ').filter(Boolean).at(-1);
    if(surname&&surname.length>=3)names.add(surname);
  };
  for(const e of Array.isArray(report?.clubEvents)?report.clubEvents:[]){
    if(['departure','loan_out'].includes(String(e?.type)))add(e.subject),add(e.affected);
  }
  for(const e of Array.isArray(report?.events)?report.events:[]){
    if(['unavailable','suspension'].includes(String(e?.rawType||e?.type)))add(e.subject),add(e.affected);
  }
  return names;
}
function suppressDepartedCompetitorEvidence(items,report){
  const gone=unavailableCompetitorNames(report);
  if(!gone.size)return items||[];
  return (items||[]).map(item=>{
    if(item?.hierarchyInference!==true||item?.signal!=='negative')return item;
    const peer=normal(item.relatedPlayer);
    if(!peer)return item;
    const surname=peer.split(' ').filter(Boolean).at(-1)||'';
    if(!gone.has(peer)&&!(surname&&gone.has(surname)))return item;
    return {...item,decisionRelevant:false,decisionEligible:false,
      suppressedReason:`Role-competition inference rests on ${item.relatedPlayer}, who the official feed reports is no longer available to this club.`};
  });
}

async function researchFreshPlayer(env,context,player){
  const [report,news]=await Promise.all([
    env.ROLE_KV.get(`latest:${player.club}`,'json').catch(()=>null),googleNewsEvidence(env,player)
  ]);
  const merged=suppressDepartedCompetitorEvidence([...officialPlayerEvidence(report,player),...(news.items||[])],report);
  const dedup=new Map();for(const item of merged){const key=freshStoryFingerprint(item);if(!dedup.has(key)||dedup.get(key).authorityTier>item.authorityTier)dedup.set(key,item)}
  const evidence=[...dedup.values()].map(item=>item.decisionEligible===undefined?freshAnnotateEvidence(item):item).sort((a,b)=>Number(b.decisionEligible)-Number(a.decisionEligible)||a.authorityTier-b.authorityTier||Number(b.preferredSource)-Number(a.preferredSource)||b.weight-a.weight||Date.parse(b.relevantDate||0)-Date.parse(a.relevantDate||0)).slice(0,8);
  const ai=await aiFreshPlayerReview(env,context,player,evidence);
  const verdict=enforceFreshVerdict(context,player,evidence,ai.value);
  return {
    playerId:player.playerId,name:player.name,canonicalName:player.canonicalName||player.name,club:player.club,position:player.position,squadRole:player.squadRole,
    benchOrder:player.benchOrder,scoring:player.scoring,captain:player.captain,viceCaptain:player.viceCaptain,
    otb:{startProbability:player.startProbability,expectedMinutes:player.expectedMinutes,xPts:player.xPts,availability:player.availability},
    ...verdict,evidence,research:{status:ai.status==='ok'?'complete':'complete-with-fallback',aiStatus:ai.status,aiError:ai.error||null,newsStatus:news.status,newsError:news.error||null,query:news.query,queries:news.queries||[news.query],currentItems:evidence.filter(item=>item.decisionEligible).length,identitySource:player.identitySource||'OTB_CONTEXT'},
    reviewedAt:new Date().toISOString(),mutatesProjection:false
  };
}
function unavailableFreshPlayer(context,player,error){
  const verdict=enforceFreshVerdict(context,player,[],{classification:'UNKNOWN',confidence:'LOW',freshEvidenceSummary:'Evidence unavailable for this player.',rationale:'The player research request failed; no conclusion was invented.',monitorPoint:'Retry the player or check final official team news.',evidenceIds:[]});
  return {playerId:player.playerId,name:player.name,canonicalName:player.canonicalName||player.name,club:player.club,position:player.position,squadRole:player.squadRole,benchOrder:player.benchOrder,scoring:player.scoring,captain:player.captain,viceCaptain:player.viceCaptain,otb:{startProbability:player.startProbability,expectedMinutes:player.expectedMinutes,xPts:player.xPts,availability:player.availability},...verdict,evidence:[],research:{status:'failed',aiStatus:'not-run',aiError:cleanText(error).slice(0,300),newsStatus:'failed',newsError:cleanText(error).slice(0,300),query:freshNewsQuery(player),queries:freshNewsQueries(player),currentItems:0,identitySource:player.identitySource||'OTB_CONTEXT'},reviewedAt:new Date().toISOString(),mutatesProjection:false};
}

function freshJobKey(id){return `fresh-review:job:${id}`}
function freshActor(identity){return String(identity?.id||'legacy:local-test')}
function freshActorHash(actorId){return hashString(`fresh-actor:${actorId}`)}
function freshCacheKey(actorId,hash){return `fresh-review:cache:v3:${freshActorHash(actorId)}:${hash}`}
function freshLatestKey(actorId,season,gameweek){return `fresh-review:latest:v2:${freshActorHash(actorId)}:${hashString(`${season}:${gameweek}`)}`}
function freshActiveKey(actorId,contextHash){return `fresh-review:active:v1:${freshActorHash(actorId)}:${contextHash}`}
async function storeFreshJob(env,job){await env.ROLE_KV.put(freshJobKey(job.jobId),JSON.stringify(job),{expirationTtl:FRESH_JOB_TTL_SECONDS})}
function publicFreshJob(job){
  const total=job.selectedPlayerIds.length,completed=job.selectedPlayerIds.filter(id=>job.playerReviews[id]).length;
  return {jobId:job.jobId,status:job.status,createdAt:job.createdAt,updatedAt:job.updatedAt,force:job.force,contextHash:job.contextHash,totalPlayers:15,targetPlayers:total,completedPlayers:completed,reusedPlayers:Object.keys(job.playerReviews).length-completed,failedPlayers:Object.values(job.playerReviews).filter(r=>r?.research?.status==='failed').length,pendingPlayerIds:job.selectedPlayerIds.filter(id=>!job.playerReviews[id]),selectedPlayerIds:job.selectedPlayerIds,diff:job.diff||null,review:job.review||null,executionMode:job.executionMode||'cloudflare-workflow',workflowInstanceId:job.workflowInstanceId||job.jobId,safeToClose:true,error:job.error||null};
}
async function createFreshReviewJob(env,payload,identity=null){
  const raw=payload?.context||payload;
  const validation=validateFreshReviewContext(raw);
  if(!validation.ok)return {error:'invalid squad context',details:validation.errors,status:400};
  const actorId=freshActor(identity),context=await enrichFreshReviewIdentities(validation.context),contextHash=await freshContextHash(context),force=payload?.force===true;
  const cacheMinutes=freshCacheMinutes(context);
  if(!force){
    const cached=await env.ROLE_KV.get(freshCacheKey(actorId,contextHash),'json');
    if(cached?.review&&Date.parse(cached.review.cacheExpiresAt||0)>Date.now())return {status:200,body:{status:'ok',cache:'HIT',cacheMinutes,review:cached.review}};
    const active=await env.ROLE_KV.get(freshActiveKey(actorId,contextHash),'json');
    if(active?.jobId){
      const running=await env.ROLE_KV.get(freshJobKey(active.jobId),'json');
      if(running?.actorId===actorId&&running.contextHash===contextHash&&['queued','researching','ready_to_finalize'].includes(running.status))return {status:202,body:{status:'ok',cache:'ACTIVE',...publicFreshJob(running)}};
    }
  }
  let priorJob=null;
  if(payload?.priorReviewId){
    const candidate=await env.ROLE_KV.get(freshJobKey(String(payload.priorReviewId)),'json');
    if(candidate?.actorId===actorId)priorJob=candidate;
  }
  const priorContext=priorJob?.context||priorJob?.review?.inputSnapshot||null;
  const diff=priorContext?freshContextDiff(priorContext,context):null;
  const validIds=new Set(context.players.map(p=>p.playerId));
  let selected=Array.isArray(payload?.selectedPlayerIds)?[...new Set(payload.selectedPlayerIds.map(String).filter(id=>validIds.has(id)))]:context.players.map(p=>p.playerId);
  if(!selected.length)selected=context.players.map(p=>p.playerId);
  const priorReviews=priorJob?.review?.playerReviews||Object.values(priorJob?.playerReviews||{});
  const priorById=new Map((Array.isArray(priorReviews)?priorReviews:[]).map(r=>[String(r.playerId),r]));
  const playerReviews={};
  for(const player of context.players)if(!selected.includes(player.playerId)&&priorById.has(player.playerId))playerReviews[player.playerId]={...priorById.get(player.playerId),reusedFromReviewId:priorJob.jobId};
  // A requested partial refresh is only safe when every unselected player can
  // be carried from the immediately supplied prior review.
  const missingCarry=context.players.filter(p=>!selected.includes(p.playerId)&&!playerReviews[p.playerId]).map(p=>p.playerId);
  selected=[...new Set([...selected,...missingCarry])];
  const now=new Date().toISOString();
  const jobId=crypto.randomUUID(),job={jobId,status:'queued',createdAt:now,updatedAt:now,force,cacheMinutes,contextHash,context,selectedPlayerIds:selected,playerReviews,diff,priorReviewId:priorJob?.jobId||null,review:null,actorId,actorRole:identity?.role||'reviewer',authMode:identity?.mode||'test',executionMode:'cloudflare-workflow',workflowInstanceId:jobId,error:null};
  await storeFreshJob(env,job);
  await env.ROLE_KV.put(freshActiveKey(actorId,contextHash),JSON.stringify({jobId,createdAt:now}),{expirationTtl:FRESH_JOB_TTL_SECONDS});
  if(!env.FRESH_REVIEW_WORKFLOW?.create){job.status='start_failed';job.error='Fresh Review Workflow binding is unavailable.';job.updatedAt=new Date().toISOString();await storeFreshJob(env,job);return {status:503,body:{status:'error',error:job.error,...publicFreshJob(job)}}}
  try{
    await env.FRESH_REVIEW_WORKFLOW.create({id:jobId,params:{jobId,actorId},retention:{successRetention:'3 days',errorRetention:'7 days'}});
  }catch(error){job.status='start_failed';job.error=cleanText(error?.message||error).slice(0,300);job.updatedAt=new Date().toISOString();await storeFreshJob(env,job);return {status:503,body:{status:'error',error:`Fresh Review could not start: ${job.error}`,...publicFreshJob(job)}}}
  return {status:202,body:{status:'ok',cache:'MISS',...publicFreshJob(job)}};
}
async function processFreshReviewPlayer(env,jobId,playerId,actorId=null){
  const job=await env.ROLE_KV.get(freshJobKey(jobId),'json');
  if(!job||(actorId&&job.actorId!==actorId))return {status:404,body:{status:'error',error:'review job not found or expired'}};
  if(job.review)return {status:200,body:{status:'ok',...publicFreshJob(job)}};
  const player=job.context.players.find(p=>p.playerId===String(playerId));
  if(!player)return {status:400,body:{status:'error',error:'player is not in this review context'}};
  if(job.playerReviews[player.playerId])return {status:200,body:{status:'ok',playerReview:job.playerReviews[player.playerId],...publicFreshJob(job)}};
  let result;try{result=await researchFreshPlayer(env,job.context,player)}catch(error){result=unavailableFreshPlayer(job.context,player,error?.message||String(error))}
  job.playerReviews[player.playerId]=result;job.status='researching';job.updatedAt=new Date().toISOString();
  if(job.selectedPlayerIds.every(id=>job.playerReviews[id]))job.status='ready_to_finalize';
  await storeFreshJob(env,job);
  return {status:200,body:{status:'ok',playerReview:result,...publicFreshJob(job)}};
}
function freshPriority(review){
  let score=({RED:40,AMBER:20,OPPORTUNITY:10,GREEN:0})[review.status]||0;
  if(review.scoring)score+=8;if(review.captain)score+=5;
  if(review.classification==='STRONG DOWNGRADE')score+=8;if(review.classification==='UNKNOWN')score+=2;
  return score;
}
function freshMaterialIssue(review){
  if(['STRONG DOWNGRADE','DOWNGRADE','MONITOR'].includes(review.classification)||review.status==='RED')return true;
  if(review.status!=='AMBER')return false;
  return review.classification!=='UNKNOWN'||review.otb?.availability<0.5||review.otb?.startProbability<0.7||review.otb?.expectedMinutes<55;
}
function buildFreshSquadSummary(context,reviews){
  const negative=reviews.filter(freshMaterialIssue).sort((a,b)=>freshPriority(b)-freshPriority(a));
  const positive=reviews.filter(r=>r.status==='OPPORTUNITY').sort((a,b)=>freshPriority(b)-freshPriority(a));
  const primary=negative[0]||null,secondary=negative.slice(1,3),captain=reviews.find(r=>r.captain),scoring=reviews.filter(r=>r.scoring),unverified=scoring.filter(r=>r.evidenceCoverage==='UNVERIFIED');
  const primaryIssue=primary?`${primary.name} — ${primary.rationale}`:unverified.length?`No evidence-backed player concern was identified; the live audit was inconclusive for ${unverified.length} of ${scoring.length} scoring players.`:'No material current concern emerged from the source-ranked review.';
  const positiveDisagreement=positive[0]?`${positive[0].name} — ${positive[0].rationale}`:'No material positive disagreement emerged.';
  let captainAssessment=`${captain?.name||'Captain'}: evidence unavailable.`;
  if(captain)captainAssessment= captain.status==='RED'?`${captain.name} requires captaincy review.`:captain.status==='AMBER'?`${captain.name} remains plausible but carries a material risk signal.`:captain.evidenceCoverage==='UNVERIFIED'?`${captain.name} remains OTB's captain choice, but the live review did not independently validate him.`:captain.evidenceCoverage==='PARTIAL'?`${captain.name} remains OTB's captain choice with partial external support.`:`${captain.name} remains defensible on current evidence.`;
  let overall='The live evidence audit found no material reason to change the saved squad automatically.';
  if(context.activeChip==='BENCH_BOOST'&&primary)overall=`Bench Boost makes all 15 scoring decisions material. Resolve the primary start-security issue before the deadline; OTB projections remain unchanged.`;
  else if(context.activeChip==='TRIPLE_CAPTAIN')overall=`Triple Captain increases captain evidence sensitivity. Review the captain finding before committing; OTB projections remain unchanged.`;
  else if(primary)overall='The squad remains intact, but the highlighted live-evidence risk deserves a manual decision before deadline.';
  else if(unverified.length)overall=`No projection or squad change was made. External coverage remains incomplete for ${unverified.length} scoring players, so this run should be treated as an inconclusive audit rather than a clean bill of health.`;
  const coverageWarning=unverified.length?`${unverified.length} of ${scoring.length} scoring players were not independently verified by current external evidence.`:'Every scoring player had at least partial current external evidence.';
  return {coverageWarning,primaryIssue,secondaryRisks:secondary.map(r=>`${r.name} — ${r.rationale}`),positiveDisagreement,captainAssessment,overallVerdict:overall};
}
async function finalizeFreshReview(env,jobId,actorId=null){
  const job=await env.ROLE_KV.get(freshJobKey(jobId),'json');
  if(!job||(actorId&&job.actorId!==actorId))return {status:404,body:{status:'error',error:'review job not found or expired'}};
  if(job.review)return {status:200,body:{status:'ok',cache:'HIT',review:job.review}};
  for(const player of job.context.players)if(!job.playerReviews[player.playerId])job.playerReviews[player.playerId]=unavailableFreshPlayer(job.context,player,'Player research did not complete before finalization.');
  const playerReviews=job.context.players.map(p=>job.playerReviews[p.playerId]);
  const counts={GREEN:0,OPPORTUNITY:0,AMBER:0,RED:0};for(const row of playerReviews)counts[row.status]=(counts[row.status]||0)+1;
  const coverageCounts={VERIFIED:0,PARTIAL:0,UNVERIFIED:0};for(const row of playerReviews)coverageCounts[row.evidenceCoverage]=(coverageCounts[row.evidenceCoverage]||0)+1;
  const generatedAt=new Date().toISOString(),cacheMinutes=job.cacheMinutes||freshCacheMinutes(job.context),cacheExpiresAt=new Date(Date.now()+cacheMinutes*60000).toISOString();
  const review={
    reviewId:job.jobId,schemaVersion:FRESH_REVIEW_VERSION,workerBuild:WORKER_BUILD,generatedAt,reviewGeneratedAt:generatedAt,jobCreatedAt:job.createdAt,researchCompletedAt:generatedAt,cacheExpiresAt,cacheMinutes,
    season:job.context.season,gameweek:job.context.gameweek,activeChip:job.context.activeChip,formation:job.context.formation,
    playerCount:15,scoringPlayerCount:job.context.players.filter(p=>p.scoring).length,projectedScoringPoints:freshProjectedTotal(job.context),counts,coverageCounts,
    summary:buildFreshSquadSummary(job.context,playerReviews),playerReviews,otbAlerts:job.context.otbAlerts,
    research:{researchedPlayers:job.selectedPlayerIds.length,freshPlayers:job.selectedPlayerIds.length,reusedPlayers:playerReviews.filter(r=>r.reusedFromReviewId).length,failedPlayers:playerReviews.filter(r=>r.research?.status==='failed').length,currentEvidencePlayers:playerReviews.filter(r=>r.decisionEvidenceCount>0).length,verifiedPlayers:coverageCounts.VERIFIED,partialPlayers:coverageCounts.PARTIAL,unverifiedPlayers:coverageCounts.UNVERIFIED,scoringPlayersVerified:playerReviews.filter(r=>r.scoring&&r.evidenceCoverage==='VERIFIED').length},
    methodology:{authority:'Tier 1 official/confirmed evidence outranks Tier 2 reporting, Tier 3 community inference and Tier 4 aggregation. Authority is assigned from the source, never headline wording.',recency:'Evidence uses category-specific decision windows: availability and predicted lineups expire quickly; role competition, transfers, tactical roles and set pieces remain relevant longer.',identity:'The official FPL element ID resolves canonical player names before search; compact surname results require club context and conflicting full names are rejected.',preferredSources:'Publicly accessible RotoWire information is preferred within Tier 2 when relevant. Gated content and access controls are never bypassed; systematic ingestion requires the licensed official API.',precision:'Qualitative confidence and disagreement classes are used; no synthetic start percentage is created.'},
    inputSnapshot:job.context,contextHash:job.contextHash,priorReviewId:job.priorReviewId,diff:job.diff,executionMode:'cloudflare-workflow',mutatesProjection:false
  };
  job.review=review;job.status='complete';job.updatedAt=generatedAt;await storeFreshJob(env,job);
  await Promise.all([
    env.ROLE_KV.put(freshCacheKey(job.actorId,job.contextHash),JSON.stringify({review}),{expirationTtl:cacheMinutes*60}),
    env.ROLE_KV.put(freshLatestKey(job.actorId,job.context.season,job.context.gameweek),JSON.stringify({jobId:job.jobId,review}),{expirationTtl:FRESH_JOB_TTL_SECONDS})
  ]);
  return {status:200,body:{status:'ok',cache:'MISS',review}};
}

/** A review runs independently of the initiating browser. Each player is a
 * durable step, so mobile suspension, tab closure and transient Worker restarts
 * do not discard completed research. One failed player becomes UNKNOWN and the
 * remaining squad continues. */
export class FreshReviewWorkflow extends WorkflowEntrypoint{
  async run(event,step){
    const payload=event?.payload||event?.params||{},jobId=String(payload.jobId||''),actorId=String(payload.actorId||'');
    if(!jobId||!actorId)throw new Error('Fresh Review Workflow payload is incomplete.');
    try{
      const playerIds=await step.do('load review context',{retries:{limit:3,delay:'2 seconds',backoff:'exponential'},timeout:'1 minute'},async()=>{
        const env=await withD1(this.env),job=await env.ROLE_KV.get(freshJobKey(jobId),'json');
        if(!job||job.actorId!==actorId)throw new Error('Fresh Review job is missing or belongs to another actor.');
        if(job.review)return[];
        job.status='researching';job.updatedAt=new Date().toISOString();await storeFreshJob(env,job);return job.selectedPlayerIds;
      });
      for(let index=0;index<playerIds.length;index++){
        const playerId=String(playerIds[index]);
        await step.do(`research player ${index+1} ${playerId}`,{retries:{limit:2,delay:'5 seconds',backoff:'exponential'},timeout:'5 minutes'},async()=>{
          const env=await withD1(this.env),result=await processFreshReviewPlayer(env,jobId,playerId,actorId);
          if(result.status>=500)throw new Error(result.body?.error||`Player ${playerId} research failed`);
          return{playerId,status:result.body?.playerReview?.research?.status||result.body?.status||'complete'};
        });
      }
      return step.do('finalize squad review',{retries:{limit:3,delay:'3 seconds',backoff:'exponential'},timeout:'2 minutes'},async()=>{
        const env=await withD1(this.env),result=await finalizeFreshReview(env,jobId,actorId);
        if(result.status>=400)throw new Error(result.body?.error||'Fresh Review finalization failed');
        return{jobId,reviewId:result.body.review?.reviewId||jobId,generatedAt:result.body.review?.generatedAt||new Date().toISOString()};
      });
    }catch(error){
      await step.do('record workflow failure',{retries:{limit:2,delay:'2 seconds',backoff:'constant'},timeout:'1 minute'},async()=>{
        const env=await withD1(this.env),job=await env.ROLE_KV.get(freshJobKey(jobId),'json');
        if(job&&job.actorId===actorId&&!job.review){job.status='failed';job.error=cleanText(error?.message||error).slice(0,500);job.updatedAt=new Date().toISOString();await storeFreshJob(env,job)}
        return{recorded:true};
      });
      throw error;
    }
  }
}
async function handleFreshReviewRequest(request,env,u){
  const identity=await freshReviewIdentity(request,env);if(!identity)return json({status:'error',error:'Fresh Review key required or invalid'},401,env);
  if(u.pathname==='/api/fresh-review/session'){
    if(request.method!=='GET')return json({status:'error',error:'use GET'},405,env);
    return json({status:'ok',authenticated:true,identity:{email:identity.email,role:identity.role,mode:identity.mode},backgroundMode:'cloudflare-workflow',safeToClose:true},200,env);
  }
  if(u.pathname==='/api/fresh-review/latest'){
    if(request.method!=='GET')return json({status:'error',error:'use GET'},405,env);
    const season=cleanText(u.searchParams.get('season')||env.SEASON||'2026/27'),gameweek=Math.round(finiteOr(u.searchParams.get('gameweek'),0));
    if(gameweek<1)return json({status:'error',error:'gameweek is required'},400,env);
    const latest=await env.ROLE_KV.get(freshLatestKey(identity.id,season,gameweek),'json');
    return json({status:'ok',review:latest?.review||null},200,env);
  }
  if(u.pathname==='/api/fresh-review'){
    if(request.method!=='POST')return json({status:'error',error:'use POST'},405,env);
    const payload=await request.json().catch(()=>null);if(!payload)return json({status:'error',error:'valid JSON body required'},400,env);
    const result=await createFreshReviewJob(env,payload,identity);return json(result.body||{status:'error',error:result.error,details:result.details},result.status||500,env);
  }
  const match=u.pathname.match(/^\/api\/fresh-review\/([a-f0-9-]+)(?:\/(player|finalize))?$/i);
  if(!match)return json({status:'error',error:'fresh review route not found'},404,env);
  const jobId=match[1],action=match[2]||'';
  if(!action&&request.method==='GET'){
    const job=await env.ROLE_KV.get(freshJobKey(jobId),'json');
    return job?.actorId===identity.id?json({status:'ok',...publicFreshJob(job)},200,env):json({status:'error',error:'review job not found or expired'},404,env);
  }
  if(action==='player'&&request.method==='POST'){
    const body=await request.json().catch(()=>({}));const result=await processFreshReviewPlayer(env,jobId,String(body.playerId||''),identity.id);return json(result.body,result.status,env);
  }
  if(action==='finalize'&&request.method==='POST'){
    const result=await finalizeFreshReview(env,jobId,identity.id);return json(result.body,result.status,env);
  }
  return json({status:'error',error:'method not allowed'},405,env);
}

export default {
  async fetch(request,env,ctx){
    env = await withD1(env);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors(env)});
    const u=new URL(request.url);try{
      if(u.pathname==='/'||u.pathname==='/api/health'){
        const keyConfigured=/^[A-Za-z0-9_-]{43}$/.test(FRESH_REVIEW_OWNER_PUBLIC_KEY)||Boolean(env.SCOUT_ADMIN_TOKEN);
        return json({status:'ok',service:'OTB Role Intelligence',workerBuild:WORKER_BUILD,schemaVersion:SCHEMA_VERSION,season:env.SEASON||'2026/27',teams:Object.keys(CLUB_SOURCES).length,browserAvailable:!!env.BROWSER?.quickAction,structuredFeedAvailable:String(env.STRUCTURED_FEED_DISABLED||'')!=='1',structuredFeedVersion:STRUCTURED_FEED_VERSION,structuredFeedProviders:STRUCTURED_PROVIDER_CATALOG,freshReviewAvailable:true,freshReviewVersion:FRESH_REVIEW_VERSION,freshReviewAuthConfigured:keyConfigured,freshReviewAuthMode:'key-only',freshReviewAccessConfigured:false,freshReviewWorkflowConfigured:Boolean(env.FRESH_REVIEW_WORKFLOW?.create),freshReviewBackgroundMode:'cloudflare-workflow',generatedAt:new Date().toISOString()},200,env);
      }
      // Derived team numbers for the projection engine. Public and
      // read-only: it never triggers a fetch, so it cannot burn credits.
      if(u.pathname==='/api/market/teams'){
        const d=await env.ROLE_KV.get('market:teams','json');
        if(!d)return json({status:'ok',available:false,fixtures:[]},200,env);
        const ageMin=Math.round((Date.now()-Date.parse(d.fetchedAt))/60000);
        return json({status:'ok',available:true,ageMinutes:ageMin,...d},200,env);
      }
      if(!originAllowed(request,env))return json({status:'error',error:'origin not allowed'},403,env);

      if(u.pathname==='/api/fresh-review'||u.pathname.startsWith('/api/fresh-review/'))return handleFreshReviewRequest(request,env,u);

      // Cache-only by default so an Engine read can never trigger an external
      // request. An admin may add ?fresh=1 (or ?force=1) to rebuild the feed.
      if(u.pathname==='/api/scout/structured-feed'){
        const team=String(u.searchParams.get('team')||'').toUpperCase();
        if(!team)return json({status:'error',error:'team is required'},400,env);
        if(!CLUB_SOURCES[team])return json({status:'error',error:`unsupported team code: ${team}`},400,env);
        const force=u.searchParams.get('fresh')==='1'||u.searchParams.get('force')==='1';
        if(force&&!adminAuthorised(request,env))return json({status:'error',error:'unauthorised'},401,env);
        const result=force
          ? await fplContext(env,team).then(roster=>structuredFeedForTeam(env,team,roster.current.players,{profile:'foreground',force:true}))
          : await cachedStructuredFeedForTeam(env,team);
        return json({team,generatedAt:new Date().toISOString(),...result},200,env);
      }
      if(u.pathname==='/api/scout/structured-sync'&&request.method==='POST'){
        if(!adminAuthorised(request,env))return json({status:'error',error:'unauthorised'},401,env);
        const body=await request.json().catch(()=>({}));
        const team=String(body.team||'').toUpperCase();
        if(!team)return json({status:'error',error:'team is required'},400,env);
        if(!CLUB_SOURCES[team])return json({status:'error',error:`unsupported team code: ${team}`},400,env);
        const roster=await fplContext(env,team);
        const result=await structuredFeedForTeam(env,team,roster.current.players,{profile:'foreground',force:true});
        return json({team,generatedAt:new Date().toISOString(),...result},200,env);
      }

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
            if(cached)return json(await withCurrentClubEvents(env,team,{status:'ok',forceThrottled:true,forceThrottleReason:gate.reason,retryAfterSec:gate.retryAfterSec,...cached,cache:'HIT'}),200,env);
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
      /* Bulk cached read so the engine can pull evidence for a whole squad in
         one request. Cache only: never scans, never touches browser budget,
         so it is safe to call on every client refresh. */
      if(u.pathname==='/api/scout/latest'){
        const requested=[...new Set(String(u.searchParams.get('teams')||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean))];
        if(!requested.length)return json({status:'error',error:'teams is required'},400,env);
        if(requested.length>20)return json({status:'error',error:'at most 20 teams per request'},400,env);
        const unsupported=requested.filter(code=>!CLUB_SOURCES[code]);
        if(unsupported.length)return json({status:'error',error:`unsupported team code(s): ${unsupported.join(', ')}`},400,env);
        const teams={},missing=[];
        await Promise.all(requested.map(async code=>{
          const cached=await env.ROLE_KV.get(`latest:${code}`,'json').catch(()=>null);
          if(cached)teams[code]=await withCurrentClubEvents(env,code,{...cached,status:'ok',cache:'HIT'});
          else missing.push(code);
        }));
        return json({status:'ok',generatedAt:new Date().toISOString(),schemaVersion:SCHEMA_VERSION,workerBuild:WORKER_BUILD,
          requested:requested.length,returned:Object.keys(teams).length,missing,teams},200,env);
      }
      if(u.pathname==='/api/scout/club-events'){
        const team=String(u.searchParams.get('team')||'').toUpperCase();
        const mode=String(u.searchParams.get('mode')||'current').toLowerCase();
        if(team){
          // RC5.0.16: serve the canonical ledger directly, not the frozen
          // report snapshot. This is the endpoint the brief's screenshots
          // trace back to -- it was the most direct client-facing bypass of
          // the validator, reading `latest:${team}` without ever touching
          // `club-events:${team}` at all.
          const [report,history]=await Promise.all([
            env.ROLE_KV.get(`latest:${team}`,'json'),
            loadClubEventLedger(env,team)
          ]);
          const current=history.filter(isCurrentClubEvent);
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
            candidates:d.candidates||0,
            attempted:d.attempted||report.sourceDocumentsAttempted||0,
            articleDocuments:d.articleDocuments||0,
            sourceDocumentsRead:report.sourceDocumentsRead??d.sourceDocumentsRead??d.articleDocuments??0,
            sourceCoverageSufficient:report.sourceCoverageSufficient??d.sourceCoverageSufficient??null,
            evidenceAuthoritative:report.evidenceAuthoritative!==false,
            evidenceCarriedForward:report.evidenceCarriedForward===true,
            aiStatus:d.aiStatus||null,
            aiError:d.aiError||null,
            documentsRead:d.documentsRead||0,
            documentsUsed:d.documentsUsed||0,
            browserCalls:d.browserCalls||0,
            cacheHits:d.cacheHits||0,newCandidates:d.newCandidates||0,
            cachedCandidates:d.cachedCandidates||0,
            recencySource:d.recencySource||null,
            timestampCoverage:d.timestampCoverage||0,
            dynamicDiscoveryEscalated:!!d.dynamicDiscoveryEscalated,
            dynamicEscalationReasons:d.dynamicEscalationReasons||[],
            staticUnprocessedCandidates:d.staticUnprocessedCandidates||0,
            renderedUnprocessedCandidates:d.renderedUnprocessedCandidates||0,
            embeddedArticleCards:d.embeddedArticleCards||0,
            sitemapDiscoveryUsed:!!d.sitemapDiscoveryUsed,
            sitemapLinks:d.sitemapLinks||0,
            sitemapCandidates:d.sitemapCandidates||0,
            discoveryWarnings:d.discoveryWarnings||report.discoveryWarnings||[],
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
            embeddedCards:x.embeddedCards,
            embeddedBreakdown:x.embeddedBreakdown,
            sitemapUsed:x.sitemapUsed,
            sitemapCache:x.sitemapCache,
            sitemapDocuments:x.sitemapDocuments,
            sitemapLinks:x.sitemapLinks,
            sitemapCandidates:x.sitemapCandidates,
            sitemapError:x.sitemapError,
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
      const teams=Object.keys(CLUB_SOURCES),key='cron:cursor',cursor=Number(await env.ROLE_KV.get(key)||0),count=Math.min(4,Math.max(1,Number.isFinite(configured)?configured:4));for(let i=0;i<count;i++){const team=teams[(cursor+i)%teams.length];try{await scanTeamGuarded(env,team,{profile:'scheduled'})}catch(e){await env.ROLE_KV.put(`error:${team}`,JSON.stringify({at:new Date().toISOString(),error:e.message}),{expirationTtl:86400})}}await env.ROLE_KV.put(key,String((cursor+count)%teams.length));})());
  }
};
