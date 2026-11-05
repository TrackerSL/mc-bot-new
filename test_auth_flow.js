'use strict';
const assert=require('assert'),fs=require('fs'),{AuthFlow}=require('./auth_flow');
const src=fs.readFileSync(require.resolve('./server'),'utf8');
const funcs=new Function(src.slice(src.indexOf('function authPromptMode'),src.indexOf('function loadEnvFile'))+';return {prompt:authPromptMode,reply:authReplyInfo}')();
let count=0;function check(v,msg){assert.ok(v,msg);count++;}
function rig(onSend=()=>{},options={}){
 let t=0,active=true,events=[],sent=[],logs=[],flow;
 const schedule=(ms,fn)=>events.push({at:t+ms,fn});
 const sleep=async ms=>{const end=t+ms;for(;;){events.sort((a,b)=>a.at-b.at);if(!events.length||events[0].at>end)break;const e=events.shift();t=e.at;e.fn();}t=end;};
 flow=new AuthFlow({...funcs,password:'TEST_ONLY_SECRET',mode:'login',delayMs:1500,...options,now:()=>t,sleep,active:()=>active,log:x=>logs.push(x),send:cmd=>{sent.push({cmd,at:t});onSend(cmd,{flow,schedule,sent});return true;}});
 return {flow,sent,logs,schedule,deactivate:()=>{active=false;}};
}
(async()=>{
 // Reproduce the reported loop: silence after login must NOT guess registration.
 {const r=rig();const ok=await r.flow.run();check(!ok,'silent auth does not report success');check(r.sent.length===3,'silent login is limited to three credential sends');check(r.sent.every(x=>x.cmd.startsWith('/login ')),'silence never sends register');check(r.logs.every(x=>!x.includes('TEST_ONLY_SECRET')),'password never logged');}
 // Server challenge plus rejected captcha command: serialize, respect wait, retry captcha before login.
 {let limited=false;const r=rig((cmd,{flow,schedule,sent})=>{
   if(cmd.startsWith('/login')&&sent.filter(x=>x.cmd.startsWith('/login')).length===1)schedule(20,()=>flow.observe('[!] To log in, solve the captcha: /captcha aq02xc1z'));
   else if(cmd.startsWith('/captcha')&&!limited){limited=true;schedule(20,()=>flow.observe('CwR: Wait 3.7s before sending another message!'));}
   else if(cmd.startsWith('/login'))schedule(20,()=>flow.observe('Your login was successful'));
 });const ok=await r.flow.run();check(ok,'challenge/cooldown transcript reaches confirmed success');check(r.sent.map(x=>x.cmd.split(' ')[0]).join(',')==='/login,/captcha,/captcha,/login','captcha is retried before another login');check(r.sent.every((x,i)=>!i||x.at-r.sent[i-1].at>=1500),'all sends spaced at least 1.5 seconds');check(r.sent[2].at-r.sent[1].at>=4470,'server-stated 3.7s cooldown plus safety margin honored');check(!r.sent.some(x=>x.cmd.startsWith('/register')),'registered account never gets speculative register');}
 {const r=rig((cmd,{flow,schedule})=>schedule(10,()=>flow.observe('Wrong password!')));check(!await r.flow.run(),'bad password fails');check(r.sent.length===1,'bad password stops after first explicit rejection');}
 {const r=rig();r.schedule(10,r.deactivate);check(!await r.flow.run(),'ended session returns false');check(r.sent.length===0,'ended session sends no queued credentials');}
 {const r=rig();r.flow.observe('Hello DrHazelnut welcome back!');r.flow.observe('Please register to join. Register time: 180s.');check(r.flow.registered&&r.flow.mode==='login','known account cannot be flipped by a repeated register banner');}
 {let reg=false;const r=rig((cmd,{flow,schedule})=>{
   if(cmd.startsWith('/login')&&!reg)schedule(20,()=>flow.observe('You are not registered!'));
   if(cmd.startsWith('/register')){reg=true;schedule(20,()=>flow.observe('Successfully registered'));}
   if(cmd.startsWith('/login')&&reg)schedule(20,()=>flow.observe('Already logged in'));
 });check(await r.flow.run(),'explicit new-account evidence permits registration');check(r.sent.map(x=>x.cmd.split(' ')[0]).join(',')==='/login,/register,/login','registration only follows explicit not-registered response');}
 {const r=rig();const a=r.flow.run(),b=r.flow.run();check(a===b,'concurrent triggers share exactly one auth promise');await a;check(r.sent.length===3,'concurrent triggers do not duplicate login attempts');}
 {const r=rig(()=>{}, {delayMs:130000});r.flow.observe('To log in /captcha old123');check(!await r.flow.run(),'expired challenge cannot complete auth');check(r.sent.length===0,'token expiring during a queued wait is never sent');}
 {const r=rig();r.schedule(20,()=>r.flow.observe('Authentication Successful'));check(await r.flow.run(),'success arriving during delay is recognized');check(r.sent.length===0,'no credentials sent after success');}
 {let challenges=0;const r=rig((cmd,{flow,schedule})=>{if(cmd.startsWith('/captcha')){challenges++;schedule(10,()=>flow.observe('Wait 0.3s before sending another message!'));}});r.flow.observe('To log in /captcha limited1');check(!await r.flow.run(),'persistent challenge throttling fails safely');check(challenges===3,'rate-limited text challenge has bounded three-send budget');check(!r.sent.some(x=>x.cmd.startsWith('/login')),'no login while text challenge remains rate-limited');}
 console.log(`${count} passed, 0 failed (functional auth transcript tests)`);
})().catch(e=>{console.error(e);process.exitCode=1;});
