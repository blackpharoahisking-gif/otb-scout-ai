import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/export default\s*\{/, 'const workerDefault = {')
  +'\n;globalThis.__audit={CLUB_SOURCES,DISCOVERY_CANDIDATE_FLOOR,hostOf,extractEmbeddedArticleCards,parseSitemapXml,scoreLink,selectArticleLinks};';
const context={URL,Date,Map,Set,RegExp,Object,Array,String,Number,Math,JSON,console,crypto:globalThis.crypto};
vm.createContext(context);
vm.runInContext(source,context,{filename:'worker.js'});
const {CLUB_SOURCES,DISCOVERY_CANDIDATE_FLOOR,hostOf,extractEmbeddedArticleCards,parseSitemapXml,scoreLink,selectArticleLinks}=context.__audit;
const headers={
  'User-Agent':'OTB-Scout-AI/1.3 (+FPL research; contact via otb-role-intelligence.workers.dev)',
  'Accept':'text/html,application/xhtml+xml'
};

function anchorLinks(html,base){
  const links=[];
  for(const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)){
    try{const url=new URL(match[1].replaceAll('&amp;','&'),base);url.hash='';if(url.protocol.startsWith('http'))links.push(url.toString())}catch{}
  }
  return [...new Set(links)];
}

async function audit(team,club){
  const sourceUrl=club.urls[0],response=await fetch(sourceUrl,{headers,redirect:'follow',signal:AbortSignal.timeout(30000)});
  if(!response.ok&&[403,429].includes(response.status))return {team,landing:response.url,browserRequired:true,selected:0,pass:'browser-required',urls:[]};
  if(!response.ok)throw new Error(`${team} landing HTTP ${response.status}`);
  const html=await response.text(),base=response.url;
  const embedded=extractEmbeddedArticleCards(html,base);
  let links=[...new Set([...anchorLinks(html,base),...embedded.links])];
  const times=new Map(embedded.times),host=hostOf(base),year=new Date().getUTCFullYear();
  const initial=links.filter(url=>scoreLink(url,host,year).score>1).length;
  let sitemap=0;
  if(initial<DISCOVERY_CANDIDATE_FLOOR){
    const sitemapUrl=new URL('/sitemap.xml',base),sitemapResponse=await fetch(sitemapUrl,{headers:{...headers,Accept:'application/xml,text/xml;q=0.9,*/*;q=0.2'},redirect:'follow',signal:AbortSignal.timeout(30000)});
    if(sitemapResponse.ok&&/(?:xml|text\/plain)/i.test(sitemapResponse.headers.get('content-type')||'')){
      const parsed=parseSitemapXml(await sitemapResponse.text(),sitemapResponse.url);
      sitemap=parsed.rows.length;
      links=[...new Set([...links,...parsed.rows.map(row=>row.url)])];
      for(const row of parsed.rows)if(Number.isFinite(row.time))times.set(row.url,row.time);
    }
  }
  const picked=selectArticleLinks(base,links,8,times,links.length?times.size/links.length:0);
  return {
    team,landing:base,anchors:anchorLinks(html,base).length,embedded:embedded.links.length,
    sitemap,selected:picked.candidates.length,pass:picked.pass,browserRequired:picked.candidates.length===0,urls:picked.candidates
  };
}

const requested=new Set(process.argv.slice(2).filter(arg=>!arg.startsWith('--')).map(arg=>arg.toUpperCase()));
const entries=Object.entries(CLUB_SOURCES).filter(([team])=>!requested.size||requested.has(team)),results=[];
for(let index=0;index<entries.length;index+=4){
  const batch=await Promise.allSettled(entries.slice(index,index+4).map(([team,club])=>audit(team,club)));
  batch.forEach((row,offset)=>results.push(row.status==='fulfilled'?row.value:{team:entries[index+offset][0],error:row.reason?.message||String(row.reason)}));
}
if(process.argv.includes('--json'))console.log(JSON.stringify(results,null,2));
else console.table(results.map(({team,anchors=0,embedded=0,sitemap=0,selected=0,pass='',browserRequired=false,error=''})=>({team,anchors,embedded,sitemap,selected,pass,browserRequired,error})));
const failures=results.filter(row=>row.error||(row.selected<1&&!row.browserRequired));
if(failures.length){
  console.error(JSON.stringify({failures},null,2));
  process.exitCode=1;
}
