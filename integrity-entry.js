import roleFreshness, { FreshReviewWorkflow } from './role-freshness-entry.js';
import { FRESH_DECISION_INTEGRITY_VERSION, repairFreshReviewResponse } from './src/fresh-review-integrity.js';

export { FreshReviewWorkflow };

async function addIntegrityHealth(response){
  if(!response?.ok)return response;
  let body;try{body=await response.clone().json()}catch{return response}
  if(!body||typeof body!=='object')return response;
  const headers=new Headers(response.headers);headers.delete('content-length');headers.set('cache-control','no-store');
  return new Response(JSON.stringify({...body,freshReviewDecisionIntegrity:FRESH_DECISION_INTEGRITY_VERSION}),{status:response.status,statusText:response.statusText,headers});
}

export default {
  async fetch(request,env,ctx){
    const response=await roleFreshness.fetch(request,env,ctx);
    const path=new URL(request.url).pathname;
    if(path==='/api/health'||path==='/')return addIntegrityHealth(response);
    return path==='/api/fresh-review'||path.startsWith('/api/fresh-review/')
      ?repairFreshReviewResponse(response)
      :response;
  },
  async scheduled(event,env,ctx){
    return roleFreshness.scheduled(event,env,ctx);
  }
};
