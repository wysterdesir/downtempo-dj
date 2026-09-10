import { analyzeSamples } from './analysis.js';
self.onmessage = ({data}) => {
  try { self.postMessage({id:data.id,analysis:analyzeSamples(data.samples,data.sampleRate,data.duration)}); }
  catch(error) { self.postMessage({id:data.id,error:error.message}); }
};
