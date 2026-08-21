import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/^import\s+\{\s*WorkflowEntrypoint\s*\}\s+from\s+'cloudflare:workers';\s*/m,'')
  .replace(/export class FreshReviewWorkflow/, 'class FreshReviewWorkflow')
  .replace(/export default\s*\{/, 'const workerDefault = {')
  +'\n;globalThis.__x={validateEvents,extractionSchema};';
class WorkflowEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}}
const context={URL,Date,Map,Set,RegExp,Object,Array,String,Number,Math,JSON,console,crypto:globalThis.crypto,WorkflowEntrypoint};
vm.createContext(context);
vm.runInContext(source,context,{filename:'worker.js'});
const {validateEvents,extractionSchema}=context.__x;

const players=[
  {id:11,name:'Dunk',fullName:'Lewis Dunk',fplPosition:'DEF'},
  {id:12,name:'Vuskovic',fullName:'Luka Vuskovic',fplPosition:'DEF'},
];
const ARTICLE='https://www.brightonandhovealbion.com/media-article/hurzeler-on-the-defence';
const docs=[{url:ARTICLE,publishedAt:Date.now()-3600000,dateSource:'typed-slug',
  text:'Fabian Hurzeler confirmed that Lewis Dunk will captain the side and Luka Vuskovic keeps his place at the back.'}];
const ev=(over={})=>({type:'manager_positive',subject:'Dunk',affected:'Dunk',
  overlap:.9,hierarchy:.9,confidence:.8,source:ARTICLE,reason:'Manager confirmed he keeps his place.',...over});

test('the extraction schema still treats role as optional',()=>{
  const req=extractionSchema().properties.events.items.required;
  assert.equal([...req].includes('role'),false,
    'if role ever becomes required here, the validator must be revisited with it');
});

test('an event with no position is accepted instead of silently discarded',()=>{
  const stats={};
  const out=validateEvents('BHA',players,[ev()],docs,stats);
  assert.equal(out.length,1,'a manager quote carries no position by nature and must still count');
  assert.equal(out[0].role,null);
  assert.equal(stats.proposed,1);
  assert.equal(stats.accepted,1);
});

test('a stated position is still preserved when the model supplies one',()=>{
  const out=validateEvents('BHA',players,[ev({role:'CB'})],docs,{});
  assert.equal(out[0].role,'CB');
});

test('a position outside the vocabulary is ignored rather than fatal',()=>{
  const out=validateEvents('BHA',players,[ev({role:'SWEEPER'})],docs,{});
  assert.equal(out.length,1);
  assert.equal(out[0].role,null);
});

test('a correct citation survives trailing slashes, casing and a www prefix',()=>{
  for(const cited of [
    ARTICLE+'/',
    ARTICLE.replace('www.brightonandhovealbion.com','BrightonAndHoveAlbion.com'),
    ARTICLE.toUpperCase().replace('HTTPS','https').replace('WWW.BRIGHTONANDHOVEALBION.COM','www.brightonandhovealbion.com'),
  ]){
    const stats={};
    const out=validateEvents('BHA',players,[ev({source:cited})],docs,stats);
    assert.equal(out.length,1,`formatting variant must not read as a hallucination: ${cited}`);
    assert.equal(stats.notASuppliedDocument,0);
  }
});

test('a genuinely invented citation is still rejected and named',()=>{
  const stats={};
  const out=validateEvents('BHA',players,[ev({source:'https://www.brightonandhovealbion.com/media-article/never-published'})],docs,stats);
  assert.equal(out.length,0);
  assert.equal(stats.notASuppliedDocument,1,'the anti-hallucination guard must survive the relaxation');
});

test('an off-host citation is rejected and named',()=>{
  const stats={};
  validateEvents('BHA',players,[ev({source:'https://rumour-site.example/story'})],docs,stats);
  assert.equal(stats.offHost,1);
});

test('every rejection names the gate that made it',()=>{
  const stats={};
  const out=validateEvents('BHA',players,[
    ev(),
    ev({affected:'Nobody Here'}),
    ev({type:'not_a_real_type'}),
    ev({type:'observed_role',subject:'Vuskovic',affected:'Dunk'}),
    ev({source:'not-a-url'}),
    ev(),
  ],docs,stats);
  assert.equal(stats.proposed,6);
  assert.equal(stats.accepted,1);
  assert.equal(stats.unknownPlayer,1);
  assert.equal(stats.unknownType,1);
  assert.equal(stats.subjectMismatch,1,'observed_role must describe the subject\'s own selection');
  assert.equal(stats.malformedSource,1);
  assert.equal(stats.duplicate,1);
  assert.equal(out.length,1);
});

test('a zero yield is now attributable rather than merely zero',()=>{
  const stats={};
  const out=validateEvents('BHA',players,[ev({affected:'Someone Else'}),ev({affected:'Another Ghost'})],docs,stats);
  assert.equal(out.length,0);
  assert.equal(stats.proposed,2);
  assert.equal(stats.unknownPlayer,2,'"the model proposed nothing" and "we threw it all away" must be distinguishable');
});

test('a transfer claim the article text does not corroborate is still refused',()=>{
  const stats={};
  const out=validateEvents('BHA',players,[ev({type:'signing',subject:'Some Newcomer',affected:'Vuskovic',role:'CB'})],
    [{...docs[0],text:'An article that never mentions the affected player at all.'}],stats);
  assert.equal(out.length,0);
  assert.equal(stats.affectedNotNamedInText,1);
});
