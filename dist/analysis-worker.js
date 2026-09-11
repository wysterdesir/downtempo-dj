import { analyzeSamples } from './analysis.js?v=1.5.0';
self.onmessage = ({data}) => {
  try { self.postMessage({id:data.id,analysis:analyzeSamples(data.samples,data.sampleRate,data.duration)}); }
  catch(error) { self.postMessage({id:data.id,error:error.message}); }
};
