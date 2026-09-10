export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function shuffleOrder(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  // A click should visibly change any reorderable list of at least two tracks.
  if (result.length > 1 && result.every((track, i) => track === items[i])) result.push(result.shift());
  return result;
}

// Constant-power envelopes, with a smooth velocity at both ends.
export function fadeCurves(points = 1024) {
  const incoming = new Float32Array(points), outgoing = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1), phase = x * x * (3 - 2 * x) * Math.PI / 2;
    incoming[i] = Math.sin(phase); outgoing[i] = Math.cos(phase);
  }
  incoming[0] = 0; incoming[points-1] = 1; outgoing[0] = 1; outgoing[points-1] = 0;
  return { incoming, outgoing };
}

export function analyzeSamples(samples, sampleRate, duration, bins = 720) {
  const hop = Math.max(1, Math.round(sampleRate * .02)), envelope = [], peaks = new Array(bins).fill(0);
  let sum = 0, peak = 0;
  for (let begin = 0; begin < samples.length; begin += hop) {
    let energy = 0;
    const end = Math.min(samples.length, begin + hop);
    for (let i = begin; i < end; i++) {
      const x = samples[i]; energy += x*x; peak = Math.max(peak,Math.abs(x));
      const bin = Math.min(bins-1,Math.floor(i / samples.length * bins));
      peaks[bin] = Math.max(peaks[bin],Math.abs(x));
    }
    sum += energy; envelope.push(Math.sqrt(energy / Math.max(1,end-begin)));
  }
  const threshold = Math.max(.0015, peak * .008);
  let first = envelope.findIndex(v => v > threshold);
  if (first < 0) first = 0;
  let last = envelope.length - 1;
  while (last > first && envelope[last] < threshold) last--;
  const start = Math.max(0,first * hop / sampleRate - .04);
  const end = Math.min(duration,(last+1)*hop/sampleRate + .08);
  const onset = envelope.map((v,i) => Math.max(0,v-(envelope[i-1] ?? v)));
  const scores = [];
  for (let bpm = 70; bpm <= 140; bpm += .25) {
    const lag = 60 / bpm * sampleRate / hop;
    let corr = 0, norm = 0;
    for (let i = Math.ceil(lag); i < onset.length; i++) {
      const p = i-lag, j = Math.floor(p), f = p-j;
      corr += onset[i] * ((onset[j] ?? 0)*(1-f)+(onset[j+1] ?? 0)*f);
      norm += onset[i]*onset[i];
    }
    scores.push({bpm,score:corr/Math.max(1e-12,norm)});
  }
  scores.sort((a,b) => b.score-a.score);
  const best = scores[0] ?? {bpm:0,score:0};
  const mean = scores.reduce((a,b)=>a+b.score,0)/Math.max(1,scores.length);
  const confidence = clamp((best.score-mean)*2,0,1);
  return { peaks, peak, rms:Math.sqrt(sum/Math.max(1,samples.length)),start,end:Math.max(start+.1,end),duration,bpm:confidence>.08 ? Math.round(best.bpm) : null,confidence };
}

export function transitionLength(requested, outgoingSeconds, incomingSeconds, analysis) {
  let length = Math.max(.05,Number(requested) || 24);
  if (analysis?.bpm && analysis.confidence > .28) {
    const bar = 240 / analysis.bpm;
    length = Math.max(bar,Math.round(length/bar)*bar);
  }
  return Math.max(.01, Math.min(length, outgoingSeconds*.4, incomingSeconds*.4));
}

export function levelGain(analysis, enabled) {
  if (!enabled || !analysis?.rms) return 1;
  // Bounded RMS matching, not a claim of standardized LUFS normalization.
  return Math.min(clamp(.14/analysis.rms,.63,1.58),.94/Math.max(.001,analysis.peak));
}

export function cleanTitle(name) {
  return name.replace(/\.[^.]+$/,'').replace(/^\d{4}-\d{2}-\d{2}[_\s-]*/,'').replace(/[_-]+/g,' ').trim() || name;
}
