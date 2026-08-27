import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalFreshClassification,repairFreshPlayerReview,repairFreshReview} from '../src/fresh-review-integrity.js';

const tier1Positive=(summary='Official lineup confirms a start.')=>({
  id:'e1',signal:'positive',weight:.9,authorityTier:1,decisionEligible:true,decisionRelevant:true,hierarchyInference:false,summary
});

function player({name,pStart,xMins=80,xPts=5,classification='STRONG UPGRADE',status='OPPORTUNITY',scoring=true,evidence=[tier1Positive()],rationale='Tier 1 official evidence supports OTB assumption.'}){
  return {playerId:name,name,classification,status,scoring,captain:false,otb:{startProbability:pStart,expectedMinutes:xMins,xPts,availability:1},evidence,evidenceCoverage:'VERIFIED',decisionEvidenceCount:evidence.length,rationale};
}

test('high-start positive evidence is confirmation, not opportunity',()=>{
  const gabriel=player({name:'Gabriel',pStart:.92,xMins:83});
  assert.equal(canonicalFreshClassification(gabriel),'AGREE');
  const fixed=repairFreshPlayerReview(gabriel);
  assert.equal(fixed.classification,'AGREE');
  assert.equal(fixed.status,'GREEN');
});

test('low-start authoritative positive evidence is strong upgrade',()=>{
  const kinsky=player({name:'Kinsky',pStart:.41,xMins:37,classification:'UPGRADE',status:'OPPORTUNITY',rationale:"Tier 1 evidence contradicts OTB's 41% start band."});
  const fixed=repairFreshPlayerReview(kinsky);
  assert.equal(fixed.classification,'STRONG UPGRADE');
  assert.equal(fixed.status,'OPPORTUNITY');
});

test('review summary promotes the real disagreement and removes confirmations from opportunity count',()=>{
  const gabriel=player({name:'Gabriel',pStart:.92,xMins:83});
  const bruno=player({name:'B.Fernandes',pStart:.82,xMins:75,rationale:'Tier 1 official evidence supports OTB assumption.'});
  const kinsky=player({name:'Kinsky',pStart:.41,xMins:37,classification:'UPGRADE',status:'OPPORTUNITY',rationale:"Tier 1 evidence contradicts OTB's 41% start band."});
  const fixed=repairFreshReview({activeChip:'NONE',playerReviews:[gabriel,bruno,kinsky]});
  assert.equal(fixed.counts.OPPORTUNITY,2); // Bruno at 82% is still a material positive disagreement; Gabriel at 92% is confirmation.
  assert.equal(fixed.playerReviews.find(r=>r.name==='Gabriel').status,'GREEN');
  assert.match(fixed.summary.positiveDisagreement,/Kinsky|B\.Fernandes/);
  assert.doesNotMatch(fixed.summary.positiveDisagreement,/Gabriel/);
});

test('negative evidence agreeing with an already-low start band is not called a downgrade',()=>{
  const neg={id:'n1',signal:'negative',weight:.9,authorityTier:1,decisionEligible:true,decisionRelevant:true,hierarchyInference:false};
  const row=player({name:'Rotation risk',pStart:.40,xMins:35,evidence:[neg],classification:'DOWNGRADE',status:'AMBER',rationale:'Official evidence supports the low-start expectation.'});
  assert.equal(canonicalFreshClassification(row),'AGREE');
  assert.equal(repairFreshPlayerReview(row).status,'AMBER'); // still actionable because OTB itself has a low scoring-player start band
});
