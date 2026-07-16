export function mulberry32(seed) {
  return () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDeterministicRandom(seed) {
  const random = mulberry32(seed);
  return {
    random,
    rand(min = 0, max = 1) {
      return min + (max - min) * random();
    },
  };
}
