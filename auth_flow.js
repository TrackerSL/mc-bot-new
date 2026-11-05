'use strict';
// One session-scoped actor owns /login, /register and the server's text challenge.
// No credentials or challenge tokens are logged. Silence never implies registration.
class AuthFlow {
  constructor(o) {
    this.o=o;this.now=o.now||Date.now;this.sleep=o.sleep;
    this.interval=Math.max(1500,o.delayMs||0);this.nextAt=0;this.blockedUntil=0;
    this.mode=o.mode||'login';this.registered=o.mode==='login';
    this.challenge=null;this.rateEpoch=0;this.done=false;this.failure=null;
    this.running=null;this.challengeTries=new Map();
  }
  observe(text) {
    const prompt=this.o.prompt(text),info=this.o.reply(text);
    if(prompt==='login'){this.mode='login';this.registered=true;}
    if(prompt==='register'&&!this.registered)this.mode='register';
    if(info&&info.kind==='already'){this.mode='login';this.registered=true;}
    if(info&&info.kind==='ok'&&/successfully registered/i.test(text)){this.mode='login';this.registered=true;}
    if(info&&info.kind==='notreg'){this.mode='register';this.registered=false;}
    if(info&&['badpass','rule'].includes(info.kind))this.failure=info.kind;
    if(/login was successful|authentication successful|already logged in|welcome back .* to /i.test(text))this.done=true;
    const cap=text.match(/\/captcha\s+([A-Za-z0-9]{2,16})/i);
    if(cap)this.challenge={token:cap[1],expires:this.now()+120000};
    const wait=text.match(/wait\s+(\d+(?:\.\d+)?)\s*(?:s\b|seconds?\b|secs?\b).*before sending/i);
    if(wait){this.blockedUntil=Math.max(this.blockedUntil,this.now()+Number(wait[1])*1000+750);this.rateEpoch++;}
  }
  alive(){return this.o.active()&&!this.done&&!this.failure;}
  async send(kind,command,feedbackMs,expires=Infinity) {
    while(this.alive()) {
      const delay=Math.max(this.nextAt,this.blockedUntil)-this.now();
      if(delay>0){await this.sleep(delay);continue;}
      if(this.now()>=expires)return 'expired';
      // A challenge received while waiting takes precedence over any credential command.
      if(kind!=='captcha'&&this.challenge)return 'challenge';
      if(kind==='captcha'&&this.challenge)return 'challenge'; // newer token supersedes queued token
      const epoch=this.rateEpoch;
      this.nextAt=this.now()+this.interval;
      if(this.o.send(command)===false)return 'inactive';
      this.o.log('auth: sent /'+kind+' (credentials/challenge redacted)');
      await this.sleep(feedbackMs);
      return this.rateEpoch!==epoch?'limited':'sent';
    }
    return 'inactive';
  }
  async flushChallenge() {
    while(this.alive()&&this.challenge) {
      const c=this.challenge;this.challenge=null;
      if(c.expires<=this.now()){this.o.log('auth: text challenge expired — waiting for a fresh server prompt');return false;}
      const tries=this.challengeTries.get(c.token)||0;
      if(tries>=3){this.failure='challenge rate-limit retry budget exhausted';return false;}
      this.challengeTries.set(c.token,tries+1);
      const status=await this.send('captcha','/captcha '+c.token,1500,c.expires);
      if(status==='expired'){this.failure='text challenge expired';return false;}
      if(status==='inactive')return false;
      if(status==='limited'&&!this.challenge)this.challenge=c;
      // If a newer challenge arrived during the wait, it remains queued and takes priority.
    }
    return !this.failure;
  }
  run(){if(this.running)return this.running;this.running=this.execute().finally(()=>{this.running=null;});return this.running;}
  async execute() {
    this.nextAt=Math.max(this.nextAt,this.now()+this.interval);
    const counts={login:0,register:0};
    for(let attempt=1;attempt<=3&&this.alive();attempt++) {
      // A new challenge or explicit mode correction may require another command,
      // but never an unbounded recursive login/register fallback.
      for(let phase=0;phase<4&&this.alive();phase++) {
        if(!await this.flushChallenge())break;
        if(!this.alive())break;
        const mode=this.registered?'login':this.mode;
        if(counts[mode]>=3){this.failure='credential retry budget exhausted';break;}
        const command=mode==='register'?`/register ${this.o.password} ${this.o.password}`:`/login ${this.o.password}`;
        const status=await this.send(mode,command,4000);
        if(status==='sent'||status==='limited')counts[mode]++;
        if(status==='inactive')break;
        if(this.done)return true;
        if(this.failure)break;
        if(status==='limited'||status==='challenge'||this.challenge||mode!==(this.registered?'login':this.mode))continue;
        // Silence is only silence. Never switch login -> register without server evidence.
        break;
      }
      if(this.done)return true;
      if(!this.alive())break;
      if(attempt<3){this.o.log(`auth: no confirmation — retry ${attempt+1}/3 in 10s (no speculative registration)`);await this.sleep(10000);}
    }
    if(this.done)return true;
    if(this.failure)this.o.log('auth: stopped — '+this.failure+'; check credentials/server feedback before retrying');
    else if(this.o.active())this.o.log('auth: no confirmation after bounded retries — paused; no registration guess or forced reconnect');
    return false;
  }
}
module.exports={AuthFlow};
