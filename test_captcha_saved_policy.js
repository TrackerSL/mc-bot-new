'use strict';
// A saved CAPTCHA passes only if its text AND default submission gates pass.
// These are development examples, not an independent accuracy estimate.
const fs=require('fs'),path=require('path'),assert=require('assert');
const M=require('./map_captcha'),P=require('./captcha_policy');
let count=0,failures=[];
for(const file of fs.readdirSync(path.join(__dirname,'captcha-samples')).filter(x=>x.endsWith('.json')).sort()){
 const j=JSON.parse(fs.readFileSync(path.join(__dirname,'captcha-samples',file)));
 if(!j.label)continue;
 const out=M.solve({cols:j.cols,rows:j.rows,data:Buffer.from(j.data,'base64')});
 const gate=P.assess(out,{});
 try{assert.strictEqual(out.text,j.label,`${file}: wrong text`);}catch(e){failures.push(e.message);}count++;
 try{assert.strictEqual(gate.allowed,true,`${file}: ${gate.reason}; score=${out.confidence}; minGap=${Math.min(...out.chars.map(c=>c.gap))}`);}catch(e){failures.push(e.message);}count++;
}
console.log(`${count-failures.length} passed, ${failures.length} failed (saved text + default policy)`);
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
