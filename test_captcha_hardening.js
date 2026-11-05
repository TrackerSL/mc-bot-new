'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const nn=require('./captcha_nn'),{assess}=require('./captcha_policy');let passed=0;
function test(name,fn){fn();passed++;console.log('ok '+name);}
const good={source:'nn',text:'abc',confidence:0.8,chars:Array.from({length:3},()=>({d:0.1,gap:0.5}))};
test('uppercase O rejected',()=>assert(!assess({...good,text:'OOu'}).allowed));
test('untrained uppercase characters rejected',()=>assert(!assess({...good,text:'AAu'}).allowed));
test('normal read allowed',()=>assert(assess(good).allowed));
test('low score held',()=>assert(!assess({...good,confidence:0.2}).allowed));
test('ambiguous slot held',()=>assert(!assess({...good,chars:[{d:0.1,gap:0.01},...good.chars.slice(1)]}).allowed));
test('uncertain override explicit',()=>assert(assess({...good,confidence:0.2},{CAPTCHA_ALLOW_UNCERTAIN:'on'}).allowed));
test('NaN cannot override',()=>assert(!assess({...good,confidence:NaN},{CAPTCHA_ALLOW_UNCERTAIN:'on'}).allowed));
test('fallback not auto submitted',()=>assert(!assess({...good,source:'template'}).allowed));
test('invalid threshold fails closed',()=>assert.throws(()=>assess(good,{CAPTCHA_MIN_GAP:'bad'})));
test('unsupported length rejected',()=>assert(!assess({...good,text:'abcde'}).allowed));
test('missing diagnostics rejected',()=>assert(!assess({...good,chars:[]}).allowed));
test('wrong RGB length rejected',()=>assert.throws(()=>nn.read({},new Uint8Array(12)),/128x128/));
test('wrong RGB type rejected',()=>assert.throws(()=>nn.read({},Array(49152).fill(0)),/128x128/));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'captcha-model-'));
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'captcha_nn_weights.json'))),raw=fs.readFileSync(path.join(__dirname,'captcha_nn_weights.bin'));
function write(m,b){fs.writeFileSync(path.join(dir,'captcha_nn_weights.json'),JSON.stringify(m));fs.writeFileSync(path.join(dir,'captcha_nn_weights.bin'),b);}
try {
 test('truncated weights rejected',()=>{write(manifest,raw.subarray(0,raw.length-4));assert.throws(()=>nn.loadModel(dir),/size/);});
 test('incompatible alphabet rejected',()=>{write({...manifest,alphabet:'bad'},raw);assert.throws(()=>nn.loadModel(dir),/manifest/);});
 test('overlapping tensors rejected',()=>{const m=JSON.parse(JSON.stringify(manifest));m.tensors.c2w.offset=0;write(m,raw);assert.throws(()=>nn.loadModel(dir),/tensor/);});
 test('non-finite weights rejected',()=>{const b=Buffer.from(raw);b.writeFloatLE(NaN,0);write(manifest,b);assert.throws(()=>nn.loadModel(dir),/Non-finite/);});
 test('model path traversal rejected',()=>{write({...manifest,file:'../bad.bin'},raw);assert.throws(()=>nn.loadModel(dir),/filename/);});
 test('valid model loads',()=>{write(manifest,raw);assert.equal(nn.loadModel(dir).tensors.fc2b.length,148);});
} finally {fs.rmSync(dir,{recursive:true,force:true});}
console.log(passed+' passed, 0 failed');
