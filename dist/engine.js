import {clamp,fadeCurves,transitionLength,levelGain,analyzeSamples,shuffleOrder} from './analysis.js';
import {planBeatTransition,sourcePosition} from './beat-grid.js';

export class MixEngine extends EventTarget {
  constructor(contextFactory = () => new (window.AudioContext || window.webkitAudioContext)({latencyHint:'playback'})) {
    super(); this.contextFactory = contextFactory; this.context = null;
    this.order = []; this.cursor = 0; this.voices = []; this.cache = new Map(); this.pending = new Map();
    this.generation = 0; this.running = false; this.filling = false; this.fade = 24; this.style = 'warm';
    this.automix = true; this.repeat = true; this.normalize = true; this.trimSilence = true; this.volume = .75;
    this.beatSync = true;
    this.excludedIds = new Set();
    this.trims = {A:1,B:1}; this.nextDeck = 'A'; this.curves = fadeCurves(); this.manual = false; this.manualPosition = .5;
  }
  notify(type, detail = {}) { this.dispatchEvent(new CustomEvent(type,{detail})); }
  init() {
    if (this.context) return;
    this.context = this.contextFactory();
    this.master = this.context.createGain(); this.master.gain.value = this.volume;
    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.value = -3; this.limiter.knee.value = 5; this.limiter.ratio.value = 16;
    this.limiter.attack.value = .003; this.limiter.release.value = .2;
    this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 256;
    this.master.connect(this.limiter); this.limiter.connect(this.analyser); this.analyser.connect(this.context.destination);
    this.context.addEventListener?.('statechange',()=>this.notify('change'));
  }
  get now() { return this.context?.currentTime ?? 0; }
  get paused() { return this.running && this.context?.state !== 'running'; }
  active() { return this.voices.filter(v=>v.start<=this.now+.015 && v.end>this.now); }
  current() { return this.active().at(-1) || this.voices[0] || null; }
  snapshot() {
    const now = this.now;
    return {running:this.running,paused:this.paused,manual:this.manual,voices:this.voices.map(v=>({id:v.id,track:v.track,deck:v.deck,start:v.start,end:v.end,position:clamp(sourcePosition(v,now),v.offset,sourcePosition(v,v.end)),rate:v.rate,sync:v.sync,analysis:v.analysis,active:v.start<=now && v.end>now,fadeIn:v.fadeIn,fadeOut:v.fadeOut,gain:this.voiceGain(v,now)}))};
  }
  voiceGain(v, now) {
    if (now < v.start || now >= v.end) return 0;
    let gain = 1;
    if (v.fadeIn && now < v.start+v.fadeIn) { const x=clamp((now-v.start)/v.fadeIn,0,1); gain=Math.sin(x*x*(3-2*x)*Math.PI/2); }
    if (v.fadeOut && now >= v.fadeOut.start) { const x=clamp((now-v.fadeOut.start)/v.fadeOut.duration,0,1); gain*=Math.cos(x*x*(3-2*x)*Math.PI/2); }
    return gain;
  }
  async analyze(buffer) {
    const stride = Math.max(1,Math.floor(buffer.sampleRate/11025));
    const samples = new Float32Array(Math.ceil(buffer.length/stride));
    // Max absolute channel avoids antiphase cancellation when finding silence.
    const channels = Array.from({length:buffer.numberOfChannels},(_,c)=>buffer.getChannelData(c));
    for(let i=0;i<samples.length;i++) {
      const p=i*stride; let value=0;
      for(const channel of channels) if(Math.abs(channel[p])>Math.abs(value)) value=channel[p];
      samples[i]=value;
    }
    if (typeof Worker === 'undefined') return analyzeSamples(samples,buffer.sampleRate/stride,buffer.duration);
    const worker = new Worker(new URL('./analysis-worker.js',import.meta.url),{type:'module'});
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Audio analysis timed out.'));},60000);
      worker.onmessage=({data})=>{clearTimeout(timeout);worker.terminate();data.error?reject(new Error(data.error)):resolve(data.analysis);};
      worker.onerror=()=>{clearTimeout(timeout);worker.terminate();reject(new Error('Could not analyze this audio file.'));};
      worker.postMessage({id:1,samples,sampleRate:buffer.sampleRate/stride,duration:buffer.duration},[samples.buffer]);
    });
  }
  async load(track) {
    if(this.cache.has(track.id)) return this.cache.get(track.id);
    if(this.pending.has(track.id)) return this.pending.get(track.id);
    const task=(async()=>{
      track.status='Loading'; this.notify('change');
      try {
        const buffer = track.createBuffer ? track.createBuffer(this.context) : await this.context.decodeAudioData(await track.read());
        if(buffer.duration < .25) throw new Error('The audio is too short to play.');
        const analysis = await this.analyze(buffer);
        track.analysis=analysis; track.status='Ready'; track.error=null;
        const result={buffer,analysis}; this.cache.set(track.id,result); this.notify('loaded',{track}); return result;
      } catch(error) {track.status='Unavailable';track.error=error.message;this.notify('trackerror',{track,error:error.message});throw error;}
      finally {this.pending.delete(track.id);}
    })();
    this.pending.set(track.id,task); return task;
  }
  trimCache() {
    const keep=new Set(this.voices.map(v=>v.track.id));
    for(const id of this.cache.keys()) if(!keep.has(id)) this.cache.delete(id);
  }
  bounds(data) { return this.trimSilence?{start:data.analysis.start,end:Math.min(data.buffer.duration,data.analysis.end)}:{start:0,end:data.buffer.duration}; }
  makeVoice(track,data,start,offset,deck,fadeIn=0,rate=1,sync=null) {
    const context=this.context, bounds=this.bounds(data);
    offset=clamp(offset,bounds.start,Math.max(bounds.start,bounds.end-.1));
    const source=context.createBufferSource(); source.buffer=data.buffer;
    source.playbackRate.value=rate;
    const level=context.createGain(); level.gain.value=levelGain(data.analysis,this.normalize);
    const bass=context.createBiquadFilter(); bass.type='lowshelf';bass.frequency.value=180;bass.gain.value=0;
    const trim=context.createGain();trim.gain.value=this.trims[deck];
    const gain=context.createGain();gain.gain.value=fadeIn?0:1;
    const manual=context.createGain();manual.gain.value=1;
    source.connect(level);level.connect(bass);bass.connect(trim);trim.connect(gain);gain.connect(manual);manual.connect(this.master);
    const naturalEnd=start+(bounds.end-offset)/rate;
    const voice={id:crypto.randomUUID(),track,analysis:data.analysis,buffer:data.buffer,source,level,bass,trim,gain,manual,deck,start,offset,rate,sync,naturalEnd,end:naturalEnd,fadeIn,fadeOut:null};
    if(fadeIn) {
      gain.gain.setValueAtTime(0,start);gain.gain.setValueCurveAtTime(this.curves.incoming,start,fadeIn);
      if(this.style==='warm') {bass.gain.setValueAtTime(-15,start);bass.gain.setValueAtTime(-15,start+fadeIn*.3);bass.gain.linearRampToValueAtTime(0,start+fadeIn*.75);}
    } else {gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(1,start+.015);}
    source.start(start,offset);source.stop(voice.end);
    source.onended=()=>{
      if(!this.voices.includes(voice)) return;
      this.voices=this.voices.filter(v=>v!==voice);this.disconnect(voice);this.trimCache();
      if(this.running && !this.manual) this.fill();
      if(this.running && !this.voices.length && !this.filling) {this.running=false;this.notify('ended');}
      this.notify('change');
    };
    this.voices.push(voice);return voice;
  }
  disconnect(v) { for(const node of [v.source,v.level,v.bass,v.trim,v.gain,v.manual]) {try{node.disconnect();}catch{}} }
  removeVoice(v) {v.source.onended=null;try{v.source.stop();}catch{} this.disconnect(v);this.voices=this.voices.filter(x=>x!==v);}
  stop() {
    this.generation++;this.running=false;this.manual=false;
    for(const v of [...this.voices]) this.removeVoice(v);
    this.cache.clear();this.notify('change');
  }
  async play(tracks=this.order,startIndex=0,offset=null) {
    this.init();await this.context.resume();this.stop();this.order=[...tracks];
    if(!tracks.length) throw new Error('Add some music first.');
    this.cursor=clamp(startIndex,0,tracks.length-1);this.nextDeck='A';this.running=true;
    const generation=this.generation;
    const loaded=await this.nextPlayable(generation);
    if(generation!==this.generation) return;
    if(!loaded) {this.running=false;throw new Error('None of these tracks could be played. Check their format or reconnect Drive.');}
    const b=this.bounds(loaded.data);
    this.makeVoice(loaded.track,loaded.data,this.now+.06,offset ?? b.start,'A');this.nextDeck='B';
    this.notify('change');this.fill();
  }
  async nextPlayable(generation) {
    let attempts=0;
    while(attempts<this.order.length && generation===this.generation) {
      if(this.cursor>=this.order.length) {if(!this.repeat)return null;this.cursor=0;}
      if(this.filling)this.fillNextIndex=this.cursor;
      const track=this.order[this.cursor++];attempts++;
      try {const data=await this.load(track);if(generation!==this.generation)return null;return {track,data};}
      catch { /* Bad or deleted files are skipped without fading out the current track. */ }
    }
    return null;
  }
  async fill() {
    if(this.filling || !this.running || !this.automix || this.manual)return;
    this.filling=true;const generation=this.generation;
    try {
      // Schedule on the audio clock, up to two tracks ahead. UI timers never control a fade.
      while(this.voices.length<3 && this.running && this.automix && !this.manual && generation===this.generation) {
        const tail=this.voices.at(-1);
        if(!tail) break;
        const loaded=await this.nextPlayable(generation);
        if(generation!==this.generation || !this.automix || this.manual) break;
        if(!loaded) {this.notify('queueend');break;}
        const bounds=this.bounds(loaded.data);
        const plan=planBeatTransition(tail,loaded.data.analysis,bounds,this.now,this.fade,{enabled:this.beatSync});
        const fallbackFade=this.beatSync?Math.min(this.fade,8):this.fade;
        const length=transitionLength(fallbackFade,tail.end-tail.start,bounds.end-bounds.start,tail.analysis);
        // If a slow download arrives late, shorten the blend rather than schedule in the past.
        const start=plan.synced?plan.start:Math.max(this.now+.04,tail.end-length);
        const duration=plan.synced?plan.duration:Math.max(0,tail.end-start);
        if(plan.synced){tail.end=plan.stop;tail.source.stop(tail.end);}
        const voice=this.makeVoice(loaded.track,loaded.data,start,plan.offset,this.nextDeck,duration,plan.rate,plan);
        this.nextDeck=this.nextDeck==='A'?'B':'A';
        if(duration>.02) this.fadeOut(tail,start,duration);
        else this.notify('warning',{message:'The next download was late. Playback resumes as soon as it is ready.'});
        this.notify('scheduled',{from:tail.track,to:voice.track,duration,sync:plan});
      }
    } finally {
      this.filling=false;this.fillNextIndex=null;this.trimCache();this.notify('change');
      if(generation!==this.generation && this.running && this.automix && !this.manual) queueMicrotask(()=>this.fill());
    }
  }
  fadeOut(v,start,duration) {
    v.fadeOut={start,duration};
    v.gain.gain.setValueAtTime(1,start);v.gain.gain.setValueCurveAtTime(this.curves.outgoing,start,duration);
    if(this.style==='warm') {v.bass.gain.setValueAtTime(0,start);v.bass.gain.linearRampToValueAtTime(-15,start+duration*.65);}
  }
  clearFutureFade(voice) {
    if(!voice.fadeOut || voice.fadeOut.start<=this.now)return;
    voice.gain.gain.cancelScheduledValues(voice.fadeOut.start);
    voice.bass.gain.cancelScheduledValues(voice.fadeOut.start);
    voice.fadeOut=null;voice.end=voice.naturalEnd;voice.source.stop(voice.end);
  }
  async toggle() {
    this.init();
    if(!this.running) return this.play();
    if(this.context.state==='running') await this.context.suspend();else await this.context.resume();
    this.notify('change');
  }
  setVolume(value) {this.volume=clamp(value,0,1);this.master?.gain.setTargetAtTime(this.volume,this.now,.025);}
  setTrim(deck,value) {this.trims[deck]=clamp(value,0,1.5);for(const v of this.voices)if(v.deck===deck)v.trim.gain.setTargetAtTime(this.trims[deck],this.now,.025);}
  async seek(voice,position) {
    if(!voice)return;
    const index=Math.max(0,this.order.findIndex(t=>t.id===voice.track.id));
    return this.play(this.order,index,position);
  }
  async playNext(track=null) {
    this.init();await this.context.resume();
    if(!this.running || !this.voices.length) {
      return this.play(this.order,track?Math.max(0,this.order.indexOf(track)):0);
    }
    const generation=this.generation;
    // Load before touching playback so failed requests leave the existing mix intact.
    const target=track || this.voices.find(v=>v.start>this.now)?.track || this.order[this.cursor%Math.max(1,this.order.length)];
    if(!target)return;
    let data;
    try{data=await this.load(target);}catch(error){throw error;}
    if(generation!==this.generation)return;
    this.generation++;
    const active=this.active();
    for(const v of [...this.voices])if(!active.includes(v))this.removeVoice(v);
    const bounds=this.bounds(data);
    const plan=active.length===1?planBeatTransition(active[0],data.analysis,bounds,this.now,4,{enabled:this.beatSync,immediate:true}):{synced:false,rate:1,offset:bounds.start,reason:'Blend already underway'};
    const now=plan.synced?plan.start:this.now+.04;
    const length=plan.synced?plan.duration:Math.min(4,(bounds.end-bounds.start)*.35,...active.map(v=>Math.max(.05,v.end-now)));
    for(const v of active) {
      const gain=this.voiceGain(v,this.now);
      v.gain.gain.cancelScheduledValues(0);v.gain.gain.setValueAtTime(gain,this.now);
      if(plan.synced){
        const curve=Float32Array.from(this.curves.outgoing,x=>x*gain);
        v.gain.gain.setValueCurveAtTime(curve,now,length);
      }else v.gain.gain.linearRampToValueAtTime(0,now+length);
      v.bass.gain.cancelScheduledValues(0);v.bass.gain.setTargetAtTime(0,this.now,.05);
      v.fadeOut={start:now,duration:length};v.end=now+length;v.source.stop(v.end);
    }
    const deck=active.at(-1)?.deck==='A'?'B':'A';
    this.makeVoice(target,data,now,plan.offset,deck,length,plan.rate,plan);this.nextDeck=deck==='A'?'B':'A';
    this.cursor=this.order.indexOf(target)+1;this.manual=false;this.running=true;this.notify('change');this.fill();
  }
  setAutomix(enabled) {
    this.automix=!!enabled;
    if(enabled){
      if(this.manual && this.active().length>1) {
        const active=this.active(),preferred=this.manualPosition>=.5?'B':'A';
        const winner=active.find(v=>v.deck===preferred)||active.at(-1);
        for(const v of active)if(v!==winner) {
          const gain=this.voiceGain(v,this.now);v.gain.gain.cancelScheduledValues(0);v.gain.gain.setValueAtTime(gain,this.now);v.gain.gain.linearRampToValueAtTime(0,this.now+.75);
          v.fadeOut={start:this.now,duration:.75};v.end=this.now+.75;v.source.stop(v.end);
        }
        this.voices=this.voices.filter(v=>v!==winner);this.voices.push(winner);this.nextDeck=winner.deck==='A'?'B':'A';
        this.cursor=Math.max(0,this.order.indexOf(winner.track)+1);
      }
      this.manual=false;for(const v of this.voices)v.manual.gain.setTargetAtTime(1,this.now,.15);this.fill();
    }
    else {
      // A blend already in progress completes. Only genuinely future voices are cancelled.
      const future=this.voices.filter(v=>v.start>this.now+.03);
      if(this.voices.length)this.generation++;
      if(future.length)this.cursor=Math.max(0,this.order.indexOf(future[0].track));
      else if(this.filling && this.fillNextIndex!=null)this.cursor=this.fillNextIndex;
      for(const v of future)this.removeVoice(v);
      for(const v of this.voices)if(v.fadeOut?.start>this.now) {
        this.clearFutureFade(v);
      }
    }
    this.notify('change');
  }
  reorderCollection(collection, shuffled = false, random = Math.random) {
    collection=collection.filter(t=>!this.excludedIds.has(t.id));
    // Keep audible and immediately imminent sources intact, including a live blend.
    const kept = this.voices.filter(v => v.start <= this.now + .25).sort((a,b)=>a.start-b.start);
    const pinned = [...new Set(kept.map(v=>v.track))];
    // While the first decode is pending, keep the track the listener pressed Play on.
    if (this.running && !this.voices.length && this.order[this.cursor-1]) pinned.push(this.order[this.cursor-1]);
    const pinnedIds = new Set(pinned.map(t=>t.id));
    const remaining = collection.filter(t=>!pinnedIds.has(t.id));
    const tail = shuffled ? shuffleOrder(remaining,random) : remaining;
    if (this.voices.length) {
      this.generation++;
      this.fillNextIndex=null;
      for (const voice of [...this.voices]) if (!kept.includes(voice)) this.removeVoice(voice);
      for (const voice of kept) if (voice.fadeOut && voice.fadeOut.start > this.now + .25) {
        this.clearFutureFade(voice);
      }
      if (kept.length) this.nextDeck = kept.at(-1).deck === 'A' ? 'B' : 'A';
    }
    this.order = [...pinned,...tail];
    this.cursor = pinned.length;
    this.notify('change');
    if (this.running) this.fill();
    return {pinned:pinned.length,reorderable:remaining.length};
  }
  queueState() {
    if(!this.running)return this.order.map(track=>({track,locked:false}));
    const audibleIds=new Set(this.voices.filter(v=>v.start<=this.now+.015&&v.end>this.now).map(v=>v.track.id));
    const lockedIds=new Set(this.voices.filter(v=>v.start<=this.now+.25&&v.end>this.now).map(v=>v.track.id));
    // The first requested track is protected while its initial decode is pending.
    if(!this.voices.length&&this.order[this.cursor-1])audibleIds.add(this.order[this.cursor-1].id);
    const pending=this.filling&&this.fillNextIndex!=null?[this.order[this.fillNextIndex]]:[];
    const candidates=[...this.voices.filter(v=>v.start>this.now).map(v=>v.track),...pending,...this.order.slice(this.cursor)];
    const seen=new Set(audibleIds);
    return candidates.filter(track=>{if(!track||seen.has(track.id))return false;seen.add(track.id);return true;}).map(track=>({track,locked:lockedIds.has(track.id)}));
  }
  editQueue(action,track,beforeId=null) {
    const state=this.queueState(),entry=state.find(e=>e.track.id===track.id);
    if(entry?.locked)throw new Error('That transition is starting. Edit a later track.');
    if(action!=='next'&&!entry)throw new Error('The queue changed. Choose an upcoming track again.');
    const kept=this.voices.filter(v=>v.end>this.now&&v.start<=this.now+.25).sort((a,b)=>a.start-b.start);
    const pinned=[...new Map(kept.map(v=>[v.track.id,v.track])).values()];
    if(this.running&&!this.voices.length&&this.order[this.cursor-1])pinned.push(this.order[this.cursor-1]);
    const pinnedIds=new Set(pinned.map(t=>t.id));
    if(pinnedIds.has(track.id))throw new Error('That track is already playing or about to start.');
    const future=state.filter(e=>!e.locked).map(e=>e.track),index=future.findIndex(t=>t.id===track.id);
    if(action==='remove')future.splice(index,1);
    else if(action==='next'){if(index>=0)future.splice(index,1);future.unshift(track);}
    else if(action==='up'||action==='down'){
      const target=index+(action==='up'?-1:1);if(target<0||target>=future.length)return false;
      [future[index],future[target]]=[future[target],future[index]];
    }else if(action==='move'){
      if(beforeId===track.id)return false;
      if(beforeId!==null&&!future.some(t=>t.id===beforeId))throw new Error('Drop beside an editable upcoming track.');
      future.splice(index,1);future.splice(beforeId===null?future.length:future.findIndex(t=>t.id===beforeId),0,track);
    }else throw new Error('Unknown queue action.');
    const futureIds=new Set([...state.map(e=>e.track.id),...future.map(t=>t.id)]);
    // Keep played tracks in the repeat rotation, without placing them ahead of the edited queue.
    const history=this.running?this.order.filter(t=>!futureIds.has(t.id)&&!pinnedIds.has(t.id)&&t.id!==track.id):[];
    if(action==='remove')this.excludedIds.add(track.id);else if(action==='next')this.excludedIds.delete(track.id);
    if(this.voices.length){
      this.generation++;
      this.fillNextIndex=null;
      for(const voice of [...this.voices])if(!kept.includes(voice))this.removeVoice(voice);
      for(const voice of kept)if(voice.fadeOut?.start>this.now+.25)this.clearFutureFade(voice);
      if(kept.length)this.nextDeck=kept.at(-1).deck==='A'?'B':'A';
    }
    this.order=[...history,...pinned,...future.filter(t=>!pinnedIds.has(t.id))];
    this.cursor=history.length+pinned.length;
    this.notify('change');if(this.running)this.fill();return true;
  }
  async loadManual(track,deck) {
    this.init(); await this.context.resume();
    const data=await this.load(track);
    this.setAutomix(false);this.manual=true;this.running=true;
    for(const v of [...this.voices])if(v.deck===deck)this.removeVoice(v);
    const v=this.makeVoice(track,data,this.now+.04,this.bounds(data).start,deck,.15);
    this.notify('change');return v;
  }
  setCrossfader(value) {
    if(this.automix)return;
    const x=clamp(value,0,1);this.manualPosition=x;
    for(const v of this.voices)v.manual.gain.setTargetAtTime(v.deck==='A'?Math.cos(x*Math.PI/2):Math.sin(x*Math.PI/2),this.now,.03);
  }
}
