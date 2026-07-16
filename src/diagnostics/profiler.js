const NOOP_PROFILER = Object.freeze({
  enabled: false,
  begin: () => 0,
  end: () => 0,
  measure: (_name, operation) => operation(),
  record: () => {},
  clock: () => 0,
  beginFrame: () => {},
  endFrame: () => {},
  increment: () => {},
  incrementFrame: () => {},
  setGauge: () => {},
  snapshot: () => ({ enabled: false, timings: {}, gauges: {}, counters: {}, frameCounters: {} }),
});

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function createProfiler({ enabled = false, sampleLimit = 240 } = {}) {
  if (!enabled) return NOOP_PROFILER;

  const samples = new Map();
  const gauges = new Map();
  const counters = new Map();
  let frameCounters = new Map();
  let completedFrameCounters = new Map();

  function record(name, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    let values = samples.get(name);
    if (!values) {
      values = [];
      samples.set(name, values);
    }
    values.push(durationMs);
    if (values.length > sampleLimit) values.splice(0, values.length - sampleLimit);
  }

  function begin() {
    return performance.now();
  }

  function end(name, startedAt) {
    const duration = performance.now() - startedAt;
    record(name, duration);
    return duration;
  }

  function measure(name, operation) {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      record(name, performance.now() - startedAt);
    }
  }

  function increment(name, amount = 1) {
    counters.set(name, (counters.get(name) || 0) + amount);
  }

  function incrementFrame(name, amount = 1) {
    frameCounters.set(name, (frameCounters.get(name) || 0) + amount);
    increment(name, amount);
  }

  function snapshot() {
    const timings = {};
    for (const [name, values] of samples) {
      const sorted = [...values].sort((a, b) => a - b);
      timings[name] = {
        latestMs: Number((values.at(-1) || 0).toFixed(3)),
        p50Ms: Number(percentile(sorted, 0.5).toFixed(3)),
        p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
        samples: values.length,
      };
    }
    return {
      enabled: true,
      sampleLimit,
      timings,
      gauges: Object.fromEntries(gauges),
      counters: Object.fromEntries(counters),
      frameCounters: Object.fromEntries(completedFrameCounters),
    };
  }

  return {
    enabled: true,
    begin,
    end,
    measure,
    record,
    clock: () => performance.now(),
    beginFrame() { frameCounters = new Map(); },
    endFrame() { completedFrameCounters = new Map(frameCounters); },
    increment,
    incrementFrame,
    setGauge(name, value) { gauges.set(name, value); },
    snapshot,
  };
}
