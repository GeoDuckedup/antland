// Pure configuration only: no DOM, renderer, Three.js objects, or runtime state.
export const SIMULATION_SEED = 0x0A17C010;
export const SIMULATION_SEED_LABEL = '0x0A17C010';
export const SOIL_TEXTURE_SEED = 0x5011;

export const WORLD_W = 34;
export const WORLD_D = 26;
export const HALF_W = WORLD_W / 2;
export const HALF_D = WORLD_D / 2;
export const NEST_POSITION = { x: -5.4, z: -1.3 };
export const RIVAL_NEST_POSITION = { x: 9.1, z: -5.7 };

export const HOME_COLONY_ID = 'amber';
export const RIVAL_COLONY_ID = 'slate';
export const SPECIES_PROFILE = 'harvester-ant reference population';

export const FIXED_DT = 1 / 30;
export const SEASON_SECONDS = 92;
export const ECOLOGICAL_YEAR_SECONDS = SEASON_SECONDS * 4;
export const SIM_DAYS_PER_SECOND = 365 / ECOLOGICAL_YEAR_SECONDS;
export const SIM_SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

// P. barbatus workers generally turn over within an ecological year. Damage is
// gradual rather than a birthday-triggered deletion so protected interior work
// still carries a measurable longevity advantage over exterior work.
export const WORKER_SENESCENCE_DAYS = 42;
export const WORKER_SENESCENCE_RATE = 0.0022;
export const COLONY_REPRODUCTIVE_MATURITY_YEARS = 5;
export const QUEEN_LIFESPAN_MIN_YEARS = 20;
export const QUEEN_LIFESPAN_MAX_YEARS = 30;
export const QUEEN_SENESCENCE_YEARS = 3;
export const ORPHAN_TERRITORY_RELEASE_YEARS = 0.75;
export const VACANCY_REPLACEMENT_RADIUS = 3.6;

// Engine safeguards, not biological targets. Food, brood space, queen rate,
// crowding, and mortality regulate population below these values.
export const TECHNICAL_HOME_WORKER_LIMIT = 900;
export const TECHNICAL_RIVAL_WORKER_LIMIT = 900;
export const TECHNICAL_DESCENDANT_WORKER_LIMIT = 600;
export const TECHNICAL_GLOBAL_WORKER_LIMIT = 1800;
export const TECHNICAL_BROOD_LIMIT = 420;
export const UNDERGROUND_WORKER_RENDER_LIMIT = 260;

export const PHER_W = 92;
export const PHER_H = 70;
export const FORAGING_SECTOR_COUNT = 12;
export const ANT_CELL_SIZE = 1.12;
export const ANT_GRID_ROWS = Math.ceil(WORLD_D / ANT_CELL_SIZE) + 4;

export const PROP_CELLS = {
  seed: [0, 0],
  crumb: [1, 0],
  berry: [2, 0],
  leaf: [0, 1],
  beetle: [1, 1],
  moss: [2, 1],
};

export const FOOD_NUTRITION = {
  crumb: 0.72,
  seed: 1.0,
  berry: 1.28,
  beetle: 1.55,
};

export const SEASONS = [
  { name: 'spring', food: 1.18, rain: 1.35, tint: 0xdce8bd },
  { name: 'summer', food: 1.0, rain: 0.72, tint: 0xfff5dc },
  { name: 'autumn', food: 0.72, rain: 0.92, tint: 0xd9b77d },
  { name: 'winter', food: 0.36, rain: 1.12, tint: 0xbccad0 },
];

export const PLANT_PROFILES = {
  needlegrass: { label: 'needlegrass', foliage: 0x6f7f3e, dry: 0xa89051, seed: 0xd9bd68, maxCrop: 24 },
  desertForb: { label: 'desert forb', foliage: 0x748548, dry: 0x9a8150, seed: 0xd7a95e, maxCrop: 19 },
  saltbush: { label: 'saltbush', foliage: 0x788572, dry: 0x93856a, seed: 0xcbb879, maxCrop: 28 },
};
export const MAX_SEED_PLANTS = 38;

export const CONSTRUCTION_DEPENDENCIES = {
  4: [],
  5: [],
  6: [4, 5],
  7: [6],
  8: [6],
};

export const ARCHITECTURE_TYPES = {
  founding: { capacity: 10, storage: 6, scale: [0.82, 0.43, 0.7], radius: 0.18 },
  nursery: { capacity: 38, storage: 4, scale: [1.42, 0.56, 1.08], radius: 0.25 },
  granary: { capacity: 18, storage: 58, scale: [1.25, 0.48, 1.04], radius: 0.23 },
  resting: { capacity: 30, storage: 8, scale: [1.34, 0.52, 1.1], radius: 0.24 },
  ventilation: { capacity: 14, storage: 2, scale: [0.9, 0.44, 0.78], radius: 0.2 },
  shaft: { capacity: 8, storage: 1, scale: [0.72, 0.48, 0.72], radius: 0.28 },
};

export const BROOD_STAGE_SECONDS = { egg: 34, larva: 52, pupa: 44 };
export const FOUNDING_BROOD_SECONDS = { egg: 14, larva: 22, pupa: 18 };
export const GENE_KEYS = ['speed', 'size', 'diseaseResistance', 'aggression', 'foraging'];
export const HOME_QUEEN_GENOME = {
  speed: 1.02,
  size: 0.98,
  diseaseResistance: 1.1,
  aggression: 0.9,
  foraging: 1.0,
};
export const RIVAL_QUEEN_GENOME = {
  speed: 0.96,
  size: 1.05,
  diseaseResistance: 0.9,
  aggression: 1.18,
  foraging: 1.12,
};
