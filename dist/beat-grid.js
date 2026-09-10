const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]??0;};

// Fit a constant beat grid to independently detected transient timestamps.
// Require sustained support: periodicity alone (e.g. an eighth-note hat) is insufficient.
export function fitBeatGrid(events,from,to) {
  if(events.length<12||to-from<8)return null;
  const strongest=[...events].sort((a,b)=>b.strength-a.strength).slice(0,32);
  const candidates=[];
  for(let bpm=70;bpm<=140;bpm+=.25){
    const period=60/bpm;
    for(const anchor of strongest){
      const matches=new Map();
      for(const event of events){const n=Math.round((event.time-anchor.time)/period),error=Math.abs(event.time-anchor.time-n*period);
        if(error<.045 && (!matches.has(n)||matches.get(n).strength<event.strength))matches.set(n,event);
      }
      const values=[...matches.entries()];
      if(values.length<12)continue;
      const support=values.reduce((sum,[,e])=>sum+e.strength,0);
      candidates.push({period,offset:anchor.time,values,score:support});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const best=candidates[0];if(!best)return null;
  let {period,offset,values}=best;
  for(let pass=0;pass<3;pass++){
    let weight=0,x=0,y=0,xx=0,xy=0;
    for(const [n,e] of values){const w=e.strength;weight+=w;x+=w*n;y+=w*e.time;xx+=w*n*n;xy+=w*n*e.time;}
    const determinant=weight*xx-x*x;if(determinant<=0)return null;
    period=(weight*xy-x*y)/determinant;offset=(y-period*x)/weight;
    values=values.filter(([n,e])=>Math.abs(e.time-offset-n*period)<.025);
    if(values.length<12)return null;
  }
  if(period<60/140||period>60/70)return null;
  const residuals=values.map(([n,e])=>Math.abs(e.time-offset-n*period)).sort((a,b)=>a-b);
  const first=Math.min(...values.map(([,e])=>e.time)),last=Math.max(...values.map(([,e])=>e.time));
  const coverage=values.length/Math.max(1,Math.round((last-first)/period)+1);
  const span=(last-first)/(to-from),jitter=residuals[Math.floor(residuals.length*.9)];
  const totalStrength=events.reduce((sum,e)=>sum+e.strength,0);
  const captured=values.reduce((sum,[,e])=>sum+e.strength,0)/Math.max(.000001,totalStrength);
  const confidence=clamp(coverage,0,1)*clamp(span/.8,0,1)*clamp(1-jitter/.04,0,1)*clamp(captured/.65,0,1);
  if(coverage<.72||span<.6||jitter>.02||confidence<.65)return null;
  // Anchor at an actual early grid beat; do not round BPM before scheduling.
  offset+=Math.ceil((first-offset-1e-6)/period)*period;
  return {bpm:60/period,period,offset,from:first,to:last,confidence,jitter,support:values.length};
}

export function analyzeBeatRegion(samples,sampleRate,from,to) {
  const hop=Math.max(1,Math.round(sampleRate*.005)),step=hop/sampleRate,frames=[];
  const start=Math.max(0,Math.floor(from*sampleRate)),end=Math.min(samples.length,Math.ceil(to*sampleRate));
  // Low-band attacks emphasize kick drums over offbeat hats and shakers.
  const lowAlpha=1-Math.exp(-2*Math.PI*180/sampleRate),highAlpha=1-Math.exp(-2*Math.PI*35/sampleRate);
  let low=0,high=0;
  for(let begin=start;begin<end;begin+=hop){let energy=0;
    for(let i=begin;i<Math.min(end,begin+hop);i++){const value=samples[i];low+=lowAlpha*(value-low);high+=highAlpha*(value-high);energy+=(low-high)**2;}
    frames.push(Math.sqrt(energy/hop));
  }
  const novelty=frames.map((v,i)=>Math.max(0,v-(frames[Math.max(0,i-2)]??v)));
  const maximum=Math.max(0,...novelty);if(maximum<.001)return null;
  const events=[];const radius=Math.ceil(.15/step);
  for(let i=2;i<novelty.length-2;i++){
    const value=novelty[i];if(value<maximum*.08||value<novelty[i-1]||value<=novelty[i+1])continue;
    const local=median(novelty.slice(Math.max(0,i-radius),Math.min(novelty.length,i+radius+1)));
    if(value<local*3+.0003)continue;
    // Rewind to attack onset instead of aligning delayed energy maxima.
    let onset=i;while(onset>Math.max(0,i-5)&&novelty[onset-1]>value*.15)onset--;
    const event={time:from+onset*step,strength:Math.sqrt(value/maximum)};
    const previous=events.at(-1);
    if(previous&&event.time-previous.time<.18){if(event.strength>previous.strength)events[events.length-1]=event;}
    else events.push(event);
  }
  return fitBeatGrid(events,from,to);
}

export function beatAtOrAfter(grid,time){return grid.offset+Math.ceil((time-grid.offset)/grid.period-1e-8)*grid.period;}
export function beatAtOrBefore(grid,time){return grid.offset+Math.floor((time-grid.offset)/grid.period+1e-8)*grid.period;}
export function sourcePosition(voice,time){return voice.offset+(time-voice.start)*(voice.rate??1);}

// Every beat in the overlap maps to the same audio-clock instant on both decks.
export function planBeatTransition(outgoing,incoming,bounds,now,requested,{enabled=true,immediate=false}={}) {
  const oldRate=outgoing.rate??1;
  const position=sourcePosition(outgoing,now);
  const outGrid=immediate?Object.values(outgoing.analysis?.grids||{}).find(g=>g&&position>=g.from-g.period&&position<g.to):outgoing.analysis?.grids?.outro;
  const inGrid=incoming.grids?.intro;
  const fallback=reason=>({synced:false,reason,rate:1,offset:bounds.start});
  if(!enabled)return fallback('Beat sync off');
  if(!outGrid||!inGrid||outGrid.confidence<.65||inGrid.confidence<.65)return fallback('Beat grid uncertain');
  const rate=inGrid.period*oldRate/outGrid.period;
  if(!Number.isFinite(rate)||rate<.94||rate>1.06)return fallback('Tempo difference exceeds 6%');
  const effectivePeriod=outGrid.period/oldRate;
  const incomingBeat=beatAtOrAfter(inGrid,Math.max(bounds.start,inGrid.from));
  if(incomingBeat-bounds.start>16)return fallback('Intro beat arrives too late');
  // Leave a tiny pre-roll for the physical transient; align the beat, not the trimmed buffer edge.
  const offset=Math.max(bounds.start,incomingBeat-.03),preRoll=(incomingBeat-offset)/rate;
  const outgoingLast=Math.min(sourcePosition(outgoing,outgoing.end),outGrid.to);
  const lastBeat=beatAtOrBefore(outGrid,outgoingLast);
  const end=outgoing.start+(lastBeat-outgoing.offset)/oldRate;
  const usableIncoming=Math.min(bounds.end,inGrid.to)-incomingBeat;
  const available=Math.min(requested,(end-outgoing.start)*.4,(bounds.end-offset)/rate*.4,usableIncoming/rate*.9);
  const beats=Math.floor(available/effectivePeriod/4)*4;
  if(beats<4)return fallback('Not enough steady beats');
  let beatTime=end-beats*effectivePeriod;
  if(immediate){const earliest=sourcePosition(outgoing,now+.1+preRoll);const beat=beatAtOrAfter(outGrid,Math.max(earliest,outGrid.from));beatTime=outgoing.start+(beat-outgoing.offset)/oldRate;}
  const duration=beats*effectivePeriod,start=beatTime-preRoll,stop=beatTime+duration;
  if(start<now+.05||start<outgoing.start+(outgoing.fadeIn||0)+.02||sourcePosition(outgoing,beatTime)<outGrid.from-.02||stop>outgoing.end+.001||stop>end+.001)return fallback('Outside the steady beat region');
  if(incomingBeat+duration*rate>inGrid.to+.02)return fallback('Incoming beat grid ends early');
  return {synced:true,reason:'Beat synced',rate,offset,start,duration:duration+preRoll,stop,beatTime,beats,bpm:60/effectivePeriod,period:effectivePeriod};
}
