import test from 'node:test';
import assert from 'node:assert/strict';
import {inferPhraseGrid,analyzePhrases,planMusicalTransition,effectivePhrases} from '../dist/phrases.js';
import {analyzeSamples} from '../dist/analysis.js';
import {sourcePosition} from '../dist/beat-grid.js';

function profile(beats=32,phase=7,count=300,period=.6,offset=.137){return Array.from({length:count},(_,i)=>{
  const section=Math.floor((i-phase)/beats),level=section%2===0?.2:1;
  return {time:offset+i*period,features:[.3,level,level*.8],busy:level};
});}
const grid=(bpm=100,offset=.137)=>({offset,period:60/bpm,bpm,from:offset,to:239.5,confidence:.95});
function phrases(g,busy=.2){return {confidence:.9,beatsPerPhrase:32,period:g.period,boundaries:Array.from({length:13},(_,i)=>({time:g.offset+i*32*g.period})),profile:Array.from({length:420},(_,i)=>({time:g.offset+i*g.period,busy}))};}
function pair(){const a=grid(),b=grid(98,.231),voice={start:10,offset:0,end:250,rate:1,analysis:{grids:{outro:a},phrases:phrases(a)}};return {a,b,voice,incoming:{grids:{intro:b},phrases:phrases(b)},bounds:{start:0,end:240}};}

test('structure fitting identifies 8, 16 and 32 bar boundaries independently of file start',()=>{
  for(const beats of [32,64,128]){const found=inferPhraseGrid(profile(beats,11,beats*5+20),.6);assert.ok(found);assert.equal(found.bars,beats/4);assert.ok(Math.abs(found.offset-(.137+11*.6))<1e-8);assert.ok(found.evidence>=3);}
});
test('a steady loop, a single breakdown and irregular changes are not labeled as phrases',()=>{
  assert.equal(inferPhraseGrid(Array.from({length:240},(_,i)=>({time:i*.6,features:[.3,.2,.1],busy:.2})),.6),null);
  const single=profile(1000,80,240);assert.equal(inferPhraseGrid(single,.6),null);
  const random=Array.from({length:260},(_,i)=>({time:i*.6,features:[.3,Math.sin(i*.73),Math.cos(i*.19)],busy:.5}));assert.equal(inferPhraseGrid(random,.6),null);
});
test('phrase planning aligns real boundary phases at different tempos throughout an eight-bar blend',()=>{
  const {a,b,voice,incoming,bounds}=pair(),plan=planMusicalTransition(voice,incoming,bounds,12,24);
  assert.ok(plan.phraseMatched,JSON.stringify(plan));assert.equal(plan.bars,8);
  const outBeat=sourcePosition(voice,plan.beatTime),inBeat=plan.offset+(plan.beatTime-plan.start)*plan.rate;
  assert.ok(Math.abs((outBeat-a.offset)/(32*a.period)-Math.round((outBeat-a.offset)/(32*a.period)))<1e-8);
  assert.ok(Math.abs((inBeat-b.offset)/(32*b.period)-Math.round((inBeat-b.offset)/(32*b.period)))<1e-8);
  for(let beat=0;beat<=plan.beats;beat++){
    const time=plan.beatTime+beat*plan.period,x=sourcePosition(voice,time),y=plan.offset+(time-plan.start)*plan.rate;
    assert.ok(Math.abs((x-outBeat)/a.period-beat)<1e-8);assert.ok(Math.abs((y-inBeat)/b.period-beat)<1e-8);
  }
  assert.ok(plan.stop<=voice.end);assert.ok(plan.start>12);
});
test('busy overlapping sections get a shorter blend and uncertain structure retains ordinary beat sync',()=>{
  const {a,b,voice,incoming,bounds}=pair();voice.analysis.phrases=phrases(a,1);incoming.phrases=phrases(b,1);
  let plan=planMusicalTransition(voice,incoming,bounds,12,48);assert.equal(plan.phraseMatched,false);assert.match(plan.phraseReason,/Busy/);assert.ok(plan.duration<8.1);
  incoming.phrases=null;plan=planMusicalTransition(voice,incoming,bounds,12,24);assert.equal(plan.phraseMatched,false);assert.equal(plan.synced,true);
});
test('phrase planning refuses late, short, overlapping, unsupported or disabled transitions',()=>{
  const {voice,incoming,bounds}=pair();
  assert.equal(planMusicalTransition(voice,incoming,bounds,249.9,24).phraseMatched,false);
  assert.equal(planMusicalTransition({...voice,fadeIn:235},incoming,bounds,12,24).phraseMatched,false);
  assert.equal(planMusicalTransition(voice,incoming,{start:0,end:12},12,24).phraseMatched,false);
  assert.equal(planMusicalTransition(voice,incoming,bounds,12,24,{phraseSync:false}).phraseMatched,false);
  assert.equal(planMusicalTransition(voice,incoming,bounds,12,24,{enabled:false}).synced,false);
});
test('PCM analysis detects sustained instrumentation changes and rejects disagreeing beat grids',()=>{
  const sampleRate=4000,period=.6,offset=.137,count=256,duration=offset+count*period,samples=new Float32Array(Math.ceil(duration*sampleRate));
  for(let i=0;i<samples.length;i++){
    const t=i/sampleRate-offset;if(t<0)continue;const beat=Math.floor(t/period),phase=t%period,section=Math.floor(beat/32);
    samples[i]=.4*Math.sin(2*Math.PI*70*t)*Math.exp(-phase*40)+(section%2?.25:.025)*Math.sin(2*Math.PI*600*t);
  }
  const g={...grid(),to:duration-.6};const found=analyzePhrases(samples,sampleRate,{intro:g,outro:g},0,duration);
  assert.ok(found);assert.equal(found.bars,8);assert.ok(found.boundaries.some(b=>Math.abs(b.time-(offset+32*period))<.03));
  assert.equal(analyzePhrases(samples,sampleRate,{intro:g,outro:{...g,offset:offset+.2}},0,duration),null);
  const integrated=analyzeSamples(samples,sampleRate,duration);assert.ok(integrated.phrases);assert.equal(integrated.phrases.bars,8);
});

test('saved phrase cues override inferred phase and invalid cues use automatic analysis',()=>{
  const g=grid(),automatic=phrases(g),analysis={duration:240,start:0,end:240,grids:{intro:g,outro:g},phrases:automatic,phraseCue:{anchor:g.offset+8*g.period,bars:16}};
  const corrected=effectivePhrases(analysis);assert.equal(corrected.manual,true);assert.equal(corrected.beatsPerPhrase,64);assert.equal(corrected.boundaries[0].time,analysis.phraseCue.anchor);
  for(const cue of [{anchor:-1,bars:8},{anchor:300,bars:8},{anchor:2,bars:7},{anchor:NaN,bars:8},null])assert.equal(effectivePhrases({...analysis,phraseCue:cue}),automatic);
  const {voice,incoming,bounds}=pair();voice.analysis={...voice.analysis,duration:240,start:0,end:240,phraseCue:{anchor:g.offset,bars:8}};
  assert.equal(planMusicalTransition(voice,incoming,bounds,12,24).phraseManual,true);
});

test('longer phrase grids require whole phrases at both ends of the blend',()=>{
  for(const bars of [16,32]){
    const {a,b,voice,incoming,bounds}=pair();a.to=b.to=480;voice.end=490;bounds.end=480;
    for(const [analysis,g] of [[voice.analysis,a],[incoming,b]]){
      analysis.duration=480;analysis.start=0;analysis.end=480;analysis.phraseCue={anchor:g.offset,bars};analysis.phrases=null;
    }
    const plan=planMusicalTransition(voice,incoming,bounds,12,bars*4*.6+.1);assert.equal(plan.phraseMatched,true,JSON.stringify(plan));assert.equal(plan.bars,bars);
    assert.equal(planMusicalTransition(voice,incoming,bounds,12,24).phraseMatched,false);
  }
});
