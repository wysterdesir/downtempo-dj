// Original synthesized test signals. No recordings or third-party music are bundled.
export function demoTracks() {
  return [{title:'Soundcheck · Warm current',bpm:104,root:110},{title:'Soundcheck · Blue hour',bpm:104,root:130.813},{title:'Soundcheck · Afterglow',bpm:104,root:146.832}].map((demo,index)=>({
    id:'demo:'+index,title:demo.title,name:demo.title,source:'Synthesized soundcheck',status:'Not loaded',
    createBuffer(context) {
      const rate=context.sampleRate,duration=38,buffer=context.createBuffer(2,Math.floor(rate*duration),rate);
      let seed=100+index;
      const noise=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296*2-1;};
      for(let i=0;i<buffer.length;i++) {
        const t=i/rate,beat=t*demo.bpm/60,phase=beat%1;
        const seconds=phase*60/demo.bpm;
        const kick=.29*Math.sin(2*Math.PI*(48*seconds+9*(1-Math.exp(-seconds*35))))*Math.exp(-seconds*15);
        const hat=.033*noise()*Math.exp(-((beat*2)%1)*38);
        const pad=.038*(Math.sin(2*Math.PI*demo.root*t)+.6*Math.sin(2*Math.PI*demo.root*1.5*t)+.3*Math.sin(2*Math.PI*demo.root*2*t));
        const bass=.065*Math.sin(2*Math.PI*demo.root/2*t)*Math.exp(-phase*3);
        const edge=Math.min(1,t/.035,(duration-t)/.035);
        const sound=(kick+hat+pad+bass)*Math.max(0,edge);
        buffer.getChannelData(0)[i]=sound;
        buffer.getChannelData(1)[i]=sound*.97+.008*Math.sin(2*Math.PI*(demo.root+0.2)*t)*edge;
      }
      return buffer;
    }
  }));
}
