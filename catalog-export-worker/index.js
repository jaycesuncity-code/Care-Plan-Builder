// Authenticated, fixed-query D1 catalog export for the Pages build.
// A D1 binding can write: the read-only boundary is these fixed SELECTs.
import { CATALOG_QUERIES } from "../lib/intake/pricing.js";
const encoder = new TextEncoder();
function json(body,status=200,extra={}) {
  return new Response(JSON.stringify(body),{status,headers:{
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store","x-content-type-options":"nosniff",...extra}});
}
async function matches(provided,expected) {
  const [a,b]=await Promise.all([provided,expected].map(value=>
    crypto.subtle.digest("SHA-256",encoder.encode(value))));
  const left=new Uint8Array(a),right=new Uint8Array(b);
  let diff=0;
  for(let i=0;i<left.length;i++) diff|=left[i]^right[i];
  return diff===0;
}
export default {
  async fetch(request,env) {
    if(request.method!=="GET") return json({error:"method_not_allowed"},405,{allow:"GET"});
    if(typeof env?.CATALOG_EXPORT_TOKEN!=="string" || !env.CATALOG_EXPORT_TOKEN || !env.DB)
      return json({error:"not_configured"},503);
    const auth=request.headers.get("authorization")||"";
    const token=auth.startsWith("Bearer ")?auth.slice(7):"";
    if(!token || token.length>4096 || !(await matches(token,env.CATALOG_EXPORT_TOKEN)))
      return json({error:"unauthorized"},401,{"www-authenticate":"Bearer"});
    try {
      const result=await env.DB.batch(CATALOG_QUERIES.map(sql=>env.DB.prepare(sql)));
      if(!Array.isArray(result) || result.length!==2 ||
          result.some(r=>!r || r.success===false || !Array.isArray(r.results)))
        throw new Error("catalog query failed");
      return json({meta:result[0].results[0]??null,items:result[1].results});
    } catch {
      return json({error:"catalog_unavailable"},503);
    }
  }
};
