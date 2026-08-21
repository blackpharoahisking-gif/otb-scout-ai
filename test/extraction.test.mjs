import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/^import\s+\{\s*WorkflowEntrypoint\s*\}\s+from\s+'cloudflare:workers';\s*/m,'')
  .replace(/export class FreshReviewWorkflow/, 'class FreshReviewWorkflow')
  .replace(/export default\s*\{/, 'const workerDefault = {')
  +'\n;globalThis.__x={validateEvents,extractionSchema,isMensFirstTeamSource,femaleSubjectDominant};';
class WorkflowEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}}
const context={URL,Date,Map,Set,RegExp,Object,Array,String,Number,Math,JSON,console,crypto:globalThis.crypto,WorkflowEntrypoint};
vm.createContext(context);
vm.runInContext(source,context,{filename:'worker.js'});
const {validateEvents,extractionSchema,isMensFirstTeamSource,femaleSubjectDominant}=context.__x;

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

/* Arsenal's 03:12 scan read exactly two documents: a 14,531-character
   pre-season interview with Renee Slegers -- the WOMEN'S manager -- and a
   training photo gallery. The extractor returning zero from those was CORRECT.
   Nothing filtered the documents handed to it for men's first-team relevance,
   and a piece titled only with a person's name carries no URL marker to catch,
   exactly like a-day-in-the-life-of-alessia-russo earlier in the same session. */

const WOMENS_INTERVIEW=(
  'Renee Slegers sat down before the new campaign to reflect on where her side stands. '+
  'She said she has been pleased with what she saw in pre-season, and that her players '+
  'have taken on her ideas quickly. She singled out the captain, saying she has led by '+
  'example and that her attitude in training has set the tone. She added that she expects '+
  'her squad to compete on every front, and that she will name her strongest available '+
  'eleven for the opener. She confirmed that her goalkeeper will start, and she praised '+
  'her defenders for how they adapted. She believes her team can improve again this year. '+
  'She noted that her preparation has gone to plan and that she is happy with her group. '+
  'She wants her side to start well and she said she has told her players exactly that.'
);
const MENS_REPORT=(
  'Fabian Hurzeler named an unchanged side and said he was pleased with his players. '+
  'He confirmed that his captain kept his place at the back, and he praised him for how '+
  'he organised the defence. He said his goalkeeper had earned his place, and that he '+
  'expects him to start again. He added that he will assess his squad before he settles '+
  'on his eleven, and he suggested his forward is close to a return after his injury. '+
  'He was asked about his plans and he said he wants his team to keep his standards high. '+
  'He noted that his preparation has gone to plan and that he is happy with his group. '+
  'He wants his side to start well and he said he has told his players exactly that.'
);

test('a womens-team interview is kept out of the mens extractor',()=>{
  assert.equal(WOMENS_INTERVIEW.length>=600,true,'fixture must be long enough to be judged');
  assert.equal(femaleSubjectDominant(WOMENS_INTERVIEW),true);
  assert.equal(isMensFirstTeamSource('https://www.arsenal.com/news/renee-slegers-big-pre-season-interview',WOMENS_INTERVIEW),false,
    'the exact article that consumed most of Arsenal\'s document budget');
});

test('a mens match report is unaffected',()=>{
  assert.equal(femaleSubjectDominant(MENS_REPORT),false);
  assert.equal(isMensFirstTeamSource('https://www.brightonandhovealbion.com/media-article/hurzeler-on-the-defence',MENS_REPORT),true);
});

test('a mens article mentioning the womens team in passing is not tripped',()=>{
  const passing=MENS_REPORT+' He also congratulated the club on a strong start for her side in the league.';
  assert.equal(femaleSubjectDominant(passing),false,'one mention must not disqualify a mens article');
  assert.equal(isMensFirstTeamSource('https://club.example/media-article/hurzeler-preview',passing),true);
});

test('short text is never judged on pronouns',()=>{
  assert.equal(femaleSubjectDominant('She started. She scored. She was excellent. She led.'),false,
    'too little text to infer a subject reliably');
  assert.equal(femaleSubjectDominant(''),false);
});

test('womens competition names are refused on their own',()=>{
  const pad='x'.repeat(700);
  assert.equal(isMensFirstTeamSource('https://club.example/news/report',`Result from the WSL this weekend. ${pad}`),false);
  assert.equal(isMensFirstTeamSource('https://club.example/news/report',`A tie in the Women's Champions League. ${pad}`),false);
});

test('the url marker still catches what it always caught',()=>{
  assert.equal(isMensFirstTeamSource('https://club.example/womens/news/report',''),false);
  assert.equal(isMensFirstTeamSource('https://club.example/academy/news/report',''),false);
  assert.equal(isMensFirstTeamSource('https://club.example/news/2026/august/10/team-news',''),true);
});

/* Leeds, 21 Aug: the model proposed 3 events and the validator accepted 0 --
   subjectMismatch 2, affectedNotNamedInText 1. loan_out required
   subject === affected, the inverse of the loan_in rule beside it and of the
   prompt the model is handed ("For departure/injury events, affected is the
   beneficiary"). loan_out normalises to `departure`, scored k=+0.4 FOR THE
   AFFECTED, so subject === affected would have boosted the departing player. */

const LOAN_DOC=[{url:ARTICLE,publishedAt:Date.now()-3600000,dateSource:'typed-slug',
  text:'Sebastiaan Bornauw joins Hamburg SV on loan. Lewis Dunk is expected to take on more minutes at the back in his absence.'}];

test('a departure names the departing player as subject and the beneficiary as affected',()=>{
  const stats={};
  const out=validateEvents('BHA',players,[{type:'loan_out',subject:'Sebastiaan Bornauw',affected:'Dunk',
    overlap:.8,hierarchy:.7,confidence:.9,source:ARTICLE,reason:'Bornauw left on loan, freeing minutes.'}],LOAN_DOC,stats);
  assert.equal(out.length,1,'the shape the prompt asks for must be accepted');
  assert.equal(stats.selfReferential,0);
  assert.equal(out[0].type,'departure','loan_out normalises to departure');
  assert.equal(out[0].affected,'Dunk','the beneficiary, who inherits the minutes');
  assert.match(out[0].subject,/Bornauw/);
});

test('a departing player cannot be his own beneficiary',()=>{
  const stats={};
  const out=validateEvents('BHA',players,[{type:'loan_out',subject:'Dunk',affected:'Dunk',
    overlap:.8,hierarchy:.7,confidence:.9,source:ARTICLE,reason:'Self-referential departure.'}],LOAN_DOC,stats);
  assert.equal(out.length,0,'that would hand the departing player a +0.4 boost');
  assert.equal(stats.selfReferential,1);
});

test('a beneficiary absent from the article text is still refused',()=>{
  const stats={};
  // Vuskovic is on the roster fixture but is NOT named in the article text.
  const out=validateEvents('BHA',players,[{type:'loan_out',subject:'Sebastiaan Bornauw',affected:'Vuskovic',
    overlap:.8,hierarchy:.7,confidence:.9,source:ARTICLE,reason:'Beneficiary inferred, not stated.'}],LOAN_DOC,stats);
  assert.equal(out.length,0,'no beneficiary may be inferred from squad knowledge');
  assert.equal(stats.affectedNotNamedInText,1);
});

test('an incoming loan still may not threaten the arriving player himself',()=>{
  const stats={};
  validateEvents('BHA',players,[{type:'loan_in',subject:'Dunk',affected:'Dunk',
    overlap:.8,hierarchy:.7,confidence:.9,source:ARTICLE,reason:'Self-referential arrival.'}],LOAN_DOC,stats);
  assert.equal(stats.selfReferential,1,'the loan_in rule is unchanged');
});
