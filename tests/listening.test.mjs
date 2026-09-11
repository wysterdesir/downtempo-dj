import test from 'node:test';
import assert from 'node:assert/strict';
import {ListeningTimeline,ListeningMode} from '../dist/listening.js';
import {MixEngine} from '../dist/engine.js';

const track=id=>({id,title:id,name:id+'.mp3',source:'Local file'});
const voice=(t,id,start,end,fadeIn=0)=>({id,track:t,start,end,fadeIn,fadeOut:null,deck:id==='a'?'A':'B',offset:0,rate:1,analysis:{duration:end-start}});
function session(){const engine=new MixEngine(),tracks=['Alpha','Bravo','Charlie','Delta'].map(track);engine.context={currentTime:2,state:'running'};engine.running=true;engine.order=tracks;engine.cursor=3;engine.voices=[voice(tracks[0],'a',0,100),voice(tracks[1],'b',70,170,30),voice(tracks[2],'c',140,240,30)];engine.voices[0].fadeOut={start:70,duration:30};engine.voices[1].fadeOut={start:140,duration:30};return {engine,tracks};}

test('Listening centers the audible leader and retains stable card identities through a blend',()=>{
  const {engine,tracks}=session(),timeline=new ListeningTimeline();
  let state=timeline.update(engine,tracks);assert.equal(state.center.key,'a');assert.deepEqual(state.next.map(e=>e.track.id),['Bravo','Charlie','Delta']);assert.equal(state.previous.length,0);
  engine.context.currentTime=75;state=timeline.update(engine,tracks);assert.equal(state.center.key,'a');assert.equal(state.blending,true);
  engine.context.currentTime=87;state=timeline.update(engine,tracks);assert.equal(state.center.key,'b');assert.equal(state.previous[0].key,'a');assert.equal(state.next[0].key,'c');
  assert.equal(state.cards.find(e=>e.key==='a').slot,-1);assert.equal(state.cards.find(e=>e.key==='b').slot,0);
  engine.context.currentTime=90;assert.equal(timeline.update(engine,tracks).previous.length,1);
});

test('manual crossfader changes never give a card two positions',()=>{
  const {engine,tracks}=session(),timeline=new ListeningTimeline();engine.context.currentTime=85;engine.manual=true;engine.manualPosition=0;
  timeline.update(engine,tracks);engine.manualPosition=1;timeline.update(engine,tracks);engine.manualPosition=0;
  const state=timeline.update(engine,tracks);assert.equal(state.center.key,'a');assert.equal(new Set(state.cards.map(e=>e.key)).size,state.cards.length);
});

test('seeking within the same song does not add a false history entry',()=>{
  const {engine,tracks}=session(),timeline=new ListeningTimeline();timeline.update(engine,tracks);
  engine.voices[0]={...engine.voices[0],id:'seek-a'};assert.equal(timeline.update(engine,tracks).previous.length,0);
});

test('prepared repeat occurrences stay visible and queue edits change future artwork',()=>{
  const {engine,tracks}=session(),timeline=new ListeningTimeline();
  engine.voices=[voice(tracks[0],'a',0,100),voice(tracks[0],'repeat-a',70,170,30)];engine.cursor=1;
  let state=timeline.update(engine,tracks);assert.equal(state.next[0].key,'repeat-a');assert.equal(new Set(state.cards.map(e=>e.key)).size,state.cards.length);
  engine.voices=engine.voices.slice(0,1);engine.order=[tracks[0],tracks[3],tracks[1]];engine.cursor=1;
  state=timeline.update(engine,tracks);assert.deepEqual(state.next.map(e=>e.track.id),['Delta','Bravo']);
});

test('preview and view refreshes never start, pause or reschedule audio',()=>{
  const {engine,tracks}=session(),timeline=new ListeningTimeline(),original=engine.voices.slice();
  engine.play=engine.playNext=engine.toggle=engine.seek=()=>{throw new Error('View must not control playback on its own');};
  for(let i=0;i<10;i++)timeline.update(engine,tracks);
  assert.deepEqual(engine.voices,original);assert.equal(engine.context.currentTime,2);
  const empty=new MixEngine();assert.equal(new ListeningTimeline().update(empty,[]).center,null);
  empty.order=tracks;const preview=new ListeningTimeline().update(empty,tracks);assert.equal(preview.center.track.id,'Alpha');assert.deepEqual(preview.next.map(e=>e.track.id),['Bravo','Charlie','Delta']);assert.equal(empty.context,null);
});

test('going back walks earlier history instead of toggling between two tracks',()=>{
  const {engine,tracks}=session(),timeline=new ListeningTimeline();timeline.update(engine,tracks);
  engine.context.currentTime=87;timeline.update(engine,tracks);engine.context.currentTime=160;timeline.update(engine,tracks);
  assert.deepEqual(timeline.history.map(e=>e.track.id),['Alpha','Bravo']);
  timeline.requestedPrevious=timeline.history.at(-1);engine.voices=[voice(tracks[1],'replay-b',159,259)];
  const state=timeline.update(engine,tracks);assert.equal(state.center.track.id,'Bravo');assert.equal(state.previous[0].track.id,'Alpha');
});

test('carousel controller reuses sliding covers and connects transport, volume and seek controls',async()=>{
  const originalDocument=globalThis.document,originalRAF=globalThis.requestAnimationFrame;
  class Element{
    constructor(){this.children=[];this.style={};this.dataset={};this.attributes={};this.listeners={};this.isConnected=true;this.textContent='';this.hidden=false;}
    append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.isConnected=false;}
    setAttribute(name,value){this.attributes[name]=value;}removeAttribute(name){delete this.attributes[name];}
    addEventListener(name,fn){this.listeners[name]=fn;}
    querySelectorAll(){return this.children.filter(child=>child.dataset.empty);}
  }
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},root=new Element();root.querySelector=selector=>get(selector.slice(1));
  globalThis.document={createElement:()=>new Element(),activeElement:null};globalThis.requestAnimationFrame=fn=>fn();
  try{
    const {engine,tracks}=session(),calls=[];
    const controller=new ListeningMode({root,engine,artwork:{find:()=>null},getTracks:()=>tracks,onToggle:()=>calls.push('toggle'),onSelect:async t=>calls.push(t.id),onVolume:value=>calls.push(value),onSeek:(v,position)=>calls.push([v.id,position])});
    controller.update();const a=controller.nodes.get('a'),b=controller.nodes.get('b');assert.equal(a.dataset.slot,'0');assert.equal(b.dataset.slot,'1');
    engine.context.currentTime=87;controller.update();assert.equal(controller.nodes.get('a'),a);assert.equal(controller.nodes.get('b'),b);assert.equal(a.dataset.slot,'-1');assert.equal(b.dataset.slot,'0');
    b.onclick();get('listen-volume').oninput({target:{value:'.4'}});get('listen-seek').value=500;get('listen-seek').oninput();get('listen-seek').onchange();
    await controller.select(controller.state.next[0]);assert.deepEqual(calls,['toggle',.4,['b',50],'Charlie']);
    const current=engine.context.currentTime;root.hidden=true;controller.update();assert.equal(engine.context.currentTime,current);
  }finally{globalThis.document=originalDocument;globalThis.requestAnimationFrame=originalRAF;}
});
