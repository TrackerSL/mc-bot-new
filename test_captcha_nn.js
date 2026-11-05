'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const nn=require('./captcha_nn'),M=require('./map_captcha');
let passed=0;function check(name,f){f();passed++;console.log('ok '+name);}
const mk=()=>Array.from({length:4},()=>Array(nn.ALPHABET.length+1).fill(0));
check('blank removes a slot instead of terminating the answer',()=>{
 const p=mk();p[0][0]=1;p[1][nn.ALPHABET.length]=1;p[2][1]=1;p[3][2]=1;
 assert.equal(nn.beam(p,3)[0].s,'abc');
});
check('duplicate blank alignments combine probability mass',()=>{
 const p=mk();p[0][0]=1;p[1][1]=0.5;p[1][nn.ALPHABET.length]=0.5;p[2][1]=0.5;p[2][nn.ALPHABET.length]=0.5;p[3][2]=1;
 const b=nn.beam(p,4);assert(Math.abs(b.find(c=>c.s==='abc').p-0.5)<1e-7);
 assert.equal(new Set(b.map(c=>c.s)).size,b.length);
});
const model=nn.loadModel(__dirname);
for(const file of fs.readdirSync(path.join(__dirname,'captcha-samples')).filter(f=>f.endsWith('.json'))){
 const sample=JSON.parse(fs.readFileSync(path.join(__dirname,'captcha-samples',file)));
 if(!sample.label)continue;
 const grid={cols:sample.cols,rows:sample.rows,data:Buffer.from(sample.data,'base64')};
 check('neural inference contract '+sample.label,()=>{
  const r=M.solve(grid);assert.equal(r.source,'nn');assert(r.candidates.length>0);
  assert(Number.isFinite(r.confidence));assert.equal(r.text,r.candidates[0]);
  assert(r.chars.every(c=>Number.isFinite(c.d)&&Number.isFinite(c.gap)));
  // Saved-image regression only; these include fine-tuning examples.
  assert.equal(r.text,sample.label);
 });
}
console.log(passed+' passed, 0 failed');
