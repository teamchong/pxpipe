#!/usr/bin/env node
/** Hermetic transform A/B. This does not contact either provider. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { encode } from 'gpt-tokenizer';
import { transformOpenAIResponses } from '../../dist/core/openai.js';
import { transformAnthropicMessages } from '../../dist/core/library.js';

const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1'));
const corpus=JSON.parse(fs.readFileSync(path.join(here,'corpus.json'),'utf8'));
const out=path.join(here,'results'); fs.mkdirSync(out,{recursive:true});
const stable=x=>JSON.stringify(x,Object.keys(x).sort());
const sha=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const cmd=(f,a=[])=>{try{return execFileSync(f,a,{encoding:'utf8'}).trim()}catch{return 'not observable'}};
const variants=['A0','A1',...Array.from({length:10},(_,i)=>`B${String(i+1).padStart(2,'0')}`),'B-all'];
const history=Array.from({length:12},(_,i)=>[
  {type:'function_call',call_id:`call_${i}`,name:'synthetic_lookup',arguments:JSON.stringify(corpus.expected.tool_call.arguments)},
  {type:'function_call_output',call_id:`call_${i}`,output:corpus.history.completed_tool_output.repeat(corpus.history.repeat)}
]).flat();
const instructions=corpus.authority.join('\n')+'\nExact identifiers:\n'+corpus.identifiers.join('\n');
const openai=()=>({model:'gpt-5.6',instructions,input:[{role:'user',content:[{type:'input_text',text:instructions} ]},...history,{role:'user',content:[{type:'input_text',text:corpus.history.tail}]}],tools:[{type:'function',name:corpus.tool.name,description:corpus.tool.description,parameters:corpus.tool.parameters,strict:true}]});
const anthropic=()=>({model:'claude-fable-5',system:instructions,tools:[{name:corpus.tool.name,description:corpus.tool.description,input_schema:corpus.tool.parameters}],messages:[{role:'user',content:instructions},...Array.from({length:12},(_,i)=>[{role:'assistant',content:[{type:'tool_use',id:`tool_${i}`,name:corpus.tool.name,input:corpus.expected.tool_call.arguments}]},{role:'user',content:[{type:'tool_result',tool_use_id:`tool_${i}`,content:corpus.history.completed_tool_output.repeat(corpus.history.repeat)}]}]).flat(),{role:'user',content:corpus.history.tail}]});

// Each arm is an actual public-transform invocation. QW labels describe the isolated
// configuration surface available today; they are not claims of provider quality.
function options(v,sweep){
  const all=v==='B-all'; const on=n=>all||v===`B${String(n).padStart(2,'0')}`;
  if(v==='A0') return {compress:false,emitRecoverable:true};
  const o={compress:true,minCompressChars:1,charsPerToken:1,emitRecoverable:true};
  if(v==='A1') return {...o,compressTools:false,collapseHistory:false,compressToolResults:false,reflow:false};
  if(on(2)) o.charsPerToken=1;
  if(on(3)) o.compressTools=true;
  if(on(4)) o.keepSharp=b=>/019c6e27|9e43f1b3|DO NOT/.test(b.text);
  if(on(5)) o.compressToolResults=true;
  if(on(6)){o.collapseHistory=true;o.gptHistory={minCollapseChars:sweep??1350};}
  if(on(7)) o.cacheTtl1h=true;
  if(on(8)) o.reflow=true;
  if(on(9)) o.cols=384;
  if(on(10)) o.cols=1920;
  return o;
}
function toolSchema(client,b){const t=b.tools?.[0]; return client==='codex'?t?.parameters:t?.input_schema}
function contract(s){return !!(s&&s.type==='object'&&s.required?.join('|')==='id|mode|payload'&&s.properties?.id?.const===corpus.expected.uuid&&s.properties?.mode?.enum?.join('|')==='inspect|verify'&&s.properties?.payload?.oneOf?.length===2)}
function evidenceText(body,info){return JSON.stringify(body)+'\n'+(info.recoverable??[]).map(x=>x.text).join('\n')}
async function run(client,variant,repetition,sweep){
  const source=client==='codex'?openai():anthropic(); const bytes=new TextEncoder().encode(JSON.stringify(source));
  const started=performance.now(); let result;
  if(client==='codex') result=await transformOpenAIResponses(bytes,options(variant,sweep));
  else result=await transformAnthropicMessages({body:bytes,model:'claude-fable-5',options:options(variant,sweep)});
  const body=JSON.parse(new TextDecoder().decode(result.body)); const info=result.info; const ev=evidenceText(body,info);
  const schema=toolSchema(client,body); const dims=info.imageDims??[];
  const identifiers=Object.fromEntries(corpus.identifiers.map(x=>[x,ev.includes(x)]));
  return {client,variant,repetition,sweep_min_collapse_chars:sweep??null,status:'EXECUTED_OFFLINE',applied:result.applied??!!info.compressed,reason:result.reason??info.reason??null,duration_ms:+(performance.now()-started).toFixed(3),source_bytes:bytes.length,output_bytes:result.body.length,source_text_tokens_gpt_tokenizer:encode(JSON.stringify(source)).length,output_text_tokens_gpt_tokenizer:encode(JSON.stringify(body)).length,baseline_imaged_tokens:info.baselineImagedTokens??0,image_count:info.imageCount??0,image_bytes:info.imageBytes??0,image_pixels:info.imagePixels??dims.reduce((n,d)=>n+d.width*d.height,0),image_dimensions:dims,schema_sha256:sha(schema),schema_contract_valid:contract(schema),exact_identifiers:identifiers,exact_identifiers_preserved:Object.values(identifiers).every(Boolean),critical_negation_preserved:ev.includes(corpus.expected.negation),tool_call_fixture_valid:contract(schema)&&corpus.expected.tool_call.name===corpus.tool.name,side_effects:false,provider_native_input_tokens:'not observable (offline transform)',cache_read_tokens:'not observable (offline transform)',cache_write_tokens:'not observable (offline transform)',provider_cost_usd:'not observable (offline transform)'};
}
const rows=[];
for(const client of ['codex','claude']) for(const variant of variants) for(let repetition=1;repetition<=3;repetition++) rows.push(await run(client,variant,repetition));
// Required QW06 threshold sweep, measured relative to the B02 configuration.
for(const client of ['codex','claude']) for(const threshold of [1200,1350,1500]) for(let repetition=1;repetition<=3;repetition++) rows.push(await run(client,'B06',repetition,threshold));
fs.writeFileSync(path.join(out,'repetitions.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
const summarize=(name,filter)=>{const r=rows.filter(filter);const avg=k=>r.reduce((n,x)=>n+(Number(x[k])||0),0)/r.length;return {name,status:r.length&&r.every(x=>x.status==='EXECUTED_OFFLINE')?'EXECUTED_OFFLINE':'FAIL',runs:r.length,all_schema_contracts_valid:r.every(x=>x.schema_contract_valid),all_exact_identifiers_preserved:r.every(x=>x.exact_identifiers_preserved),all_negations_preserved:r.every(x=>x.critical_negation_preserved),all_tool_call_fixtures_valid:r.every(x=>x.tool_call_fixture_valid),side_effects:r.some(x=>x.side_effects),averages:{source_text_tokens_gpt_tokenizer:avg('source_text_tokens_gpt_tokenizer'),output_text_tokens_gpt_tokenizer:avg('output_text_tokens_gpt_tokenizer'),image_count:avg('image_count'),image_bytes:avg('image_bytes'),image_pixels:avg('image_pixels')},provider_fields:'not observable: hermetic runner does not contact providers'};};
fs.writeFileSync(path.join(out,'baseline.json'),JSON.stringify(summarize('baseline',x=>x.variant==='A0'),null,2)+'\n');
for(let i=1;i<=10;i++){const q=`qw${String(i).padStart(2,'0')}`;fs.writeFileSync(path.join(out,q+'.json'),JSON.stringify(summarize(q,x=>x.variant===`B${String(i).padStart(2,'0')}`),null,2)+'\n')}
fs.writeFileSync(path.join(out,'combined.json'),JSON.stringify(summarize('combined',x=>x.variant==='B-all'),null,2)+'\n');
const manifest={generated_at:new Date().toISOString(),experiment_kind:'hermetic real public-transform A/B (no provider calls)',base_sha:'9e43f1b3e31442a93acc504bd7ab466bc83f7860',corpus_version:corpus.version,corpus_sha256:sha(corpus),native_source_schema_sha256:sha(corpus.tool.parameters),clients:{codex:cmd('codex',['--version']),claude:cmd('claude',['--version'])},runtime:{node:process.version,platform:process.platform,arch:process.arch},variants,repetitions_per_variant:3,qw06_sweep:[1200,1350,1500],row_count:rows.length};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({rows:rows.length,failed_contracts:rows.filter(x=>!x.schema_contract_valid).length,failed_identifiers:rows.filter(x=>!x.exact_identifiers_preserved).length,failed_negations:rows.filter(x=>!x.critical_negation_preserved).length,out},null,2));
