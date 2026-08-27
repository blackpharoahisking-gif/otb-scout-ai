import roleFreshness, { FreshReviewWorkflow } from './role-freshness-entry.js';
import { repairFreshReviewResponse } from './src/fresh-review-integrity.js';

export { FreshReviewWorkflow };

export default {
  async fetch(request,env,ctx){
    const response=await roleFreshness.fetch(request,env,ctx);
    const path=new URL(request.url).pathname;
    return path==='/api/fresh-review'||path.startsWith('/api/fresh-review/')
      ?repairFreshReviewResponse(response)
      :response;
  },
  async scheduled(event,env,ctx){
    return roleFreshness.scheduled(event,env,ctx);
  }
};
