export const FRESH_DECISION_INTEGRITY_VERSION='fresh-review-decision-integrity-v1';

function num(v,d=0){const n=Number(v);return Number.isFinite(n)?n:d}

function decisionEvidence(review){
  return (Array.isArray(review?.evidence)?review.evidence:[]).filter(e=>e?.decisionEligible===true&&e?.decisionRelevant!==false&&e?.signal!=='neutral');
}

export function canonicalFreshClassification(review){
  const evidence=decisionEvidence(review);
  if(!evidence.length)return 'UNKNOWN';
  const meaningful=evidence.filter(e=>num(e?.weight)>=0.2);
  const positive=meaningful.filter(e=>e.signal==='positive').reduce((s,e)=>s+num(e.weight),0);
  const negative=meaningful.filter(e=>e.signal==='negative').reduce((s,e)=>s+num(e.weight),0);
  if(!positive&&!negative)return 'UNKNOWN';
  const direct=meaningful.filter(e=>e?.hierarchyInference!==true);
  if(!direct.length&&meaningful.some(e=>e?.hierarchyInference===true))return 'MONITOR';
  if(positive>0&&negative>0&&Math.min(positive,negative)>=0.35*Math.max(positive,negative))return 'MONITOR';
  const pStart=num(review?.otb?.startProbability);
  if(negative>positive){
    if(pStart>=0.78&&negative>=0.75)return 'STRONG DOWNGRADE';
    return pStart<=0.45?'AGREE':'DOWNGRADE';
  }
  if(pStart<=0.55&&positive>=0.7)return 'STRONG UPGRADE';
  return pStart>=0.86?'AGREE':'UPGRADE';
}

export function canonicalFreshStatus(review,classification=canonicalFreshClassification(review),activeChip='NONE'){
  const critical=review?.scoring===true||activeChip==='BENCH_BOOST';
  const availability=num(review?.otb?.availability,1),pStart=num(review?.otb?.startProbability),xMins=num(review?.otb?.expectedMinutes);
  if(availability<0.5)return critical?'RED':'AMBER';
  if(activeChip==='BENCH_BOOST'&&(pStart<0.5||xMins<45))return 'RED';
  if(activeChip==='TRIPLE_CAPTAIN'&&review?.captain&&(pStart<0.78||xMins<65))return 'RED';
  if(classification==='STRONG DOWNGRADE')return critical?'RED':'AMBER';
  if(classification==='DOWNGRADE'||classification==='MONITOR')return 'AMBER';
  if(classification==='STRONG UPGRADE'||classification==='UPGRADE')return 'OPPORTUNITY';
  if(critical&&(pStart<0.7||xMins<55))return 'AMBER';
  return 'GREEN';
}

export function repairFreshPlayerReview(review,{activeChip='NONE'}={}){
  if(!review||typeof review!=='object')return review;
  const classification=canonicalFreshClassification(review),status=canonicalFreshStatus(review,classification,activeChip);
  return {...review,classification,status,decisionIntegrityVersion:FRESH_DECISION_INTEGRITY_VERSION};
}

function priority(review){
  let score=({RED:40,AMBER:20,OPPORTUNITY:10,GREEN:0})[review?.status]||0;
  if(review?.scoring)score+=8;if(review?.captain)score+=5;
  if(review?.classification==='STRONG DOWNGRADE')score+=8;if(review?.classification==='UNKNOWN')score+=2;
  return score;
}
function materialIssue(review){
  if(['STRONG DOWNGRADE','DOWNGRADE','MONITOR'].includes(review?.classification)||review?.status==='RED')return true;
  if(review?.status!=='AMBER')return false;
  return review?.classification!=='UNKNOWN'||num(review?.otb?.availability,1)<0.5||num(review?.otb?.startProbability)<0.7||num(review?.otb?.expectedMinutes)<55;
}
function rebuildSummary(review,rows){
  const negative=rows.filter(materialIssue).sort((a,b)=>priority(b)-priority(a));
  const positive=rows.filter(r=>r.status==='OPPORTUNITY').sort((a,b)=>priority(b)-priority(a));
  const primary=negative[0]||null,secondary=negative.slice(1,3),captain=rows.find(r=>r.captain),scoring=rows.filter(r=>r.scoring),unverified=scoring.filter(r=>r.evidenceCoverage==='UNVERIFIED');
  const primaryIssue=primary?`${primary.name} — ${primary.rationale}`:unverified.length?`No evidence-backed player concern was identified; the live audit was inconclusive for ${unverified.length} of ${scoring.length} scoring players.`:'No material current concern emerged from the source-ranked review.';
  const positiveDisagreement=positive[0]?`${positive[0].name} — ${positive[0].rationale}`:'No material positive disagreement emerged.';
  let captainAssessment=`${captain?.name||'Captain'}: evidence unavailable.`;
  if(captain)captainAssessment=captain.status==='RED'?`${captain.name} requires captaincy review.`:captain.status==='AMBER'?`${captain.name} remains plausible but carries a material risk signal.`:captain.evidenceCoverage==='UNVERIFIED'?`${captain.name} remains OTB's captain choice, but the live review did not independently validate him.`:captain.evidenceCoverage==='PARTIAL'?`${captain.name} remains OTB's captain choice with partial external support.`:`${captain.name} remains defensible on current evidence.`;
  let overall='The live evidence audit found no material reason to change the saved squad automatically.';
  const activeChip=String(review?.activeChip||'NONE');
  if(activeChip==='BENCH_BOOST'&&primary)overall='Bench Boost makes all 15 scoring decisions material. Resolve the primary start-security issue before the deadline; OTB projections remain unchanged.';
  else if(activeChip==='TRIPLE_CAPTAIN')overall='Triple Captain increases captain evidence sensitivity. Review the captain finding before committing; OTB projections remain unchanged.';
  else if(primary)overall='The squad remains intact, but the highlighted live-evidence risk deserves a manual decision before deadline.';
  else if(unverified.length)overall=`No projection or squad change was made. External coverage remains incomplete for ${unverified.length} scoring players, so this run should be treated as an inconclusive audit rather than a clean bill of health.`;
  const coverageWarning=unverified.length?`${unverified.length} of ${scoring.length} scoring players were not independently verified by current external evidence.`:'Every scoring player had at least partial current external evidence.';
  return {coverageWarning,primaryIssue,secondaryRisks:secondary.map(r=>`${r.name} — ${r.rationale}`),positiveDisagreement,captainAssessment,overallVerdict:overall};
}

export function repairFreshReview(review){
  if(!review||typeof review!=='object'||!Array.isArray(review.playerReviews))return review;
  const activeChip=String(review.activeChip||'NONE'),playerReviews=review.playerReviews.map(r=>repairFreshPlayerReview(r,{activeChip}));
  const counts={GREEN:0,OPPORTUNITY:0,AMBER:0,RED:0};for(const row of playerReviews)counts[row.status]=(counts[row.status]||0)+1;
  return {...review,playerReviews,counts,summary:rebuildSummary({...review,activeChip},playerReviews),decisionIntegrityVersion:FRESH_DECISION_INTEGRITY_VERSION};
}

export function repairFreshReviewPayload(payload){
  if(!payload||typeof payload!=='object')return payload;
  const activeChip=String(payload?.review?.activeChip||payload?.activeChip||'NONE');
  const out={...payload};
  if(out.playerReview)out.playerReview=repairFreshPlayerReview(out.playerReview,{activeChip});
  if(out.review)out.review=repairFreshReview(out.review);
  return out;
}

export async function repairFreshReviewResponse(response){
  if(!response||response.status===204||response.status===205||response.status===304)return response;
  let body;try{body=await response.clone().json()}catch{return response}
  const repaired=repairFreshReviewPayload(body),headers=new Headers(response.headers);headers.delete('content-length');
  headers.set('cache-control','no-store');
  return new Response(JSON.stringify(repaired),{status:response.status,statusText:response.statusText,headers});
}
