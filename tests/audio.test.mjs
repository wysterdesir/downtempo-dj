import test from 'node:test';
import assert from 'node:assert/strict';
import {fadeCurves,transitionLength,analyzeSamples,levelGain,cleanTitle} from '../dist/analysis.js';
import {MixEngine} from '../dist/engine.js';
import {DriveLibrary,folderId} from '../dist/drive.js';

class Param {
  constructor(){this.value=1;this.events=[];}
  setValueAtTime(value,time){this.events.push({kind:'set',value,time});return this;}
  linearRampToValueAtTime(value,time){this.events.push({kind:'ramp',value,time});return this;}
  setTargetAtTime(value,time){this.events.push({kind:'target',value,time});return this;}
  setValueCurveAtTime(values,time,duration){assert.ok(time>=0);assert.ok(duration>0);assert.ok([...values].every(Number.isFinite));this.events.push({kind:'curve',values,time,duration});return this;}
  cancelScheduledValues(time){this.events=this.events.filter(e=>e.time<time);}
}
class AudioNode {constructor(){for(const p of ['gain','frequency','threshold','knee','ratio','attack','release'])this[p]=new Param();}connect(){}disconnect(){this.disconnected=true;}}
class Source extends AudioNode {start(time,offset){this.startTime=time;this.offset=offset;}stop(time=0){this.stopTime=time;}}
class Context {
  constructor(){this.currentTime=0;this.state='suspended';this.sampleRate=1000;this.destination=new AudioNode();this.sources=[];}
  createGain(){return new AudioNode();}createBiquadFilter(){return new AudioNode();}createDynamicsCompressor(){return new AudioNode();}createAnalyser(){return new AudioNode();}
  createBufferSource(){const s=new Source();this.sources.push(s);return s;}
  async resume(){this.state='running';}async suspend(){this.state='suspended';}
  advance(time){this.currentTime=time;for(const s of this.sources)if(!s.ended&&s.stopTime<=time){s.ended=true;s.onended?.();}}
}
const analysis={duration:120,start:1,end:119,peak:.6,rms:.12,bpm:100,confidence:.1,peaks:[.5]};
const track=id=>({id,title:id,name:id,source:'test',createBuffer:()=>({duration:120})});
function setup(){const context=new Context(),engine=new MixEngine(()=>context);engine.analyze=async()=>({...analysis});return {context,engine};}
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

test('crossfade preserves uncorrelated signal power and has exact endpoints',()=>{
  const {incoming,outgoing}=fadeCurves();assert.equal(incoming[0],0);assert.equal(outgoing[0],1);assert.equal(incoming.at(-1),1);assert.equal(outgoing.at(-1),0);
  for(let i=0;i<incoming.length;i++){assert.ok(Math.abs(incoming[i]**2+outgoing[i]**2-1)<1e-6);if(i){assert.ok(incoming[i]>=incoming[i-1]);assert.ok(outgoing[i]<=outgoing[i-1]);}}
});
test('rendered two-tone blend has no silent block or level dip at its midpoint',()=>{
  const rate=48000,length=4,{incoming,outgoing}=fadeCurves(rate*length),rms=[];
  for(let block=0;block<length*rate;block+=4800){let energy=0;for(let i=block;i<block+4800;i++){const a=Math.sin(2*Math.PI*220*i/rate)*.2,b=Math.sin(2*Math.PI*330*i/rate)*.2,x=a*outgoing[i]+b*incoming[i];energy+=x*x;}rms.push(Math.sqrt(energy/4800));}
  assert.ok(Math.min(...rms)>.135);assert.ok(Math.max(...rms)<.149);
});
test('short tracks leave space between their incoming and outgoing fades',()=>{assert.ok(Math.abs(transitionLength(48,5,3)-1.2)<1e-9);assert.ok(transitionLength(24,120,120,{bpm:100,confidence:.9})<=48);});
test('analysis detects silence boundaries, waveform and approximate tempo from a known pulse',()=>{
  const rate=4000,samples=new Float32Array(rate*20);
  for(let i=rate;i<19*rate;i++){const t=(i-rate)/rate,phase=t%.6;samples[i]=.4*Math.sin(2*Math.PI*120*t)*Math.exp(-phase*25);}
  const result=analyzeSamples(samples,rate,20);assert.ok(result.start>.8&&result.start<1.1);assert.ok(result.end<19.2);assert.equal(result.peaks.length,720);assert.ok(Math.abs(result.bpm-100)<=2);assert.ok(result.rms>0);
});
test('normalization is bounded and does not amplify silence',()=>{assert.equal(levelGain({rms:0,peak:0},true),1);assert.ok(levelGain({rms:.001,peak:.1},true)<=1.58);assert.ok(levelGain({rms:.2,peak:1.2},true)<=.94/1.2);});
test('engine schedules two future tracks without depending on UI timers',async()=>{
  const {engine,context}=setup();await engine.play([track('one'),track('two'),track('three')]);await settle();
  assert.equal(engine.voices.length,3);const [a,b,c]=engine.voices;assert.equal(a.deck,'A');assert.equal(b.deck,'B');assert.equal(c.deck,'A');
  assert.ok(b.start<a.end);assert.ok(c.start<b.end);assert.equal(a.end-b.start,b.fadeIn);assert.equal(b.end-c.start,c.fadeIn);
  assert.ok(a.gain.gain.events.some(e=>e.kind==='curve'));assert.equal(context.sources[1].startTime,b.start);assert.equal(context.sources[1].offset,1);
});
test('paused context retains scheduled times and resumes without seeking',async()=>{const {engine}=setup();await engine.play([track('one'),track('two')]);await settle();const starts=engine.voices.map(v=>v.start);await engine.toggle();assert.equal(engine.paused,true);await engine.toggle();assert.equal(engine.paused,false);assert.deepEqual(engine.voices.map(v=>v.start),starts);});
test('a failed download is skipped and never prematurely fades out current audio',async()=>{const {engine}=setup(),bad={id:'bad',title:'bad',name:'bad',read:async()=>{throw new Error('not found');}};await engine.play([track('one'),bad,track('three')]);await settle();assert.equal(engine.voices[1].track.id,'three');assert.equal(bad.status,'Unavailable');assert.ok(engine.voices[0].end>engine.voices[1].start);});
test('turning automix off cancels future voices and their fade-out automation',async()=>{const {engine,context}=setup();await engine.play([track('one'),track('two')]);await settle();context.currentTime=2;engine.setAutomix(false);assert.equal(engine.voices.length,1);assert.equal(engine.voices[0].fadeOut,null);assert.equal(engine.automix,false);});
test('a late async load cannot resurrect playback after stop',async()=>{const {engine}=setup();let finish;engine.load=()=>new Promise(r=>{finish=r;});const run=engine.play([track('one')]);await settle();engine.stop();finish({buffer:{duration:120},analysis});await run;assert.equal(engine.voices.length,0);assert.equal(engine.running,false);});
test('ended sources refill the queue and release old audio nodes',async()=>{const {engine,context}=setup();await engine.play([track('one'),track('two'),track('three'),track('four')]);await settle();const first=engine.voices[0];context.advance(first.end+.01);await settle();assert.equal(engine.voices.length,3);assert.equal(engine.voices.at(-1).track.id,'four');assert.equal(first.source.disconnected,true);assert.equal(engine.cache.has('one'),false);});
test('end of a non-repeating playlist stops instead of restarting',async()=>{const {engine,context}=setup();engine.repeat=false;await engine.play([track('one')]);await settle();context.advance(engine.voices[0].end+.01);await settle();assert.equal(engine.voices.length,0);assert.equal(engine.running,false);});
test('Drive listing follows pages and subfolders, escapes IDs, and downloads through authenticated API',async()=>{
  const calls=[],client=new DriveLibrary(async(url,options)=>{calls.push({url,options});const parsed=new URL(url);if(parsed.searchParams.get('alt')==='media')return {ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(4)};
    if(parsed.searchParams.get('pageToken'))return {ok:true,status:200,json:async()=>({files:[{id:'two',name:'2026-09-03_Luna.mp3',mimeType:'audio/mpeg'}]})};
    if(parsed.searchParams.get('q').includes('child_folder'))return {ok:true,status:200,json:async()=>({files:[{id:'three',name:'Third.wav',mimeType:'audio/wav'}]})};
    return {ok:true,status:200,json:async()=>({nextPageToken:'page2',files:[{id:'child_folder',name:'Nested',mimeType:'application/vnd.google-apps.folder'},{id:'one',name:'First.mp3',mimeType:'audio/mpeg'},{id:'blocked',name:'blocked.mp3',mimeType:'audio/mpeg',capabilities:{canDownload:false}}]})};
  });client.token='test-token';client.expires=Date.now()+3600000;const tracks=await client.list('abcdefghijk');assert.equal(tracks.length,3);assert.equal(tracks[1].title,'Luna');await tracks[0].read();assert.ok(calls.at(-1).url.includes('alt=media'));assert.equal(calls.at(-1).options.headers.Authorization,'Bearer test-token');assert.equal(calls.length,4);
});
test('expired Drive authorization is rejected before network access',async()=>{let calls=0;const client=new DriveLibrary(async()=>calls++);await assert.rejects(()=>client.request('files'),/expired/);assert.equal(calls,0);});
test('folder validation and track title cleanup do not accept query injection',()=>{assert.equal(folderId('https://drive.google.com/drive/u/0/folders/abcdefghijk'),'abcdefghijk');assert.throws(()=>folderId("x' or trashed=false"));assert.equal(cleanTitle('2026-09-03_Luna-de-Oaxaca.mp3'),'Luna de Oaxaca');});

test('shuffle replaces preloaded upcoming tracks while leaving the current source and clock intact',async()=>{
  const {engine,context}=setup(),library=[track('one'),track('two'),track('three')];
  await engine.play(library);await settle();context.currentTime=2;
  const current=engine.voices[0],oldNext=engine.voices[1];
  engine.reorderCollection(library,true,()=>.999);await settle();
  assert.deepEqual(engine.order.map(t=>t.id),['one','three','two']);
  assert.equal(engine.voices[0],current);assert.equal(current.source.disconnected,undefined);
  assert.equal(engine.voices[1].track.id,'three');assert.equal(oldNext.source.disconnected,true);
  assert.equal(context.currentTime,2);assert.ok(engine.voices[1].start<current.end);
  engine.reorderCollection(library,false);await settle();
  assert.deepEqual(engine.order.map(t=>t.id),['one','two','three']);assert.equal(engine.voices[0],current);
});
test('shuffle during a transition preserves both audible sources',async()=>{
  const {engine,context}=setup(),library=['one','two','three','four'].map(track);
  await engine.play(library);await settle();context.currentTime=engine.voices[1].start+1;
  const audible=engine.active(),fade=audible[0].fadeOut;
  engine.reorderCollection(library,true,()=>.999);await settle();
  assert.deepEqual(engine.voices.slice(0,2),audible);assert.equal(audible[0].fadeOut,fade);
  assert.equal(engine.voices[2].track.id,'four');
});
test('shuffle invalidates a pending old preload and fills from the newly visible order',async()=>{
  const {engine,context}=setup(),library=['one','two','three'].map(track);let resolveOld;
  const originalLoad=engine.load.bind(engine);let delayed=true;
  engine.load=async t=>{if(t.id==='two'&&delayed){delayed=false;return new Promise(resolve=>{resolveOld=resolve;});}return originalLoad(t);};
  await engine.play(library);await settle();context.currentTime=2;
  engine.reorderCollection(library,true,()=>.999);
  resolveOld({buffer:{duration:120},analysis});await settle();await settle();
  assert.deepEqual(engine.voices.map(v=>v.track.id),['one','three','two']);
});

