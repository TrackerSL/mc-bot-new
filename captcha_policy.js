'use strict';
// Conservative submission policy; scores are model outputs, NOT calibrated accuracy.
function assess(result, env = {}) {
  const deny = reason => ({allowed:false, reason});
  if (!result || !/^[a-z0-9]{3,4}$/.test(result.text || '')) return deny('invalid or unsupported answer');
  if (result.source !== 'nn') return deny('unvalidated fallback reader');
  if (!Number.isFinite(result.confidence) || result.confidence<0 || result.confidence>1) return deny('invalid model score');
  if (!Array.isArray(result.chars) || result.chars.length!==result.text.length ||
      result.chars.some(c=>!Number.isFinite(c.d)||!Number.isFinite(c.gap))) return deny('invalid character diagnostics');
  function threshold(key, fallback) {
    if (env[key]===undefined || env[key]==='') return fallback;
    const n=Number(env[key]);
    if(!Number.isFinite(n)||n<0||n>1) throw new Error(key+' must be between 0 and 1');
    return n;
  }
  const minScore=threshold('CAPTCHA_MIN_CONFIDENCE',0.5);
  const minGap=threshold('CAPTCHA_MIN_GAP',0.15);
  const uncertain=result.confidence<minScore || result.chars.some(c=>c.gap<minGap);
  if(uncertain && !/^(on|true|yes|1)$/i.test(env.CAPTCHA_ALLOW_UNCERTAIN||'')) return deny('uncertain read; manual confirmation required');
  return {allowed:true,reason:uncertain?'explicit uncertain-read override':'passed score and gap checks'};
}
module.exports={assess};
