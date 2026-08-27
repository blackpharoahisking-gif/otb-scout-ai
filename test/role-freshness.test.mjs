import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normaliseTeams,reportTimestampMs,freshnessState,refreshBudget,selectRefreshTeams,priorityScore} from '../src/role-freshness-core.js';

const entry=fs.readFileSync(new URL('../role-freshness-entry.js',import.meta.url),'utf8');

test('normaliseTeams keeps only supported clubs and de-duplicates',()=>{
  assert.deepEqual(normaliseTeams(['ars','AVL','ARS','xxx','  che ']),['ARS','AVL','CHE']);
});

test('report timestamp prefers generated report time',()=>{
  assert.equal(reportTimestampMs({generatedAt:'2026-08-27T04:00:00Z',evidenceGeneratedAt:'2026-08-27T03:00:00Z'}),Date.parse('2026-08-27T04:00:00Z'));
  assert.equal(reportTimestampMs({}),null);
});

test('freshness tightens automatically near deadline',()=>{
  assert.equal(freshnessState(100),'fresh');
  assert.equal(freshnessState(150),'aging');
  assert.equal(freshnessState(250),'stale');
  assert.equal(freshnessState(75,{deadlineMinutes:300}),'aging');
  assert.equal(freshnessState(75,{deadlineMinutes:60}),'stale');
  assert.equal(freshnessState(25,{deadlineMinutes:60}),'fresh');
});

test('cron budget expands toward the deadline',()=>{
  assert.equal(refreshBudget(null),1);
  assert.equal(refreshBudget(500),1);
  assert.equal(refreshBudget(300),3);
  assert.equal(refreshBudget(60),5);
});

test('new club evidence outranks an ordinary stale refresh',()=>{
  const now=Date.parse('2026-08-27T08:00:00Z');
  const rows=[
    {team:'AVL',ageMinutes:400,priority:2,requestedAt:now-3600000,scanEligible:true},
    {team:'ARS',ageMinutes:20,priority:0,newsAfterReport:true,scanEligible:true},
    {team:'CHE',ageMinutes:1000,priority:0,scanEligible:true},
  ];
  assert.ok(priorityScore(rows[1],now)>priorityScore(rows[0],now));
  assert.deepEqual(selectRefreshTeams(rows,{budget:2,now}),['ARS','CHE']);
});

test('planner priority can promote a team ahead of ordinary age',()=>{
  const rows=[
    {team:'BRE',ageMinutes:300,priority:1,requestedAt:1,scanEligible:true},
    {team:'LIV',ageMinutes:50,priority:9,requestedAt:1,scanEligible:true},
  ];
  assert.equal(selectRefreshTeams(rows,{budget:1,now:1000000})[0],'LIV');
});

test('CORS preflight is a bodyless 204 response',()=>{
  assert.match(entry,/const noBody=status===204\|\|status===205\|\|status===304/);
  assert.match(entry,/new Response\(noBody\?null:JSON\.stringify\(body\)/);
  assert.match(entry,/return json\(null,204,request,env\)/);
});
