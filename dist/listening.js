import {showArtwork,COVER_PLACEHOLDER} from './artwork.js';
import {sourcePosition} from './beat-grid.js';

const clock=value=>{const seconds=Math.max(0,Math.floor(value||0));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');};

export class ListeningTimeline {
  constructor(){this.history=[];this.current=null;}
  update(engine,tracks){
    const active=engine.active();
    const gain=v=>engine.voiceGain(v,engine.now)*(engine.manual?(v.deck==='A'?Math.cos(engine.manualPosition*Math.PI/2):Math.sin(engine.manualPosition*Math.PI/2)):1);
    const voice=active.reduce((best,v)=>!best||gain(v)>gain(best)+.0001?v:best,null)||engine.voices[0]||null;
    if(voice){
      this.history=this.history.filter(entry=>entry.key!==voice.id);
      if(this.current&&this.current.key!==voice.id&&this.current.track.id!==voice.track.id){
        const backIndex=this.requestedPrevious?.track.id===voice.track.id?this.history.findIndex(entry=>entry.key===this.requestedPrevious.key):-1;
        if(backIndex>=0)this.history=this.history.slice(0,backIndex);
        else{this.history=this.history.filter(entry=>entry.key!==this.current.key);this.history.push(this.current);this.history=this.history.slice(-30);}
        this.requestedPrevious=null;
      }
      this.current={key:voice.id,track:voice.track};
    }
    const center=voice?this.current:this.current||((engine.order[0]||tracks[0])?{key:'idle:'+(engine.order[0]||tracks[0]).id,track:engine.order[0]||tracks[0]}:null);
    let previous=this.history.slice(-3).reverse();
    const next=[],seen=new Set();
    // Keep prepared voice IDs so the same image element slides into the center.
    for(const v of engine.voices)if(voice&&v.start>voice.start&&v.end>engine.now){next.push({key:v.id,track:v.track});seen.add(v.track.id);}
    for(const entry of engine.queueState())if(entry.track.id!==center?.track.id&&!seen.has(entry.track.id)){next.push({key:'queue:'+entry.track.id,track:entry.track});seen.add(entry.track.id);}
    const nextKeys=new Set(next.map(entry=>entry.key));previous=previous.filter(entry=>!nextKeys.has(entry.key));
    const cards=[];if(center)cards.push({...center,slot:0});
    previous.forEach((entry,i)=>cards.push({...entry,slot:-i-1}));next.slice(0,3).forEach((entry,i)=>cards.push({...entry,slot:i+1}));
    return {voice,center,previous,next:next.slice(0,3),cards,blending:active.length>1};
  }
}

export class ListeningMode {
  constructor({root,engine,artwork,getTracks,onToggle,onSelect,onSeek,onVolume}){
    Object.assign(this,{root,engine,artwork,getTracks,onToggle,onSelect,onSeek,onVolume});
    this.timeline=new ListeningTimeline();this.nodes=new Map();this.state=null;this.busy=false;this.get=id=>root.querySelector('#'+id);
    this.get('listen-play').onclick=onToggle;
    for(const id of ['listen-back','listen-previous'])this.get(id).onclick=()=>{if(Date.now()>=(this.ignoreClickUntil||0))this.step(-1);};
    for(const id of ['listen-forward','listen-next'])this.get(id).onclick=()=>{if(Date.now()>=(this.ignoreClickUntil||0))this.step(1);};
    this.get('listen-volume').oninput=event=>onVolume(Number(event.target.value));
    const seek=this.get('listen-seek');
    seek.oninput=()=>{this.seekVoice??=this.state?.voice;};
    seek.onchange=()=>{const voice=this.seekVoice||this.state?.voice;this.seekVoice=null;if(voice&&engine.voices.includes(voice))onSeek(voice,voice.analysis.duration*Number(seek.value)/1000);};
    const stage=this.get('listen-carousel');
    stage.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();this.step(event.key==='ArrowLeft'?-1:1);}});
    stage.addEventListener('pointerdown',event=>{if(event.isPrimary&&event.button===0)this.pointer={x:event.clientX,y:event.clientY};});
    stage.addEventListener('pointercancel',()=>{this.pointer=null;});
    stage.addEventListener('pointerup',event=>{if(!this.pointer)return;const x=event.clientX-this.pointer.x,y=event.clientY-this.pointer.y;this.pointer=null;if(Math.abs(x)>55&&Math.abs(x)>Math.abs(y)*1.4){this.ignoreClickUntil=Date.now()+400;event.preventDefault();this.step(x<0?1:-1);}});
  }
  async select(entry){if(!entry||this.busy)return;this.busy=true;this.timeline.requestedPrevious=this.state.previous.find(item=>item.key===entry.key)||null;try{await this.onSelect(entry.track);if(!this.engine.voices.some(v=>v.track.id===entry.track.id))this.timeline.requestedPrevious=null;}finally{this.busy=false;this.update();}}
  step(direction){this.select(direction<0?this.state?.previous[0]:this.state?.next[0]);}
  place(node,slot){
    const distance=Math.abs(slot),shift=[0,72,124,163,195][Math.min(distance,4)]*Math.sign(slot),scale=[1,.78,.59,.44,.32][Math.min(distance,4)];
    node.style.transform=`translate(-50%,-50%) translateX(${shift}%) scale(${scale})`;
    node.style.opacity=String([1,.72,.4,.2,0][Math.min(distance,4)]);node.style.zIndex=String(8-distance);node.style.filter=distance?'saturate(.65) brightness(.82)':'none';node.dataset.slot=String(slot);
  }
  update(){
    this.state=this.timeline.update(this.engine,this.getTracks());if(this.root.hidden)return;
    const {center,voice,cards,previous,next,blending}=this.state,playing=this.engine.running&&!this.engine.paused;
    const wanted=new Set(cards.map(c=>c.key)),container=this.get('listen-cards');
    if(!center&&this.nodes.size===0&&!container.children.length){
      for(const slot of [-1,0,1]){const ghost=document.createElement('div');ghost.className='carousel-card';ghost.dataset.empty='true';ghost.setAttribute('aria-hidden','true');const image=document.createElement('img');image.src=COVER_PLACEHOLDER;image.alt='';ghost.append(image);this.place(ghost,slot);container.append(ghost);}
    }
    if(center)for(const ghost of container.querySelectorAll('[data-empty]'))ghost.remove();
    for(const card of cards){
      let node=this.nodes.get(card.key);
      if(!node){node=document.createElement('button');node.className='carousel-card';const image=document.createElement('img');image.alt='';image.draggable=false;image.decoding='async';const caption=document.createElement('span');caption.className='cover-caption';caption.textContent=card.track.title;node.append(image,caption);node.onclick=()=>{if(Date.now()<(this.ignoreClickUntil||0))return;if(Number(node.dataset.slot)===0)this.onToggle();else this.select(node._entry);};node._image=image;this.nodes.set(card.key,node);container.append(node);this.place(node,card.slot===0?0:Math.sign(card.slot)*4);}
      if(node._removeTimer)node._slot=null;clearTimeout(node._removeTimer);node._removeTimer=null;node._entry=card;node.disabled=false;node.removeAttribute('aria-hidden');node.tabIndex=0;
      node.setAttribute('aria-label',(card.slot===0?'Current track: ':card.slot<0?'Play previous track: ':'Play upcoming track: ')+card.track.title);
      if(card.slot===0)node.setAttribute('aria-current','true');else node.removeAttribute('aria-current');
      const art=this.artwork.find(card.track);if(node._image._artwork!==art)showArtwork(node._image,art,this.artwork);
      // Existing keyed cards animate between slots; entering cards arrive from the edge.
      if(node._slot!==card.slot){node._slot=card.slot;requestAnimationFrame(()=>{if(node._entry?.slot===card.slot)this.place(node,card.slot);});}
    }
    for(const [key,node] of this.nodes)if(!wanted.has(key)&&!node._removeTimer){this.place(node,(Number(node.dataset.slot)<0?-1:1)*4);node.disabled=true;node.tabIndex=-1;node.setAttribute('aria-hidden','true');node._removeTimer=setTimeout(()=>{node.remove();this.nodes.delete(key);},900);}
    const art=this.artwork.find(center?.track),backdrop=this.get('listen-backdrop');if(backdrop._artwork!==art)showArtwork(backdrop,art,this.artwork);
    this.text('listen-title',center?.track.title||'Your music, front and center.');this.text('listen-source',center?.track.source||'A LITTLE SPACE TO UNWIND');
    this.text('listen-status',this.engine.paused?'SESSION PAUSED':blending?'IN THE BLEND':playing?'NOW PLAYING':center?'READY TO PLAY':'READY WHEN YOU ARE');
    this.text('listen-play',playing?'Ⅱ':'▶');this.get('listen-play').setAttribute('aria-label',playing?'Pause session':'Play session');this.get('listen-play').disabled=!this.getTracks().length&&!voice;
    for(const id of ['listen-back','listen-previous'])this.get(id).disabled=!previous.length||this.busy;
    for(const id of ['listen-forward','listen-next'])this.get(id).disabled=!next.length||this.busy;
    const position=voice?Math.max(voice.offset,Math.min(voice.analysis.duration,sourcePosition(voice,this.engine.now))):0,seek=this.get('listen-seek');seek.disabled=!voice;
    if(document.activeElement!==seek)seek.value=voice?position/voice.analysis.duration*1000:0;
    this.text('listen-time',clock(position));this.text('listen-remaining',voice?'−'+clock(Math.max(0,voice.end-this.engine.now)):'0:00');
    if(document.activeElement!==this.get('listen-volume'))this.get('listen-volume').value=this.engine.volume;
    const prepared=this.engine.voices.find(v=>v.start>this.engine.now),incoming=this.engine.active().at(-1),sync=(blending?incoming:prepared)?.sync;
    const phrase=sync?.phraseMatched?' · '+sync.bars+'-bar phrase blend':'';
    this.text('listen-transition',blending?'Blending into '+incoming.track.title+phrase:this.engine.paused?'Your place in the music is held.':!this.engine.automix?'Manual mix · switch to DJ decks for mixing controls.':prepared?'Next in '+clock(prepared.start-this.engine.now)+' · '+prepared.track.title+phrase:voice?'Let the music unfold.':center?'Press play. Settle into the flow.':'Add your music to start the flow.');
  }
  text(id,value){const element=this.get(id);if(element.textContent!==value)element.textContent=value;}
}
