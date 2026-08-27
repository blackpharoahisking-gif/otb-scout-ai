export const TEAM_CODES = Object.freeze(['ARS','AVL','BOU','BRE','BHA','CHE','COV','CRY','EVE','FUL','HUL','IPS','LEE','LIV','MCI','MUN','NEW','NFO','SUN','TOT']);

export function normaliseTeams(input){
  const list=Array.isArray(input)?input:String(input||'').split(',');
  const allowed=new Set(TEAM_CODES);
  return [...new Set(list.map(x=>String(x||'').trim().toUpperCase()).filter(x=>allowed.has(x)))];
}

export function reportTimestampMs(report){
  const candidates=[
    report?.generatedAt,
    report?.evidenceGeneratedAt,
    report?.updatedAt,
    report?.completedAt,
    report?.diagnostics?.completedAt,
    report?.diagnostics?.generatedAt,
  ];
  for(const value of candidates){const ms=Date.parse(value||'');if(Number.isFinite(ms))return ms}
  return null;
}

export function freshnessState(ageMinutes,{deadlineMinutes=null}={}){
  if(!Number.isFinite(ageMinutes))return 'missing';
  const late=Number.isFinite(deadlineMinutes)&&deadlineMinutes>=0&&deadlineMinutes<=90;
  const deadline=Number.isFinite(deadlineMinutes)&&deadlineMinutes>=0&&deadlineMinutes<=360;
  const freshMax=late?30:deadline?60:120;
  const staleAt=late?60:deadline?120:240;
  if(ageMinutes<=freshMax)return 'fresh';
  if(ageMinutes<=staleAt)return 'aging';
  return 'stale';
}

export function refreshBudget(deadlineMinutes,{normal=1,deadline=3,late=5}={}){
  if(Number.isFinite(deadlineMinutes)&&deadlineMinutes>=0&&deadlineMinutes<=90)return late;
  if(Number.isFinite(deadlineMinutes)&&deadlineMinutes>=0&&deadlineMinutes<=360)return deadline;
  return normal;
}

export function priorityScore(row,now=Date.now()){
  const age=Number.isFinite(row?.ageMinutes)?row.ageMinutes:100000;
  const requestedAt=Number(row?.requestedAt)||0;
  const requestAge=requestedAt?Math.max(0,(now-requestedAt)/60000):100000;
  const queue=Number(row?.priority)||0;
  const news=row?.newsAfterReport===true?1000000:0;
  const missing=row?.missing===true?500000:0;
  const stale=Math.min(200000,Math.max(0,age)*100);
  const waiting=Math.min(50000,requestAge*10);
  return news+missing+queue*10000+stale+waiting;
}

export function selectRefreshTeams(rows,{budget=1,now=Date.now()}={}){
  return [...(rows||[])]
    .filter(r=>r&&r.team&&r.scanEligible!==false)
    .sort((a,b)=>priorityScore(b,now)-priorityScore(a,now)||String(a.team).localeCompare(String(b.team)))
    .slice(0,Math.max(0,Math.trunc(budget)))
    .map(r=>r.team);
}
