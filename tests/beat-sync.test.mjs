import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeBeatRegion,fitBeatGrid,planBeatTransition,sourcePosition} from '../dist/beat-grid.js';

const grid=(bpm,offset=.137,from=offset,to=119)=>({bpm,period:60/bpm,offset,from,to,confidence:.95,jitter:.003,support:80});
function kickTrack(bpm,offset,duration=120,sampleRate=8000){
  const pcm=new Float32Array(Math.ceil(duration*sampleRate)),beats=[];
  for(let time=offset;time<duration-.2;time+=60/bpm){beats.push(time);const begin=Math.round(time*sampleRate);for(let i=0;i<sampleRate*.13&&begin+i<pcm.length;i++){const t=i/sampleRate;pcm[begin+i]+=.6*Math.sin(2*Math.PI*70*t)*Math.exp(-t*40);}}
  // Offbeat high-frequency percussion should not pull the kick grid off phase.
  for(let time=offset+30/bpm;time<duration-.2;time+=60/bpm){const begin=Math.round(time*sampleRate);for(let i=0;i<sampleRate*.025&&begin+i<pcm.length;i++)pcm[begin+i]+=.18*Math.sin(2*Math.PI*2200*i/sampleRate)*Math.exp(-i/sampleRate*130);}
  return {pcm,beats,sampleRate,duration};
}
function outgoing(g,rate=1){return {start:10,offset:0,rate,end:10+120/rate,analysis:{grids:{outro:g}}};}

test('beat detection recovers fractional BPM and transient phase despite offbeat percussion',()=>{
  for(const [bpm,offset] of [[97.35,.173],[104.8,.431],[111.125,.087]]){
    const audio=kickTrack(bpm,offset),intro=analyzeBeatRegion(audio.pcm,audio.sampleRate,0,48),outro=analyzeBeatRegion(audio.pcm,audio.sampleRate,72,120);
    assert.ok(intro, 'intro grid for '+bpm);assert.ok(outro,'outro grid for '+bpm);
    for(const found of [intro,outro]){assert.ok(Math.abs(found.bpm-bpm)<.03,JSON.stringify(found));const phase=((found.offset-offset)/found.period);assert.ok(Math.abs(phase-Math.round(phase))*found.period<.012);}
  }
});
test('uneven free-time transients and silent regions are not declared synced',()=>{
  const times=Array.from({length:60},(_,i)=>({time:i*.6+.13*Math.sin(i*1.71),strength:1}));
  assert.equal(fitBeatGrid(times,0,36),null);
  assert.equal(analyzeBeatRegion(new Float32Array(8000*20),8000,0,20),null);
});
test('different source tempos align every beat throughout a 32-second overlap',()=>{
  const a=grid(103.75,.213,72,119.5),b=grid(99.5,.427,.427,47.5),voice=outgoing(a);
  const plan=planBeatTransition(voice,{grids:{intro:b}},{start:0,end:120},12,32);
  assert.equal(plan.synced,true,plan.reason);assert.ok(Math.abs(plan.rate-103.75/99.5)<1e-12);
  const firstIncoming=(plan.beatTime-plan.start)*plan.rate+plan.offset;
  for(let beat=0;beat<=plan.beats;beat++){
    const time=plan.beatTime+beat*plan.period;
    const sourceA=sourcePosition(voice,time),sourceB=plan.offset+(time-plan.start)*plan.rate;
    const phaseA=(sourceA-a.offset)/a.period,phaseB=(sourceB-firstIncoming)/b.period;
    assert.ok(Math.abs(phaseA-Math.round(phaseA))*a.period<1/48000);
    assert.ok(Math.abs(phaseB-beat)*b.period<1/48000);
  }
});
test('a previously tempo-matched outgoing deck passes its actual tempo to the next track',()=>{
  const a=grid(100,.17,70,119),b=grid(105,.34,.34,47.8),voice=outgoing(a,1.04);
  const plan=planBeatTransition(voice,{grids:{intro:b}},{start:0,end:120},12,24);
  assert.equal(plan.synced,true,plan.reason);assert.ok(Math.abs(plan.rate-104/105)<1e-12);assert.ok(Math.abs(plan.bpm-104)<1e-9);
});
test('uncertain grids, large tempo changes, late scheduling and short tracks fall back honestly',()=>{
  const a=outgoing(grid(100,.17,72,119)),bounds={start:0,end:120};
  assert.equal(planBeatTransition(a,{grids:{intro:grid(80)}},bounds,12,24).synced,false);
  assert.equal(planBeatTransition(a,{grids:{intro:{...grid(100),confidence:.3}}},bounds,12,24).synced,false);
  assert.equal(planBeatTransition(a,{grids:{intro:grid(100)}},bounds,129.9,24).synced,false);
  assert.equal(planBeatTransition(a,{grids:{intro:grid(100)}},{start:0,end:1},12,24).synced,false);
  assert.equal(planBeatTransition(a,{grids:{intro:grid(100)}},bounds,12,24,{enabled:false}).reason,'Beat sync off');
});
test('detected grids align independently generated kick recordings within 15 milliseconds',()=>{
  const first=kickTrack(103.75,.173),second=kickTrack(99.5,.427);
  const a=analyzeBeatRegion(first.pcm,8000,72,120),b=analyzeBeatRegion(second.pcm,8000,0,48);
  const voice=outgoing(a),plan=planBeatTransition(voice,{grids:{intro:b}},{start:0,end:120},12,32);
  assert.ok(plan.synced,plan.reason);
  const audibleA=first.beats.map(t=>voice.start+t).filter(t=>t>=plan.beatTime-.05&&t<=plan.stop+.01);
  const audibleB=second.beats.map(t=>plan.start+(t-plan.offset)/plan.rate);
  for(const aBeat of audibleA){const error=Math.min(...audibleB.map(t=>Math.abs(t-aBeat)));assert.ok(error<.015,'Beat error: '+error);}
});

test('play-next uses the current intro grid and waits for the next beat',()=>{
  const intro=grid(104,.17,.17,48),voice=outgoing(grid(104,.17,72,119));
  voice.analysis.grids.intro=intro;
  const plan=planBeatTransition(voice,{grids:{intro:grid(100,.32,.32,48)}},{start:0,end:120},12,4,{immediate:true});
  assert.ok(plan.synced,plan.reason);assert.ok(plan.start>12);assert.ok(plan.beatTime<12+60/104+.14);
});

test('short incoming tracks retain room for their following blend without overlapping gain curves',()=>{
  const voice=outgoing(grid(104,.17,72,119));
  const plan=planBeatTransition(voice,{grids:{intro:grid(100,.32,.32,37)}},{start:0,end:38},12,48);
  assert.ok(plan.synced,plan.reason);
  assert.ok(plan.duration<38/plan.rate*.4+.04);
  const overlapping={...voice,fadeIn:110};
  assert.equal(planBeatTransition(overlapping,{grids:{intro:grid(100)}},{start:0,end:120},12,32).synced,false);
});
