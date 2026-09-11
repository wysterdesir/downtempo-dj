import {planBeatTransition,sourcePosition} from './beat-grid.js';
const clamp=(value,min=0,max=1)=>Math.min(max,Math.max(min,value));
const average=values=>values.reduce((a,b)=>a+b,0)/Math.max(1,values.length);
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)]||0;

// Structural novelty uses differences between sustained regions, not a beat counter
// anchored arbitrarily at the first sample. This assumes steady 4/4 house music.
export function inferPhraseGrid(profile,period){
  if(profile.length<100)return null;
  const distance=(a,b)=>Math.sqrt(a.reduce((sum,v,k)=>sum+(v-b[k])**2,0)/a.length);
  const mean=(from,to)=>[0,1,2].map(k=>average(profile.slice(from,to).map(frame=>frame.features[k])));
  const novelty=profile.map((_,i)=>i<8||i>profile.length-9?0:Math.min(distance(mean(i-4,i),mean(i,i+4)),distance(mean(i-8,i),mean(i,i+8))));
  const peak=Math.max(...novelty);if(peak<.22)return null;
  const events=[];
  for(let i=8;i<profile.length-8;i++)if(novelty[i]>.22&&novelty[i]>peak*.28&&novelty[i]>=Math.max(...novelty.slice(i-3,i))&&novelty[i]>Math.max(...novelty.slice(i+1,i+4)))events.push({index:i,strength:novelty[i]});
  if(events.length<3)return null;
  const total=events.reduce((sum,e)=>sum+e.strength,0),fits=[];
  for(const beats of [32,64,128])for(let phase=0;phase<beats;phase++){
    const matched=events.filter(e=>e.index%beats===phase);if(matched.length<3)continue;
    const coverage=matched.length/(1+(matched.at(-1).index-matched[0].index)/beats);
    const captured=matched.reduce((sum,e)=>sum+e.strength,0)/total;
    const confidence=coverage*captured;if(coverage<.72||captured<.7||confidence<.7)continue;
    fits.push({beats,phase,confidence,matched});
  }
  fits.sort((a,b)=>b.confidence-a.confidence||a.beats-b.beats);
  const best=fits[0];if(!best||fits[1]?.confidence>best.confidence*.85)return null;
  const boundaries=[];
  for(let i=best.phase;i<profile.length;i+=best.beats)boundaries.push({time:profile[i].time,observed:best.matched.some(e=>e.index===i)});
  return {confidence:best.confidence,beatsPerPhrase:best.beats,bars:best.beats/4,period,offset:profile[best.phase].time,boundaries,profile:profile.map(({time,busy})=>({time,busy})),evidence:best.matched.length};
}

export function analyzePhrases(samples,sampleRate,grids,start,end){
  const intro=grids.intro,outro=grids.outro;if(!intro||!outro)return null;
  // Reject global structure fitting when the local beat grids disagree or drift.
  for(const time of [outro.from,outro.to]){
    const beat=outro.offset+Math.round((time-outro.offset)/outro.period)*outro.period;
    if(Math.abs((beat-intro.offset)/intro.period-Math.round((beat-intro.offset)/intro.period))*intro.period>.04)return null;
  }
  const first=intro.offset+Math.ceil((start-intro.offset)/intro.period-1e-5)*intro.period,period=intro.period;
  const count=Math.floor((end-first)/period);if(count<100)return null;
  const raw=Array.from({length:count},(_,i)=>({time:first+i*period,energy:[0,0,0],count:0}));
  const lowAlpha=1-Math.exp(-2*Math.PI*180/sampleRate),midAlpha=1-Math.exp(-2*Math.PI*1800/sampleRate);
  let low=0,mid=0;
  for(let i=Math.max(0,Math.floor(first*sampleRate));i<Math.min(samples.length,Math.floor((first+count*period)*sampleRate));i++){
    const value=samples[i];low+=lowAlpha*(value-low);mid+=midAlpha*(value-mid);
    const frame=raw[Math.floor((i/sampleRate-first)/period)];if(!frame)continue;
    frame.energy[0]+=low*low;frame.energy[1]+=(mid-low)**2;frame.energy[2]+=(value-mid)**2;frame.count++;
  }
  const rms=raw.map(frame=>frame.energy.map(e=>Math.sqrt(e/Math.max(1,frame.count))));
  const scales=[0,1,2].map(k=>Math.max(.005,percentile(rms.map(e=>e[k]),.9)));
  const profile=raw.map((frame,i)=>({time:frame.time,features:rms[i].map((v,k)=>Math.log1p(3*v/scales[k])),busy:clamp(.6*rms[i][1]/scales[1]+.4*rms[i][2]/scales[2])}));
  return inferPhraseGrid(profile,period);
}

const nearestBeat=(grid,time)=>grid.offset+Math.round((time-grid.offset)/grid.period)*grid.period;
const activity=(phrases,time)=>{
  const index=Math.round((time-phrases.profile[0].time)/phrases.period);
  return phrases.profile[Math.max(0,Math.min(phrases.profile.length-1,index))]?.busy??1;
};

export function effectivePhrases(analysis){
  const cue=analysis.phraseCue,grid=analysis.grids?.intro||analysis.grids?.outro;
  if(!cue||!grid||![8,16,32].includes(cue.bars)||!Number.isFinite(cue.anchor)||cue.anchor<0||cue.anchor>analysis.duration)return analysis.phrases;
  const period=grid.period,length=cue.bars*4*period,start=analysis.start??0,end=analysis.end??analysis.duration,boundaries=[];
  for(let time=cue.anchor+Math.ceil((start-cue.anchor)/length-1e-8)*length;time<=end;time+=length)boundaries.push({time,observed:false});
  const profile=analysis.phrases?.profile||Array.from({length:Math.ceil((end-start)/period)+1},(_,i)=>({time:start+i*period,busy:.5}));
  return {confidence:1,period,offset:cue.anchor,bars:cue.bars,beatsPerPhrase:cue.bars*4,boundaries,profile,manual:true};
}

export function planMusicalTransition(outgoing,incoming,bounds,now,requested,{enabled=true,phraseSync=true}={}){
  const fallback=(reason,short=false)=>({...planBeatTransition(outgoing,incoming,bounds,now,short?Math.min(requested,8):requested,{enabled}),phraseMatched:false,phraseReason:reason});
  if(!phraseSync||!enabled)return fallback(!phraseSync?'Phrase matching off':'Beat sync off');
  const a=effectivePhrases(outgoing.analysis),b=effectivePhrases(incoming),ga=outgoing.analysis.grids?.outro,gb=incoming.grids?.intro;
  if(!a||!b||a.confidence<.7||b.confidence<.7)return fallback('Phrase structure uncertain');
  if(!ga||!gb||ga.confidence<.65||gb.confidence<.65)return fallback('Beat grid uncertain');
  const oldRate=outgoing.rate??1,rate=gb.period*oldRate/ga.period,period=ga.period/oldRate;
  if(rate<.94||rate>1.06)return fallback('Tempo difference exceeds 6%');
  const endPosition=sourcePosition(outgoing,outgoing.end),plans=[];let busyRejected=false;
  for(const inBoundary of b.boundaries){
    const inBeat=nearestBeat(gb,inBoundary.time);
    if(Math.abs(inBeat-inBoundary.time)>.04||inBeat<Math.max(bounds.start,gb.from)-.025||inBeat-bounds.start>24)continue;
    const offset=Math.max(bounds.start,inBeat-.03),preRoll=(inBeat-offset)/rate;
    for(const outBoundary of a.boundaries){
      const outBeat=nearestBeat(ga,outBoundary.time);
      if(Math.abs(outBeat-outBoundary.time)>.04||outBeat<ga.from-.025)continue;
      const beatTime=outgoing.start+(outBeat-outgoing.offset)/oldRate,start=beatTime-preRoll;
      if(start<now+.05||start<outgoing.start+(outgoing.fadeIn||0)+.02)continue;
      for(const beats of [128,64,32]){
        if(beats%a.beatsPerPhrase!==0||beats%b.beatsPerPhrase!==0)continue;
        const duration=beats*period,stop=beatTime+duration,outEnd=outBeat+beats*ga.period,inEnd=inBeat+beats*gb.period;
        if(duration>requested+.001||duration>(outgoing.end-outgoing.start)*.4||duration>(bounds.end-offset)/rate*.4)continue;
        if(stop>outgoing.end||outEnd>ga.to+.02||inEnd>Math.min(bounds.end,gb.to)+.02)continue;
        const tail=endPosition-outEnd;
        if(tail>Math.min(32*ga.period,(endPosition-outgoing.offset)*.18))continue;
        let conflict=0,busyBeats=0;
        for(let beat=0;beat<beats;beat++){
          const x=activity(a,outBeat+beat*ga.period),y=activity(b,inBeat+beat*gb.period);
          conflict+=Math.min(x,y);if(x>.72&&y>.72)busyBeats++;
        }
        if(busyBeats/beats>.5){busyRejected=true;continue;}
        const score=2*tail/(32*ga.period)+conflict/beats+.5*(inBeat-bounds.start)/24+.25*(requested-duration)/Math.max(1,requested);
        plans.push({synced:true,phraseMatched:true,phraseManual:!!(a.manual||b.manual),phraseReason:'Phrase boundaries aligned',reason:'Phrase matched',rate,offset,start,duration:duration+preRoll,stop,beatTime,beats,bars:beats/4,bpm:60/period,period,score});
      }
    }
  }
  plans.sort((x,y)=>x.score-y.score);
  return plans[0]||fallback(busyRejected?'Busy sections · shorter blend':'No safe phrase overlap at this blend length',busyRejected);
}
