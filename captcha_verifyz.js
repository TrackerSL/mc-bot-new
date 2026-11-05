'use strict';
// Experimental, explicitly selected CaptchaVerifyZ reader. Not auto-routed.
// Templates use Java's local Arial fallback: other server fonts need validation.
const templates = require('./captcha_verifyz_templates.json');
function read(rgb) {
  if (!rgb || rgb.length !== 128*128*3) throw new Error('Expected 128x128 RGB bytes');
  const mask = new Uint8Array(128*128), cols = new Uint16Array(128);
  for(let y=40;y<75;y++) for(let x=0;x<128;x++) {
    const i=(y*128+x)*3, r=rgb[i],g=rgb[i+1],b=rgb[i+2];
    if(r>150 && g>140 && b<110 && Math.abs(r-g)<85) {mask[y*128+x]=1; cols[x]++;}
  }
  const spans=[];
  for(let x=0;x<128;) {if(!cols[x]){x++;continue;} const a=x;while(x<128&&cols[x])x++;spans.push([a,x]);}
  if(spans.length<3 || spans.length>8) return {text:'', supported:false, reason:'No plausible yellow-text run'};
  const chars=[];
  for(const [a,b] of spans) {
    let top=75,bot=40;
    for(let y=40;y<75;y++)for(let x=a;x<b;x++)if(mask[y*128+x]){top=Math.min(top,y);bot=Math.max(bot,y);}
    const w=b-a,h=bot-top+1;
    const scores=Object.entries(templates).map(([ch,t])=>{
      const tw=t[0].length,th=t.length;let mismatch=0;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
        const v=+(t[Math.min(th-1,Math.floor(y*th/h))][Math.min(tw-1,Math.floor(x*tw/w))]);
        mismatch+=v!==mask[(y+top)*128+x+a]?1:0;
      }
      return {ch,d:mismatch/(w*h)+Math.abs(w/tw-1)*0.2+Math.abs(h/th-1)*0.2};
    }).sort((a,b)=>a.d-b.d);
    chars.push({ch:scores[0].ch,d:scores[0].d,runnerUp:scores[1].ch});
  }
  const distance=chars.reduce((s,c)=>s+c.d,0)/chars.length;
  return {text:chars.map(c=>c.ch).join(''),supported:true,source:'verifyz-experimental',chars,meanDistance:distance,confident:distance<0.05};
}
module.exports={read};
