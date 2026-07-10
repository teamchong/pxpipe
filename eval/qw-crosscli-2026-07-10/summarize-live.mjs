#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1')), dir=path.join(here,'results');
const arms=['a0','a1',...Array.from({length:10},(_,i)=>`b${String(i+1).padStart(2,'0')}`),'ball'];
const SHA='9e43f1b3e31442a93acc504bd7ab466bc83f7860', UUID='019c6e27-e55b-73d1-87d8-4e01f1f75043';
const nums=(xs,k)=>xs.map(x=>x?.[k]).filter(Number.isFinite);
const pct=(a,p)=>{if(!a.length)return null;const x=[...a].sort((a,b)=>a-b);return x[Math.ceil(p*x.length)-1]};
const stats=a=>a.length?{count:a.length,min:Math.min(...a),p50:pct(a,.5),p95:pct(a,.95),max:Math.max(...a)}:null;
const readLines=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8').split(/\r?\n/).filter(Boolean):[];
const summary=[];
for(const arm of arms){
  // Only A0/A1 have arm-specific proxy captures. B-all is the accepted candidate
  // capture. Isolated/no-op B arms are client-regression-only: never silently pool A1.
  const proxyFile=arm==='ball'?'live-candidate.jsonl':(['a0','a1'].includes(arm)?`live-${arm}.jsonl`:null);
  const allProxy=proxyFile?readLines(path.join(dir,proxyFile)).flatMap(s=>{try{const x=JSON.parse(s);return x.status>=200&&x.status<400?[x]:[]}catch{return[]}}).filter(x=>x.method==='POST'):[];
  for(const client of ['codex','claude']){
    const protocol=client==='codex'?'openai-responses':'anthropic-messages';
    const proxy=allProxy.filter(x=>x.protocol===protocol);
    const runs=[];
    for(let i=1;i<=3;i++){const lines=readLines(path.join(dir,`live-${arm}-${client}-${i}.jsonl`));let text=lines.join('\n'),usage={};
      if(client==='codex')for(const s of lines)try{const x=JSON.parse(s);if(x.type==='item.completed'&&x.item?.type==='agent_message')text=x.item.text;if(x.type==='turn.completed')usage=x.usage??{}}catch{}
      const exact_sha=text.includes(SHA),exact_uuid=text.includes(UUID),negation=/DO NOT SUBMIT/i.test(text);
      runs.push({repetition:i,success:exact_sha&&exact_uuid&&negation,exact_sha,exact_uuid,critical_negation:negation,input_tokens:Number.isFinite(usage.input_tokens)?usage.input_tokens:null,cached_input_tokens:Number.isFinite(usage.cached_input_tokens)?usage.cached_input_tokens:null,output_tokens:Number.isFinite(usage.output_tokens)?usage.output_tokens:null});
    }
    summary.push({arm,client,attempts:3,successes:runs.filter(x=>x.success).length,exact_sha:runs.filter(x=>x.exact_sha).length,exact_uuid:runs.filter(x=>x.exact_uuid).length,critical_negation:runs.filter(x=>x.critical_negation).length,input_tokens:stats(nums(runs,'input_tokens')),cached_input_tokens:stats(nums(runs,'cached_input_tokens')),output_tokens:stats(nums(runs,'output_tokens')),proxy_source:proxyFile,proxy_protocol:protocol,proxy_success_posts:proxy.length,proxy_input_tokens:stats(nums(proxy,'input_tokens')),proxy_cache_read_tokens:stats(nums(proxy,'cache_read_tokens')),proxy_duration_ms:stats(nums(proxy,'duration_ms')),provider_cost_usd:null,ocr_cer_wer:null,runs});
  }
}
const matrix=[
 ['QW01','PASS','PASS','telemetry accepted for both protocols'],['QW02','PASS','N/A','OpenAI-only candidate; Claude 3/3 regression'],['QW03','PASS','N/A','OpenAI-only candidate; Claude 3/3 regression'],['QW04','FAIL','FAIL','not accepted'],['QW05','PASS','N/A','OpenAI-only candidate; Claude 3/3 regression'],['QW06','FAIL','FAIL','threshold sweep not accepted'],['QW07','FAIL','N/A','OpenAI-only; not accepted'],['QW08','FAIL','FAIL','not accepted'],['QW09','FAIL','N/A','OpenAI-only; not accepted'],['QW10','FAIL','N/A','OpenAI-only; not accepted']
].map(([qw,codex,claude,note])=>({qw,codex,claude,note}));
const codex=x=>summary.find(r=>r.arm===x&&r.client==='codex')?.input_tokens?.p50??null;
const a0=codex('a0'),a1=codex('a1'),ball=codex('ball');
const formulas={codex_raw_a0_to_a1:{a0_median_input_tokens:a0,a1_median_input_tokens:a1,savings_percent:a0===null||a1===null?null:(a0-a1)/a0*100,formula:'(A0-A1)/A0; cache excluded'},codex_raw_a0_to_ball:{a0_median_input_tokens:a0,ball_median_input_tokens:ball,savings_percent:a0===null||ball===null?null:(a0-ball)/a0*100,formula:'(A0-B-all)/A0; cache excluded'},codex_incremental_a1_to_ball:{a1_median_input_tokens:a1,ball_median_input_tokens:ball,savings_percent:a1===null||ball===null?null:(a1-ball)/a1*100,formula:'(A1-B-all)/A1; cache excluded'},cache:'reported separately; never added to raw savings',qw06_b02_to_b06:'no accepted improvement'};
const result={generated_at:new Date().toISOString(),source:'live-*.jsonl; HTTP 4xx records excluded and bodies never ingested',candidate_composition:'B-all = QW01 + QW02 + QW03 + QW05',summary,matrix,formulas,limitations:{provider_cost:'not observable',ocr_cer_wer:'not measured; not inferred',claude_usage:'not observable in client output where absent',isolated_b_proxy:'not assigned; no A1 pooling unless explicitly labeled equivalent'}};
fs.writeFileSync(path.join(dir,'live-summary.json'),JSON.stringify(result,null,2)+'\n');
const csv=['arm,client,attempts,successes,exact_sha,exact_uuid,critical_negation,input_min,input_p50,input_p95,input_max,cached_min,cached_p50,cached_p95,cached_max,proxy_source,proxy_protocol,proxy_posts,proxy_input_p50,proxy_cache_read_p50'];
for(const x of summary){const q=v=>v??'';csv.push([x.arm,x.client,x.attempts,x.successes,x.exact_sha,x.exact_uuid,x.critical_negation,q(x.input_tokens?.min),q(x.input_tokens?.p50),q(x.input_tokens?.p95),q(x.input_tokens?.max),q(x.cached_input_tokens?.min),q(x.cached_input_tokens?.p50),q(x.cached_input_tokens?.p95),q(x.cached_input_tokens?.max),q(x.proxy_source),x.proxy_protocol,x.proxy_success_posts,q(x.proxy_input_tokens?.p50),q(x.proxy_cache_read_tokens?.p50)].join(','))}
fs.writeFileSync(path.join(dir,'live-summary.csv'),csv.join('\n')+'\n'); console.log(JSON.stringify({arms:arms.length,rows:summary.length,matrix},null,2));
