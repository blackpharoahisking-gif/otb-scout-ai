import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/export default\s*\{/, 'const workerDefault = {')
  +'\n;globalThis.__discoveryTest={CLUB_SOURCES,extractEmbeddedArticleCards,extractEmbeddedArticleBody,parseSitemapXml,scoreLink,selectArticleLinks};';
const context={URL,Date,Map,Set,RegExp,Object,Array,String,Number,Math,JSON,console,crypto:globalThis.crypto};
vm.createContext(context);
vm.runInContext(source,context,{filename:'worker.js'});
const {CLUB_SOURCES,extractEmbeddedArticleCards,extractEmbeddedArticleBody,parseSitemapXml,scoreLink,selectArticleLinks}=context.__discoveryTest;

test('all 20 clubs use the shared discovery pipeline',()=>{
  assert.equal(Object.keys(CLUB_SOURCES).length,20);
  assert.equal(CLUB_SOURCES.BHA.urls[0],'https://www.brightonandhovealbion.com/latest-news-men');
  assert.equal(CLUB_SOURCES.TOT.urls[0],'https://www.tottenhamhotspur.com/teams/mens/latest');
});

test('JSON-LD ItemList URLs and dates become article signals',()=>{
  const html=`<script type="application/ld+json">${JSON.stringify({
    '@type':'ItemList',itemListElement:[
      {'@type':'ListItem',item:{'@type':'NewsArticle',url:'/news/2026/august/10/player-returns',datePublished:'2026-08-10T10:00:00Z'}},
      {'@type':'ListItem',item:'/news/2026/august/09/team-news'}
    ]
  })}</script>`;
  const out=extractEmbeddedArticleCards(html,'https://club.example/news');
  assert.deepEqual([...out.links],[
    'https://club.example/news/2026/august/10/player-returns',
    'https://club.example/news/2026/august/09/team-news'
  ]);
  assert.equal(out.times.get(out.links[0]),Date.parse('2026-08-10T10:00:00Z'));
});

test('escaped application-state URL fields become same-host article signals',()=>{
  const html='<script>window.__STATE__={&quot;articleUrl&quot;:&quot;\\u002Fnews\\u002F2026\\u002Faugust\\u002F10\\u002Fteam-news\\u002F&quot;}</script>';
  const out=extractEmbeddedArticleCards(html,'https://club.example/news');
  assert.deepEqual([...out.links],['https://club.example/news/2026/august/10/team-news/']);
});

test('typed Brighton Contentful article slugs become public article URLs',()=>{
  const html='<script>a.slug="player-returns-to-training";a.mediaType="Article";a.publishDateTime="2026-08-10T06:30+01:00";</script>';
  const out=extractEmbeddedArticleCards(html,'https://www.brightonandhovealbion.com/latest-news-men');
  const url='https://www.brightonandhovealbion.com/media-article/player-returns-to-training';
  assert.ok(out.links.includes(url));
  assert.equal(out.times.get(url),Date.parse('2026-08-10T06:30+01:00'));
});

test('typed SSR article state yields the requested body without related-card bleed',()=>{
  const detail='Player is ready and it is his first full training week. The manager confirmed the selection decision after training. '.repeat(4);
  const html=`<script>(function(a,b){a.name="Team news";a.slug="team-news";a.mediaType="Article";a.publishDateTime="2026-08-10T06:30+01:00";a.articleBody={body:{content:[{nodeType:"text",value:${JSON.stringify(detail)},marks:[]}]}};a.tags=[];b.name="Related";b.slug="related";b.mediaType="Article";b.articleBody={body:{content:[{nodeType:"text",value:"RELATED BODY MUST NOT APPEAR",marks:[]}]}};return {a,b}})</script>`;
  const out=extractEmbeddedArticleBody(html,'https://club.example/media-article/team-news');
  assert.match(out.text,/Player is ready/);
  assert.match(out.text,/manager confirmed/);
  assert.doesNotMatch(out.text,/RELATED BODY/);
  assert.equal(out.publishedAt,Date.parse('2026-08-10T06:30+01:00'));
});

test('sitemap discovery keeps same-host editorial URLs and lastmod order',()=>{
  const xml=`<urlset>
    <url><loc>https://club.example/news/2026/august/08/older</loc><lastmod>2026-08-08</lastmod></url>
    <url><loc>https://club.example/privacy-policy</loc><lastmod>2026-08-11</lastmod></url>
    <url><loc>https://club.example/news/2026/august/10/newer</loc><lastmod>2026-08-10</lastmod></url>
    <url><loc>https://other.example/news/2026/august/11/off-host</loc><lastmod>2026-08-11</lastmod></url>
  </urlset>`;
  const out=parseSitemapXml(xml,'https://club.example/news');
  assert.deepEqual([...out.rows].map(row=>row.url),[
    'https://club.example/news/2026/august/10/newer',
    'https://club.example/news/2026/august/08/older'
  ]);
});

test('sitemap URL dates recover freshness when lastmod is absent',()=>{
  const xml=`<urlset>
    <url><loc>https://club.example/news/2026/march/20/older-team-news</loc></url>
    <url><loc>https://club.example/news/2026/august/10/newer-team-news</loc></url>
  </urlset>`;
  const out=parseSitemapXml(xml,'https://club.example/news');
  assert.equal(out.rows[0].url,'https://club.example/news/2026/august/10/newer-team-news');
  assert.equal(out.rows[0].timeSource,'sitemap:url-date');
});

test('hard exclusions reject boilerplate, listings, squads and non-mens pages',()=>{
  const host='club.example',year=2026;
  for(const path of [
    '/accessibility','/modern-slavery-statement','/privacy-portal','/company-details',
    '/news/category/interviews','/en/news/listing/mens-news','/first-team-men-squad',
    '/news/2026/august/10/women-team-news','/news/2026/august/10/u21-squad-news','/news/2026/august/10/u21s-squad-news',
    '/news/2026/august/10/club-sign-young-lioness-on-loan','/news/2026/august/10/pre-season-camp-for-town-women',
    '/media-article/mft-mu21-player-contract','/news/2026/august/10/former-blue-trains-with-everton-under-21s',
    '/the-club/partners','/the-club/subscribe','/the-club/careers','/the-stadium/attending-matches','/news/url('
  ])assert.equal(scoreLink(`https://${host}${path}`,host,year).score,-99,path);
});

test('substring press inside impression no longer creates a false candidate',()=>{
  const scored=scoreLink('https://club.example/riverside-development/artists-impression','club.example',2026);
  assert.ok(scored.score<=1);
});

test('commercial kit and cup-draw paths do not consume article slots',()=>{
  const host='club.example';
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/third-kit-released`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/carabao-cup-draw`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/club-announces-partnership`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/watch-friendly-live`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/programme-subscription-and-win-a-signed-shirt`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/exclusive-giveaway`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/be-a-club-mascot`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/supporters-club-applications-open`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/fantasy-premier-league-prices-revealed`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/friendly-now-on-general-sale`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/the-seat-move-window-opens`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/loyalty-points-update`,host,2026).score<=1);
  assert.ok(scoreLink(`https://${host}/news/2026/august/10/club-will-face-either-rival-in-round-two-of-the-carabao-cup`,host,2026).score<=1);
  assert.equal(scoreLink(`https://${host}/news/clubservices.co.uk`,host,2026).score,-99);
});

test('valid first-team news remains selectable after hardening',()=>{
  const base='https://club.example/news';
  const links=[
    'https://club.example/news/2026/august/10/player-returns-to-training',
    'https://club.example/news/category/interviews',
    'https://club.example/accessibility'
  ];
  const selected=selectArticleLinks(base,links,8,new Map(),0);
  assert.deepEqual([...selected.candidates],['https://club.example/news/2026/august/10/player-returns-to-training']);
});
