"use strict";
/**
 * Stick-figure frame renderer for the video generator.
 *
 * Pre-built characters act out the script (action chosen per scene from
 * keywords in the words) while karaoke-style captions highlight the words.
 * Everything is drawn with @napi-rs/canvas (skia, prebuilt binaries — no
 * browser, no system libs) into PNG frames; ffmpeg encodes them (server.js).
 */

const fs = require("fs");
const path = require("path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

const W = 540;
const H = 960;
const FPS = 15;
const GROUND_Y = 760;
const TEXT_SIZE = 42;

// Register a caption font (DejaVu on the Linux container, Arial on Windows dev).
for (const p of [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
]) {
  try {
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, "Stick");
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Pre-built characters                                                */
/* ------------------------------------------------------------------ */

const CHARACTERS = [
  { id: "spike", name: "Spike", color: "#1f2937", accent: "#374151", accessory: "none" },
  { id: "ruby", name: "Ruby", color: "#e11d48", accent: "#be123c", accessory: "bow" },
  { id: "max", name: "Max", color: "#2563eb", accent: "#1e3a8a", accessory: "cap" },
  { id: "luna", name: "Luna", color: "#7c3aed", accent: "#6d28d9", accessory: "ponytail" },
  { id: "ace", name: "Ace", color: "#059669", accent: "#111827", accessory: "headphones" },
  { id: "bella", name: "Bella", color: "#db2777", accent: "#111827", accessory: "glasses" },
  { id: "rocky", name: "Rocky", color: "#ea580c", accent: "#7c2d12", accessory: "beanie" },
  { id: "zara", name: "Zara", color: "#0d9488", accent: "#115e59", accessory: "bun" },
  { id: "nova", name: "Nova", color: "#f97316", accent: "#c2410c", accessory: "messy" },
  { id: "kai", name: "Kai", color: "#4f46e5", accent: "#312e81", accessory: "curly" },
  { id: "mia", name: "Mia", color: "#ec4899", accent: "#9d174d", accessory: "bangs" },
  { id: "otto", name: "Otto", color: "#0ea5e9", accent: "#075985", accessory: "flat" },
];

/* ------------------------------------------------------------------ */
/* Actions: procedural poses                                           */
/*   Angles: 0 = straight down, positive = toward screen right.        */
/*   lift: positive = up off the ground.                               */
/* ------------------------------------------------------------------ */

const lerp = (a, b, u) => a + (b - a) * u;
const clamp01 = (u) => Math.max(0, Math.min(1, u));

const STAND = {
  lean: 0, rot: 0, lift: 0, head: 0,
  armL: [-0.4, -0.25], armR: [0.4, 0.25],
  legL: [-0.12, -0.05], legR: [0.12, 0.05],
  mood: "smile",
};

function mixPose(a, b, u) {
  const o = {};
  for (const k of ["lean", "rot", "lift", "head", "sx", "sy"]) {
    const dflt = k === "sx" || k === "sy" ? 1 : 0;
    o[k] = lerp(a[k] ?? dflt, b[k] ?? dflt, u);
  }
  for (const k of ["armL", "armR", "legL", "legR"]) {
    o[k] = [lerp(a[k][0], b[k][0], u), lerp(a[k][1], b[k][1], u)];
  }
  for (const k of ["mood", "prop", "fx", "holdIt", "seated", "away"]) o[k] = u > 0.5 ? b[k] : a[k];
  return o;
}

const ACTIONS = {
  walk(t) {
    const s = Math.sin(t * 5);
    const c = Math.cos(t * 5);
    // real stepping: the knee bends while its thigh swings forward (foot
    // lifts off), then straightens at heel-strike so the foot plants AHEAD
    // of the body; the stance leg stays straight and pushes off behind.
    // (the old cycle kept both shins near the thighs — feet slid like a
    // moonwalk instead of stepping)
    const kneeL = -0.9 * Math.max(0, c) * (1 - clamp01(s));
    const kneeR = -0.9 * Math.max(0, -c) * (1 - clamp01(-s));
    return {
      ...STAND,
      lean: 0.08,
      armL: [0.35 + s * 0.45, 0.3], armR: [0.35 - s * 0.45, 0.3],
      legL: [0.5 * s, kneeL], legR: [-0.5 * s, kneeR],
      lift: Math.abs(c) * 3.5 + 1, // body bobs twice per full stride
      mood: "smile",
    };
  },
  run(t) {
    const s = Math.sin(t * 8.5);
    const c = Math.cos(t * 8.5);
    const kneeL = -1.15 * Math.max(0, c) * (1 - clamp01(s));
    const kneeR = -1.15 * Math.max(0, -c) * (1 - clamp01(-s));
    return {
      ...STAND,
      lean: 0.32,
      armL: [0.5 + s * 0.85, 0.9], armR: [0.5 - s * 0.85, 0.9],
      legL: [0.75 * s, kneeL], legR: [-0.75 * s, kneeR],
      lift: Math.abs(c) * 9 + 2,
      mood: "smile",
    };
  },
  jump(t, d) {
    // The action completes quickly and holds a stand through any pause.
    const span = Math.min(1.6, Math.max(0.8, d));
    const u = clamp01(t / span);
    const crouch = { ...STAND, legL: [0.55, 0.95], legR: [-0.55, -0.95], armL: [0.75, 0.35], armR: [-0.75, -0.35], lift: -16, mood: "flat", sx: 1.1, sy: 0.84 };
    const air = { ...STAND, legL: [-0.6, -1.0], legR: [0.6, 1.0], armL: [-2.5, -0.35], armR: [2.5, 0.35], lift: 70, mood: "grin", sx: 0.9, sy: 1.14 };
    const land = { ...STAND, legL: [0.5, 0.9], legR: [-0.5, -0.9], armL: [0.5, 0.3], armR: [-0.5, -0.3], lift: -14, mood: "smile", sx: 1.08, sy: 0.86, fx: t - span * 0.78 < 0.32 ? "impact" : "" };
    if (u < 0.22) return mixPose(STAND, crouch, u / 0.22);
    if (u < 0.6) {
      const w = Math.sin(((u - 0.22) / 0.38) * Math.PI);
      const p = mixPose(crouch, air, clamp01(w * 1.4));
      p.lift = -16 + w * 90;
      return p;
    }
    if (u < 0.78) return mixPose(air, land, (u - 0.6) / 0.18);
    return mixPose(land, STAND, (u - 0.78) / 0.22);
  },
  wave(t) {
    return {
      ...STAND,
      armL: [-0.4, -0.25],
      armR: [2.35, 0.55 + Math.sin(t * 9) * 0.45],
      head: -0.05,
      mood: "smile",
    };
  },
  point() {
    return { ...STAND, armL: [-0.45, -0.3], armR: [1.55, 0.05], lean: 0.08, head: -0.08, mood: "flat" };
  },
  fall(t, d) {
    // Fall completes quickly and stays down through any pause.
    const span = Math.min(1.6, Math.max(0.8, d));
    const u = clamp01(t / span);
    const flail = Math.sin(t * 14) * 0.25;
    const air = { ...STAND, rot: 1.35, lift: -60, armL: [-2.4 + flail, -0.35], armR: [2.4 - flail, 0.35], legL: [-0.5, 0.4], legR: [0.4, 0.6], mood: "o" };
    const landed = { ...STAND, rot: 1.5, lift: -78, armL: [-1.8, -0.2], armR: [1.6, 0.2], legL: [-0.25, -0.1], legR: [0.2, 0.15], mood: "o", sx: 1.06, sy: 0.9, fx: t - span * 0.66 < 0.35 ? "impact" : "" };
    if (u < 0.66) return mixPose(STAND, air, Math.min(1, u * 1.5));
    return mixPose(air, landed, (u - 0.66) / 0.34);
  },
  celebrate(t) {
    const wig = Math.sin(t * 9) * 0.25;
    return {
      ...STAND,
      armL: [-2.35 + wig, -0.35], armR: [2.35 - wig, 0.35],
      lift: Math.abs(Math.sin(t * 4.5)) * 12,
      mood: "grin",
    };
  },
  think() {
    return { ...STAND, armL: [-0.5, -0.6], armR: [2.35, 0.9], head: 0.12, mood: "think" };
  },
  talk(t) {
    const s = Math.sin(t * 4);
    return {
      ...STAND,
      armL: [-0.55 + s * 0.2, -0.5], armR: [0.55 - s * 0.2, 0.5],
      mood: "talk",
    };
  },
  write(t) {
    return {
      ...STAND,
      lean: 0.3,
      armL: [1.0, 0.45], armR: [1.15 + Math.sin(t * 13) * 0.22, 0.5],
      legL: [-0.2, -0.08], legR: [0.28, 0.12],
      prop: "desk",
      mood: "flat",
    };
  },
  cook(t) {
    return {
      ...STAND,
      lean: 0.22,
      armL: [1.0 + Math.sin(t * 9) * 0.18, 0.5], armR: [1.1 + Math.sin(t * 9 + 2) * 0.18, 0.5],
      prop: "desk",
      mood: "smile",
    };
  },
  dance(t) {
    const s = Math.sin(t * 6);
    return {
      ...STAND,
      lean: s * 0.18,
      armL: [-1.6 + s * 0.5, -0.6], armR: [1.6 + s * 0.5, 0.6],
      legL: [-0.12 - s * 0.35, -0.1], legR: [0.12 + s * 0.35, 0.1],
      lift: Math.abs(s) * 8,
      head: s * 0.1,
      mood: "smile",
    };
  },
  sit(t) {
    // seated profile: thighs forward, shins down (pairs with chair/couch props).
    // SEAT_Y/SEAT_X in drawFigure drop the hips onto the actual seat surface —
    // these leg angles plant the feet on the ground from that height.
    const b = Math.sin(t * 2) * 0.03;
    return {
      ...STAND,
      lean: 0.06 + b,
      armL: [-0.7, 0.1], armR: [0.7, -0.1],
      legL: [1.0, -1.1], legR: [1.2, -1.3],
      lift: -14,
      seated: true,
      mood: "smile",
    };
  },
  lie(t) {
    // asleep — flat on the back (on the bed when there is one), gentle breathing.
    // rot -1.5 lays the body head-LEFT so the head rests on the bed's pillow.
    const z = Math.sin(t * 1.4) * 2;
    return {
      ...STAND,
      rot: -1.5,
      lift: 40 + z,
      armL: [-0.15, -0.1], armR: [0.15, 0.1],
      legL: [-0.06, 0.02], legR: [0.06, -0.02],
      seated: true,
      mood: "sleep",
    };
  },
  cry(t) {
    const sh = Math.sin(t * 7) * 0.05;
    return {
      ...STAND,
      lean: 0.1 + sh,
      head: 0.15,
      armL: [-2.45, -2.05], armR: [2.45, 2.05],
      legL: [-0.2, -0.1], legR: [0.2, 0.1],
      mood: "sad",
    };
  },
  laugh(t) {
    const b = Math.abs(Math.sin(t * 5.5));
    return {
      ...STAND,
      lean: 0.12,
      head: -0.18,
      armL: [-0.9, -1.3], armR: [1.1, 0.6],
      lift: b * 5,
      sx: 1 + b * 0.03,
      mood: "grin",
    };
  },
  eat(t) {
    // hand cycles between the plate and the mouth
    const c = (Math.sin(t * 6) + 1) / 2;
    return {
      ...STAND,
      lean: 0.18,
      armL: [1.0, 0.4],
      armR: [lerp(0.95, 0.55, c), lerp(0.35, 2.0, c)],
      mood: "flat",
      prop: "table",
      holdIt: true,
    };
  },
  drink(t) {
    const c = (Math.sin(t * 3) + 1) / 2;
    return {
      ...STAND,
      head: c * -0.18,
      armL: [-0.3, -0.2],
      armR: [lerp(0.95, 0.5, c), lerp(0.4, 2.15, c)],
      mood: "smile",
      holdIt: true,
    };
  },
  open(t, d) {
    // reach (holding the box in front) → lift the lid → celebrate — the
    // held object vanishes in the joy phase, as if the lid came off
    const span = Math.min(2.0, Math.max(1.0, d));
    const u = clamp01(t / span);
    const reach = { ...STAND, lean: 0.22, armL: [0.85, 0.25], armR: [0.95, 0.25], legL: [-0.25, -0.1], legR: [0.25, 0.1], mood: "flat", holdIt: true };
    const lift = { ...STAND, lean: 0.16, armL: [0.55, 0.1], armR: [1.45, 0.1], lift: 8, mood: "o", holdIt: true };
    const joy = { ...STAND, armL: [-1.2, -0.4], armR: [1.2, 0.4], lift: Math.abs(Math.sin(t * 5)) * 10, mood: "grin", away: true };
    if (u < 0.3) return mixPose(STAND, reach, u / 0.3);
    if (u < 0.6) return mixPose(reach, lift, (u - 0.3) / 0.3);
    return mixPose(lift, joy, (u - 0.6) / 0.4);
  },
  drop(t, d) {
    // bend down with the object in hands → release it (it reappears as a
    // ground prop) → straighten back up
    const span = Math.min(1.6, Math.max(0.9, d));
    const u = clamp01(t / span);
    const bend = { ...STAND, lean: 0.3, armL: [0.95, 0.35], armR: [1.05, 0.3], legL: [0.45, 0.85], legR: [-0.35, -0.55], lift: -10, mood: "flat", holdIt: true };
    const released = { ...STAND, lean: 0.26, armL: [0.9, 0.35], armR: [1.0, 0.3], legL: [0.45, 0.85], legR: [-0.35, -0.55], lift: -12, mood: "flat" };
    if (u < 0.4) return mixPose(STAND, bend, u / 0.4);
    if (u < 0.6) return released;
    return mixPose(released, STAND, (u - 0.6) / 0.4);
  },
  knock(t) {
    const k = Math.abs(Math.sin(t * 7));
    return {
      ...STAND,
      lean: 0.16,
      armL: [-0.5, -0.3],
      armR: [lerp(0.8, 1.35, k), 0.05],
      mood: "flat",
      fx: k > 0.95 ? "impact" : "",
    };
  },
  throw(t, d) {
    const span = Math.min(1.4, Math.max(0.8, d));
    const u = clamp01(t / span);
    const wind = { ...STAND, lean: -0.12, armL: [-0.5, -0.4], armR: [-2.5, -0.6], legR: [0.3, 0.15], mood: "flat", holdIt: true };
    const release = { ...STAND, lean: 0.28, armL: [-0.3, -0.2], armR: [1.7, 0.05], legL: [-0.4, -0.2], legR: [0.25, 0.1], mood: "o", away: true };
    const settle = { ...STAND, lean: 0.18, armL: [-0.3, -0.2], armR: [1.0, 0.05], away: true };
    if (u < 0.35) return mixPose(STAND, wind, u / 0.35);
    if (u < 0.55) return mixPose(wind, release, (u - 0.35) / 0.2);
    return mixPose(release, settle, (u - 0.55) / 0.45);
  },
  catch(t, d) {
    const span = Math.min(1.4, Math.max(0.8, d));
    const u = clamp01(t / span);
    const reach = { ...STAND, lean: 0.12, armL: [1.35, 0.05], armR: [1.15, 0.05], legL: [-0.35, -0.15], mood: "o" };
    const hold = { ...STAND, lean: 0.05, armL: [0.9, -0.35], armR: [1.0, 0.35], mood: "grin", holdIt: true };
    if (u < 0.45) return mixPose(STAND, reach, u / 0.45);
    return mixPose(reach, hold, (u - 0.45) / 0.55);
  },
  carry(t) {
    const b = Math.abs(Math.sin(t * 3.5)) * 2;
    return {
      ...STAND,
      lean: 0.1,
      armL: [1.05, -0.55], armR: [0.95, 0.55],
      lift: -2 + b,
      legL: [-0.2, -0.1], legR: [0.2, 0.1],
      mood: "smile",
      holdIt: true,
    };
  },
  push(t) {
    const s = Math.sin(t * 3);
    return {
      ...STAND,
      lean: 0.3,
      armL: [1.5, 0.0], armR: [1.3, 0.0],
      legL: [-0.5 + s * 0.15, -0.2], legR: [0.35 - s * 0.15, 0.15],
      lift: Math.abs(s) * 3,
      mood: "flat",
    };
  },
  climb(t) {
    const s = Math.sin(t * 4.5);
    return {
      ...STAND,
      lean: -0.08,
      armL: [-2.3 + s * 0.55, -0.5], armR: [2.3 - s * 0.55, 0.5],
      legL: [-0.3 - s * 0.45, 0.5], legR: [0.3 + s * 0.45, -0.5],
      lift: 6 + Math.abs(s) * 6,
      mood: "flat",
    };
  },
  swim(t) {
    const s = Math.sin(t * 5);
    return {
      ...STAND,
      rot: 1.15,
      lift: -30,
      armL: [-2.6 + s * 0.7, -0.4], armR: [2.2 - s * 0.7, 0.4],
      legL: [-0.25 - s * 0.3, 0.25], legR: [0.25 + s * 0.3, -0.25],
      head: -0.1,
      mood: "smile",
    };
  },
  bow(t, d) {
    const span = Math.min(1.6, Math.max(1.0, d));
    const u = clamp01(t / span);
    const folded = { ...STAND, lean: 1.05, armL: [0.35, 0.3], armR: [-0.35, -0.3], head: 0.15, mood: "smile" };
    if (u < 0.4) return mixPose(STAND, folded, u / 0.4);
    if (u < 0.6) return folded;
    return mixPose(folded, STAND, (u - 0.6) / 0.4);
  },
  stretch(t) {
    const s = Math.sin(t * 2.5);
    return {
      ...STAND,
      lean: s * 0.05,
      armL: [-2.7, -0.15], armR: [2.7, 0.15],
      lift: 4 + Math.abs(s) * 3,
      head: -0.1,
      mood: "smile",
    };
  },
};

/* Keyword → action (checked in object order; matchAction uses word-boundary
 * regexes so substrings like "hi" in "shine" don't match). */
const KEYWORDS = {
  drop: ["puts down", "put down", "put it down", "puts it down", "sets down", "set down", "sets it down", "set it down", "places", "placed", "placing"],
  write: ["write", "writes", "writing", "wrote", "novel", "notebook", "scribble", "scribbles", "scribbling", "pencil", "pen", "desk", "essay", "notes", "type", "typing", "keyboard"],
  cook: ["cook", "cooks", "cooked", "cooking", "whisk", "whisking", "eggs", "kitchen", "food", "meal", "sandwich", "chef", "recipe", "stomach", "sizzle"],
  dance: ["dance", "dances", "danced", "dancing", "polka", "lo-fi", "beats"],
  run: ["run", "runs", "ran", "running", "sprint", "sprints", "sprinting", "rush", "flee", "flees", "chase", "chases", "chasing", "hurry", "hurries", "hurrying", "frantic", "frantically", "fast", "quick"],
  jump: ["jump", "jumps", "jumped", "jumping", "leap", "leaps", "leaped", "leaping", "hop", "hops", "hopping", "bounce", "bounces", "bouncing", "dive", "dives", "diving"],
  fall: ["fall", "falls", "fell", "falling", "trip", "trips", "slip", "slips", "slipped", "slipping", "drop", "drops", "dropped", "dropping", "crash", "crashes", "crashing", "tumble", "tumbles", "tumbling", "face-plant", "faceplant", "thud"],
  celebrate: ["win", "wins", "won", "winning", "celebrate", "celebrates", "celebrated", "celebrating", "celebration", "triumph", "triumphant", "success", "succeeds", "proud", "hooray", "hurray", "finally", "victory", "nailed it", "cheer", "cheers", "cheering"],
  think: ["think", "thinks", "thinking", "thought", "wonder", "wonders", "wondering", "why", "how", "maybe", "idea", "ideas", "question", "imagine", "imagines", "imagining", "what if", "suppose", "science", "research"],
  wave: ["hello", "hi", "hey", "wave", "waves", "waved", "waving", "greet", "greets", "greeting", "bye", "goodbye", "welcome", "meets", "meet"],
  point: ["look", "looks", "looked", "looking", "see", "sees", "saw", "seen", "watch", "watches", "watching", "notice", "notices", "point", "points", "pointing", "spot", "spots", "spotted", "appear", "appears", "eyes widen"],
  walk: ["walk", "walks", "walked", "walking", "step", "steps", "go", "went", "gone", "move", "moves", "moving", "travel", "travels", "traveling", "journey", "away"],
  cry: ["cry", "cries", "crying", "sob", "sobs", "sobbing", "tear", "tears", "tearful", "weep", "weeps", "weeping", "sad", "heartbroken", "upset", "depressed", "heart breaks", "heartbreak"],
  laugh: ["laugh", "laughs", "laughing", "giggle", "giggles", "giggling", "hilarious", "cracks up", "can't stop laughing"],
  eat: ["eat", "eats", "eating", "ate", "bite", "bites", "biting", "munch", "munching", "snack", "snacks", "taste", "tastes", "tasting", "hungry", "burger", "pizza", "sandwich"],
  drink: ["drink", "drinks", "drinking", "drank", "sip", "sips", "sipped", "sipping", "coffee", "tea", "juice", "lemonade", "soda", "thirsty", "gulps"],
  open: ["open", "opens", "opened", "opening", "unwrap", "unwraps", "unwrapping", "unbox", "lid", "reveal", "reveals", "revealed", "rips open", "tears open"],
  knock: ["knock", "knocks", "knocking", "knocked", "doorbell", "raps"],
  throw: ["throw", "throws", "threw", "throwing", "toss", "tosses", "tossing", "hurl", "hurls", "launch", "launches"],
  catch: ["catch", "catches", "caught", "catching", "grab", "grabs", "grabbing", "snatch", "snatches", "receive", "receives", "holds up"],
  carry: ["carry", "carries", "carrying", "carried", "hold", "holds", "holding", "hug", "hugs", "hugging", "cradle", "cradles", "embrace", "embraces"],
  push: ["push", "pushes", "pushing", "shove", "shoves", "pull", "pulls", "pulling", "drag", "drags", "dragging", "haul", "hauls"],
  climb: ["climb", "climbs", "climbing", "climbed", "scale", "scales", "stairs", "ladder", "mountain", "hill"],
  swim: ["swim", "swims", "swimming", "swam", "pool", "ocean", "sea", "beach", "waves at the beach"],
  sit: ["sit", "sits", "sitting", "sat", "sit down", "sits down", "sits at", "settle", "settles"],
  lie: ["lie", "lies", "lay", "lying", "sleep", "sleeps", "sleeping", "asleep", "nap", "naps", "napping", "bedtime", "snores", "snoring", "goes to bed", "goes to sleep"],
  bow: ["bow", "bows", "bowing", "bowed", "thank you", "thanks", "grateful", "gratitude"],
  stretch: ["stretch", "stretches", "stretching", "yawn", "yawns", "yawning", "wake up", "wakes up", "waking up", "gets up", "morning routine"],
};
const FALLBACK_ACTIONS = ["talk", "walk", "point", "think", "wave"];

const KEYWORD_RE = Object.entries(KEYWORDS).map(([act, keys]) => [
  act,
  keys.map((k) => new RegExp(`\\b${k.replace(/[^a-z0-9 ]/g, ".")}\\b`, "i")),
]);

/** Match a block of text to an action, or null. */
function matchAction(text) {
  const t = String(text).toLowerCase();
  for (const [act, res] of KEYWORD_RE) {
    if (res.some((re) => re.test(t))) return act;
  }
  return null;
}

/** Pick an action for a block of text (visual + voiceover). */
function pickAction(text, fallbackIndex = 0) {
  return matchAction(text) ?? FALLBACK_ACTIONS[Math.abs(fallbackIndex) % FALLBACK_ACTIONS.length];
}

/**
 * Parse a structured story script as produced by Gemini / ChatGPT:
 *   0:00 - 0:08 | The Setup
 *   Visual: ...
 *   Audio: ...
 *   Voiceover: "..."
 * Returns [{ t0, t1, title, visual, voiceover }] or [] when the text has
 * no timestamped scenes (plain script).
 */
function parseStoryScript(text) {
  const timeRe = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(?:[|·:\-–]\s*)?(.*)$/;
  const scenes = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = timeRe.exec(line);
    if (m) {
      const t0 = Number(m[1]) * 60 + Number(m[2]);
      const t1 = Number(m[3]) * 60 + Number(m[4]);
      cur = {
        t0,
        t1: Math.max(t1, t0 + 2),
        title: (m[5] || "").replace(/^[|·:\-–\s]+/, "").trim(),
        visual: "",
        voiceover: "",
      };
      scenes.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^(visual|audio|voiceover|narration|narrator|sfx|colors?|colours?|background|backdrop|elements?)\s*:\s*(.*)$/i.exec(line);
    if (kv) {
      const k = kv[1].toLowerCase();
      const v = kv[2].replace(/^[“"']|[”"']$/g, "").trim();
      if (k === "voiceover" || k === "narration" || k === "narrator") {
        cur.voiceover += (cur.voiceover ? " " : "") + v;
      } else if (k === "visual") {
        cur.visual += (cur.visual ? " " : "") + v;
      } else if (k.startsWith("colo") || k === "background" || k === "backdrop" || k === "element" || k === "elements") {
        cur.colors = (cur.colors ? " " : "") + v; // scene color mood (Auto style)
      } else {
        cur.audio = (cur.audio ? " " : "") + v; // music cues: noted, not generated
      }
    } else {
      cur.visual += (cur.visual ? " " : "") + line;
    }
  }
  return scenes;
}

/** Split the timed words into scenes (max 12 words, or a big pause) and
 * pick an action for each from the keywords. */
function buildScenes(words, duration) {
  const scenes = [];
  let start = null;
  let group = [];
  const push = (end) => {
    if (!group.length) return;
    const text = group.map((w) => w.w).join(" ").toLowerCase();
    const action = matchAction(text) ?? FALLBACK_ACTIONS[scenes.length % FALLBACK_ACTIONS.length];
    scenes.push({ start: start ?? group[0].start, end, action });
    start = end;
    group = [];
  };
  for (const w of words) {
    if (group.length && (w.start - group[group.length - 1].end > 0.8 || group.length >= 12)) {
      push(group[group.length - 1].end);
    }
    group.push(w);
  }
  if (group.length) push(group[group.length - 1].end);
  if (scenes.length && Number.isFinite(duration)) {
    scenes[scenes.length - 1].end = Math.max(scenes[scenes.length - 1].end, duration);
  }
  return scenes;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function hex(c) {
  const s = String(c);
  return s.startsWith("#") ? s : "#" + s.replace(/^0x/, "");
}

function drawBackground(ctx, style, groundLine, t = 0, groundTint = null) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, hex(style.c0));
  g.addColorStop(1, hex(style.c1));
  ctx.fillStyle = g;
  ctx.fillRect(-16, -16, W + 32, H + 32);
  // soft floating blobs — cheap depth so backgrounds feel alive
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  for (let i = 0; i < 3; i++) {
    const px = W * (0.18 + 0.28 * i) + Math.sin(t * 0.35 + i * 2.1) * 42;
    const py = H * (0.16 + 0.17 * i) + Math.cos(t * 0.28 + i * 1.7) * 32;
    ctx.beginPath();
    ctx.arc(px, py, 95 + i * 48, 0, Math.PI * 2);
    ctx.fill();
  }
  // ground
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(-16, groundLine + 4, W + 32, H - groundLine + 12);
  // surface tint from the storyboard's Colors line (grass/sand/snow/…)
  if (groundTint) {
    const [r, g, b, a] = groundTint.rgb;
    ctx.fillStyle = `rgba(${r},${g},${b},${a * groundTint.a})`;
    ctx.fillRect(-16, groundLine + 4, W + 32, H - groundLine + 12);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-16, groundLine + 4);
  ctx.lineTo(W + 16, groundLine + 4);
  ctx.stroke();
  // faint floor tile grid (storyboard-room feel)
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 2;
  for (let i = 1; i <= 5; i++) {
    const y = groundLine + 4 + i * ((H - groundLine) / 5);
    ctx.beginPath();
    ctx.moveTo(-16, y);
    ctx.lineTo(W + 16, y);
    ctx.stroke();
  }
  for (let i = -4; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(W / 2 + i * 62, groundLine + 4);
    ctx.lineTo(W / 2 + i * 170, H);
    ctx.stroke();
  }
}

/* Expressive cartoon face: blinking pupils with highlights, eyebrows and a
 * mouth that opens/closes while narration is active (lip-sync feel). */
function drawFace(ctx, hx, hy, mood, t, speaking) {
  const blink = (t % 3.4) < 0.14;
  const exo = 11;
  const ey = hy - 5;
  const my = hy + 14;
  const browY = hy - 17;
  const worried = mood === "o";
  const sad = mood === "sad";

  // eyebrows
  ctx.strokeStyle = "#141414";
  ctx.lineWidth = 3;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(hx + side * exo - side * 5, browY + (worried ? 2.5 : sad ? -2.5 : 0));
    ctx.lineTo(hx + side * exo + side * 5, browY - (worried ? 2.5 : sad ? -2.5 : 0));
    ctx.stroke();
  }

  // eyes
  if (blink || mood === "sleep") {
    ctx.lineWidth = 2.6;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hx + side * exo - 4, ey);
      ctx.lineTo(hx + side * exo + 4, ey);
      ctx.stroke();
    }
  } else if (mood === "o") {
    // wide shocked eyes
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 2.4;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(hx + side * exo, ey, 6.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = "#141414";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(hx + side * exo, ey + 1, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // pupils with a highlight dot (side-glance when thinking)
    const glance = mood === "think" ? 4 : 0;
    for (const side of [-1, 1]) {
      ctx.fillStyle = "#141414";
      ctx.beginPath();
      ctx.arc(hx + side * exo + glance, ey, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(hx + side * exo + glance - 1.3, ey - 1.3, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // mouth
  ctx.fillStyle = "#141414";
  ctx.strokeStyle = "#141414";
  if (speaking) {
    // open/close oscillation synced to the narration
    const open = 3 + Math.abs(Math.sin(t * 12)) * 6;
    ctx.beginPath();
    ctx.ellipse(hx, my, 5.5, open, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(hx - 4, my - open + 1, 8, 2.2);
  } else if (mood === "o") {
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(hx, my + 1, 4, 5.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (mood === "grin") {
    // big open grin with a teeth band
    ctx.beginPath();
    ctx.arc(hx, my - 2, 8, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(hx - 6, my - 2, 12, 2.6);
  } else if (mood === "talk") {
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(hx, my + 1, 4.5, 3.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (mood === "sad") {
    // frown + a falling tear
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(hx - 6, my + 3);
    ctx.quadraticCurveTo(hx, my - 2, hx + 6, my + 3);
    ctx.stroke();
    ctx.fillStyle = "#6ec1ff";
    ctx.beginPath();
    ctx.arc(hx - 11, ey + 6 + ((t * 16) % 14), 2.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (mood === "flat" || mood === "think" || mood === "sleep") {
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(hx - 6, my);
    ctx.lineTo(hx + 6, my);
    ctx.stroke();
  } else {
    // smile
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(hx, my - 4, 8, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
}

function drawAccessory(ctx, ch, hx, hy) {
  const a = ch.accessory;
  if (a === "cap") {
    ctx.fillStyle = ch.accent;
    ctx.beginPath(); ctx.arc(hx, hy, 25, Math.PI * 1.02, Math.PI * 1.98); ctx.fill();
    ctx.fillRect(hx + 6, hy - 26, 24, 6);
  } else if (a === "beanie") {
    ctx.fillStyle = ch.accent;
    ctx.beginPath(); ctx.arc(hx, hy, 25, Math.PI * 1.0, Math.PI * 2.0); ctx.fill();
    ctx.strokeStyle = ch.accent; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(hx - 25, hy - 8); ctx.lineTo(hx + 25, hy - 8); ctx.stroke();
  } else if (a === "bow") {
    ctx.fillStyle = ch.accent;
    ctx.beginPath();
    ctx.moveTo(hx - 14, hy - 22);
    ctx.lineTo(hx - 26, hy - 28); ctx.lineTo(hx - 26, hy - 14); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx - 14, hy - 22);
    ctx.lineTo(hx - 4, hy - 30); ctx.lineTo(hx - 4, hy - 15); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(hx - 14, hy - 22, 3.2, 0, Math.PI * 2); ctx.fill();
  } else if (a === "ponytail") {
    ctx.strokeStyle = ch.accent; ctx.lineWidth = 7; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(hx - 22, hy - 10);
    ctx.bezierCurveTo(hx - 40, hy + 6, hx - 34, hy + 34, hx - 26, hy + 48);
    ctx.stroke();
  } else if (a === "headphones") {
    ctx.strokeStyle = ch.accent; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(hx, hy, 27, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
    ctx.fillStyle = ch.accent;
    ctx.beginPath(); ctx.ellipse(hx - 26, hy + 2, 6, 9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(hx + 26, hy + 2, 6, 9, 0, 0, Math.PI * 2); ctx.fill();
  } else if (a === "glasses") {
    ctx.strokeStyle = ch.accent; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(hx - 9, hy - 2, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(hx + 9, hy - 2, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hx - 1, hy - 2); ctx.lineTo(hx + 1, hy - 2); ctx.stroke();
  } else if (a === "bun") {
    ctx.fillStyle = ch.accent;
    ctx.beginPath(); ctx.arc(hx, hy - 30, 9, 0, Math.PI * 2); ctx.fill();
  } else if (a === "messy") {
    // wild spiky hair strokes
    ctx.strokeStyle = ch.accent; ctx.lineWidth = 5; ctx.lineCap = "round";
    for (const [dx, dy, tx, ty] of [[-14, -20, -22, -38], [-4, -24, -6, -44], [6, -24, 12, -42], [15, -18, 25, -34]]) {
      ctx.beginPath();
      ctx.moveTo(hx + dx, hy + dy);
      ctx.lineTo(hx + tx, hy + ty);
      ctx.stroke();
    }
  } else if (a === "curly") {
    // bumpy cloud of curls along the crown (kept above the eyes)
    ctx.fillStyle = ch.accent;
    for (const [dx, dy, r] of [[-20, -24, 8], [-9, -31, 9], [3, -33, 9], [14, -29, 8], [21, -20, 7]]) {
      ctx.beginPath();
      ctx.arc(hx + dx, hy + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (a === "bangs") {
    // fringe band across the forehead + side strands
    ctx.fillStyle = ch.accent;
    ctx.beginPath();
    ctx.arc(hx, hy, 28, Math.PI * 1.05, Math.PI * 1.95);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(hx - 27, hy - 22, 54, 5);
    ctx.fillRect(hx - 27, hy - 22, 7, 16);
    ctx.fillRect(hx + 20, hy - 22, 7, 16);
  } else if (a === "flat") {
    // flat-top hair
    ctx.fillStyle = ch.accent;
    ctx.fillRect(hx - 22, hy - 34, 44, 14);
    ctx.fillRect(hx - 26, hy - 24, 8, 8);
    ctx.fillRect(hx + 18, hy - 24, 8, 8);
  }
}

/** Scene props behind the character — anchored to the character's GROUND
 * point (y=0 at the floor, negative = up) so poses that rotate or lift the
 * body (lie, swim, fall) can't drag or tilt them. Drawn before the body
 * transform, so they always stay behind the figure. */
function drawProp(ctx, prop) {
  if (prop === "desk") {
    ctx.fillStyle = "rgba(0,0,0,0.38)";
    ctx.fillRect(18, -152, 205, 14);  // top
    ctx.fillRect(32, -138, 11, 136);  // legs
    ctx.fillRect(193, -138, 11, 136);
  } else if (prop === "bed") {
    ctx.fillStyle = "rgba(0,0,0,0.34)";
    ctx.fillRect(-196, -128, 16, 128); // headboard
    ctx.fillRect(-196, -34, 184, 30);  // mattress
    ctx.fillRect(-184, -55, 53, 21);   // pillow
    ctx.fillRect(-184, -4, 11, 16);    // legs
    ctx.fillRect(-34, -4, 11, 16);
  } else if (prop === "tree") {
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath(); ctx.arc(-138, -186, 67, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(-86, -238, 46, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(-115, -2); ctx.quadraticCurveTo(-110, -94, -120, -152); ctx.stroke();
  } else if (prop === "couch") {
    ctx.fillStyle = "rgba(0,0,0,0.34)";
    ctx.fillRect(-201, -165, 30, 95);  // back
    ctx.fillRect(-201, -70, 150, 26);  // seat
    ctx.fillRect(-71, -115, 18, 71);   // armrest
  } else if (prop === "box") {
    // gift box with a lid and ribbon (the classic "open the present" prop)
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(69, -170, 85, 76);    // body
    ctx.fillRect(62, -188, 99, 18);    // lid
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(106, -188, 11, 94);   // ribbon
  } else if (prop === "door") {
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(110, -230, 97, 230);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(189, -138, 10, 10);   // handle
  } else if (prop === "window") {
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(-230, -266, 115, 106);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(-177, -266, 5, 106);  // mullions
    ctx.fillRect(-230, -218, 115, 5);
  } else if (prop === "table") {
    ctx.fillStyle = "rgba(0,0,0,0.34)";
    ctx.fillRect(-46, -152, 173, 14);  // top
    ctx.fillRect(-32, -138, 11, 138);  // legs
    ctx.fillRect(110, -138, 11, 138);
  } else if (prop === "chair") {
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(-138, -160, 14, 90);  // back
    ctx.fillRect(-115, -70, 130, 14);  // seat (extends under the sitter)
    ctx.fillRect(-110, -56, 11, 56);   // legs
    ctx.fillRect(-10, -56, 11, 56);
  } else if (prop === "car") {
    ctx.fillStyle = "rgba(0,0,0,0.26)";
    ctx.fillRect(-264, -78, 299, 58);  // body
    ctx.fillRect(-184, -124, 138, 46); // cabin
    ctx.beginPath(); ctx.arc(-207, -23, 23, 0, Math.PI * 2); ctx.fill(); // wheels
    ctx.beginPath(); ctx.arc(-46, -23, 23, 0, Math.PI * 2); ctx.fill();
  } else if (prop === "ball") {
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.beginPath(); ctx.arc(104, -34, 34, 0, Math.PI * 2); ctx.fill();
  } else if (prop === "tv") {
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(-246, -266, 127, 94); // panel
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillRect(-191, -172, 14, 172); // stand
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(-225, -9, 83, 9);     // base
  } else if (prop === "plant") {
    ctx.fillStyle = "rgba(0,0,0,0.26)";
    ctx.fillRect(110, -52, 51, 52);    // pot
    ctx.beginPath(); ctx.arc(136, -108, 32, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(110, -130, 21, 0, Math.PI * 2); ctx.fill();
  } else if (prop === "cup" || prop === "mug") {
    // small items drawn near the character's feet (drop / scene mention)
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(66, -16, 15, 16);     // body
    ctx.strokeStyle = "rgba(0,0,0,0.30)";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(84, -8, 5.5, -Math.PI / 2, Math.PI / 2); ctx.stroke(); // handle
  } else if (prop === "book") {
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(62, -8, 34, 8);       // closed book on the floor
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillRect(62, -8, 34, 2);
  } else if (prop === "phone") {
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(68, -10, 13, 10);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillRect(69, -9, 11, 8);
  } else if (prop === "plate") {
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath(); ctx.ellipse(90, -5, 24, 6, 0, 0, Math.PI * 2); ctx.fill();
  }
}

/* Seat attach points (interaction DSL step 2): where the hips go for each
 * prop you can sit/lie on. Values are local coords relative to the prop's
 * ground anchor: y = seat/mattress surface height (negative = up), x = hip
 * position along the seat. sit() plants the feet on the ground from SEAT_Y. */
const SEAT_Y = { chair: -70, couch: -70, bed: -30 };
const SEAT_X = { chair: -45, couch: -120, bed: -100 };

/** Small object drawn AT the character's hands (local body coords, hip at
 * (0,0)) — same translucent style as the ground props. */function drawHeldObject(ctx, held, x, y) {
  ctx.save();
  ctx.translate(x, y);
  if (held === "box") {
    // mini gift box with lid + ribbon
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fillRect(-23, -30, 46, 36);
    ctx.fillRect(-28, -39, 56, 11);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(-5, -39, 10, 45);     // vertical ribbon
    ctx.fillRect(-23, -14, 46, 5);     // horizontal ribbon
  } else if (held === "ball") {
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.beginPath(); ctx.arc(-6, -6, 6, 0, Math.PI * 2); ctx.fill();
  } else if (held === "book") {
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fillRect(-19, -13, 38, 26);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(-19, -13, 6, 26);     // spine
  } else if (held === "plate") {
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath(); ctx.ellipse(0, 0, 25, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.beginPath(); ctx.ellipse(0, -1, 13, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  } else if (held === "cup") {
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fillRect(-8, -9, 16, 18);      // body
    ctx.strokeStyle = "rgba(0,0,0,0.32)";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(10, 0, 6, -Math.PI / 2, Math.PI / 2); ctx.stroke(); // handle
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-6, -9); ctx.lineTo(6, -9); ctx.stroke(); // rim
  } else if (held === "phone") {
    ctx.fillStyle = "rgba(0,0,0,0.34)";
    ctx.fillRect(-8, -13, 16, 26);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(-6, -11, 12, 22);     // screen
  }
  ctx.restore();
}

/** Stick figure: hip at (0,0) local, feet ~80 below, head above the spine.
 * t drives breathing/blinking; speaking opens the mouth; extraProp draws a
 * scene prop (desk/bed/tree/couch) behind the character; held (interaction
 * DSL step 1) draws a small object (box/ball/book/plate/cup/phone) IN the
 * hands — suppressing the matching ground prop so it isn't duplicated. */
function drawFigure(ctx, ch, pose, cx, groundY, t = 0, speaking = false, extraProp = "", held = "") {
  const s = 1.15;
  const sy = pose.sy || 1;
  const sx = pose.sx || 1;
  const breathe = Math.sin(t * 2.2) * 1.6;
  let lift = (pose.lift || 0) + breathe; // subtle breathing
  let hipY = groundY - 82 * s * sy + lift;
  let px = cx;
  // seat attach (interaction DSL step 2): seated poses drop the hips onto
  // the prop's actual seat surface (SEAT_Y/SEAT_X); without a visible seat
  // they settle into a grounded "sitting" height.
  if (pose.seated) {
    const sp = pose.prop || extraProp;
    if (SEAT_Y[sp] !== undefined) {
      px = cx + SEAT_X[sp];
      hipY = groundY + SEAT_Y[sp] + breathe;
    } else {
      // no visible seat: sitting = grounded bench height, lying = on the floor
      hipY = groundY - (pose.rot ? 20 : 70) + breathe;
    }
  }

  // shadow shrinks/fades as the character lifts off
  ctx.save();
  ctx.globalAlpha = 0.25 * Math.max(0.2, 1 - Math.max(0, lift) / 110);
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.ellipse(px, groundY + 10, 46 * s, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // impact dust: radiating ticks + puffs at the feet (landings/falls)
  if (pose.fx === "impact") {
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    for (const [x0, x1, y] of [[-44, -62, -14], [-26, -38, -20], [26, 38, -20], [44, 62, -14]]) {
      ctx.beginPath();
      ctx.moveTo(cx + x0, groundY + 4);
      ctx.lineTo(cx + x1, groundY + 4 + y);
      ctx.stroke();
    }
    for (const [dx, dy, r] of [[-40, -2, 4], [40, -2, 4], [0, -4, 3]]) {
      ctx.beginPath();
      ctx.arc(cx + dx, groundY + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // scene prop behind the character — ground-anchored, drawn before the body
  // transform so rotating poses (lie/swim/fall) can't tilt or move it.
  // Held-object transfer (interaction DSL step 3): while the pose holds the
  // prop it's hidden from the ground; after a drop the pose releases it and
  // it appears on the ground; an `away` pose (throw release / open joy)
  // keeps it off the ground entirely.
  const prop = pose.prop || extraProp;
  if (prop && !(prop === held && (pose.holdIt || pose.away))) {
    ctx.save();
    ctx.translate(cx, groundY);
    drawProp(ctx, prop);
    ctx.restore();
  }

  ctx.save();
  ctx.translate(px, hipY);
  if (pose.rot) ctx.rotate(pose.rot);
  ctx.scale(s * sx, s * sy);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  /* Every limb is stroked twice: a wide white outline underneath, then the
   * character color — keeps dark characters readable on any background. */
  const seg = (x0, y0, a1, l1, a2, l2) => {
    const kx = x0 + Math.sin(a1) * l1;
    const ky = y0 + Math.cos(a1) * l1;
    const ex = kx + Math.sin(a1 + a2) * l2;
    const ey = ky + Math.cos(a1 + a2) * l2;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(kx, ky);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    };
    ctx.lineWidth = 17;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    path();
    ctx.lineWidth = 9;
    ctx.strokeStyle = ch.color;
    path();
    return [ex, ey];
  };

  // legs (from the hip)
  seg(0, 0, pose.legL[0], 40, pose.legL[1], 40);
  seg(0, 0, pose.legR[0], 40, pose.legR[1], 40);

  // spine with lean
  const shY = -62;
  const shX = Math.sin(pose.lean || 0) * -shY;
  const spine = () => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(shX, shY * Math.cos(pose.lean || 0));
    ctx.stroke();
  };
  ctx.lineWidth = 17;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  spine();
  ctx.lineWidth = 9;
  ctx.strokeStyle = ch.color;
  spine();

  // arms (from the shoulder) — remember where the hands end up
  const handL = seg(shX, shY, pose.armL[0], 34, pose.armL[1], 32);
  const handR = seg(shX, shY, pose.armR[0], 34, pose.armR[1], 32);

  // held object sits between the hands (average of both hand positions) —
  // only while the pose actually says it's being held (throw releases it,
  // catch only holds it after the grab, so it tracks the animation phases)
  if (held && pose.holdIt) {
    drawHeldObject(ctx, held, (handL[0] + handR[0]) / 2, (handL[1] + handR[1]) / 2);
  }

  // head — big expressive cartoon head
  const hy = shY - 36;
  const hx = shX + Math.sin((pose.lean || 0) + (pose.head || 0)) * 12;
  const head = () => {
    ctx.beginPath();
    ctx.arc(hx, hy, 30, 0, Math.PI * 2);
    ctx.stroke();
  };
  ctx.lineWidth = 15;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  head();
  ctx.lineWidth = 7;
  ctx.strokeStyle = ch.color;
  head();
  drawFace(ctx, hx, hy, pose.mood, t, speaking);
  drawAccessory(ctx, ch, hx, hy);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Captions (karaoke: spoken/current words turn yellow)                */
/* ------------------------------------------------------------------ */

function groupWords(words) {
  const groups = [];
  let g = [];
  for (const w of words) {
    if (g.length) {
      const gap = w.start - g[g.length - 1].end;
      if (g.length >= 5 || gap > 0.7) { groups.push(g); g = []; }
    }
    g.push(w);
  }
  if (g.length) groups.push(g);
  return groups;
}

function drawCaptions(ctx, group, t) {
  if (!group) return;
  ctx.font = `bold ${TEXT_SIZE}px Stick`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const maxW = 470;
  const spaceW = 12;

  const lines = [[]];
  let width = 0;
  for (const w of group) {
    const ww = ctx.measureText(w.w).width;
    if (width + ww > maxW && lines[lines.length - 1].length) { lines.push([]); width = 0; }
    lines[lines.length - 1].push(w);
    width += ww + spaceW;
  }

  const lineH = TEXT_SIZE + 10;
  let y = 944 - (lines.length - 1) * lineH;
  for (const line of lines) {
    let lw = 0;
    const ws = line.map((w) => {
      const ww = ctx.measureText(w.w).width;
      lw += ww;
      return ww;
    });
    lw += (line.length - 1) * spaceW;
    let x = W / 2 - lw / 2;
    for (let i = 0; i < line.length; i++) {
      const w = line[i];
      const spoken = w.end <= t + 0.001 || (w.start <= t && t < w.end);
      ctx.lineWidth = 9;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.strokeText(w.w, x + ws[i] / 2, y);
      ctx.fillStyle = spoken ? "#FFD700" : "#FFFFFF";
      ctx.fillText(w.w, x + ws[i] / 2, y);
      x += ws[i] + spaceW;
    }
    y += lineH;
  }
}

/* ------------------------------------------------------------------ */
/* Frame rendering                                                     */
/* ------------------------------------------------------------------ */

/* "Auto" screen style: each scene gets a background mood picked from its
 * text; colors cross-fade over 1.2s at scene boundaries. */
const AUTO_BG = {
  warm:   ["#fbbf24", "#ef4444"], // happy / celebrate
  violet: ["#a78bfa", "#ec4899"], // mystery / night / space
  green:  ["#34d399", "#0d9488"], // money / success / nature
  slate:  ["#94a3b8", "#475569"], // business / serious
  cool:   ["#38bdf8", "#6366f1"], // calm / tech (fallback)
};
const AUTO_BG_KEYS = {
  warm: ["celebrate", "happy", "joy", "laugh", "funny", "smile", "party", "triumph", "win", "victory", "cheer", "sunny", "morning", "wildly", "fanfare"],
  violet: ["mystery", "mysterious", "dark", "night", "secret", "magic", "glowing", "space", "alien", "star", "shadow", "ship", "spaceship"],
  green: ["money", "rich", "gold", "nature", "forest", "green", "success", "approved", "stamp", "lucky", "lucky break"],
  slate: ["business", "work", "office", "tax", "audit", "desk", "paperwork", "report", "serious", "meeting", "coffee", "typewriter", "notepad"],
};
const AUTO_BG_ORDER = ["cool", "warm", "green", "violet", "slate"];

/* Explicit color words win over mood keywords (LLM-written Colors lines);
 * the first color word in reading order decides, so "green ... gold" is
 * green, not gold-warm. */
const COLOR_WORD_MAP = {
  warm: new Set(["red", "orange", "gold", "golden", "yellow", "sunset", "fire", "warm", "amber", "peach"]),
  violet: new Set(["purple", "pink", "violet", "magenta", "lavender", "indigo", "neon"]),
  green: new Set(["green", "teal", "emerald", "mint", "lime", "olive"]),
  slate: new Set(["gray", "grey", "silver", "charcoal"]),
  cool: new Set(["blue", "cyan", "sky", "ocean", "ice", "turquoise", "futuristic", "chrome"]),
};

function pickAutoBg(text, i) {
  const t = String(text).toLowerCase();
  for (const w of t.match(/[a-z-]+/g) || []) {
    for (const [mood, set] of Object.entries(COLOR_WORD_MAP)) {
      if (set.has(w)) return AUTO_BG[mood];
    }
  }
  if (/black[- ](and|&)[- ]white|monochrome/.test(t)) return AUTO_BG.slate;
  for (const [mood, keys] of Object.entries(AUTO_BG_KEYS)) {
    if (keys.some((k) => t.includes(k))) return AUTO_BG[mood];
  }
  return AUTO_BG[AUTO_BG_ORDER[Math.abs(i) % AUTO_BG_ORDER.length]];
}

/* Ground surface words from the Colors line → tint drawn over the dark
 * ground so "green grass", "sandy beach", "snowy street" actually render
 * under the character's feet. First word in reading order wins. */
const GROUND_TINT_MAP = {
  grass: [58, 140, 62, 0.55],
  lawn: [58, 140, 62, 0.55],
  sand: [232, 196, 120, 0.55],
  beach: [232, 196, 120, 0.5],
  desert: [225, 180, 105, 0.5],
  snow: [235, 242, 248, 0.62],
  ice: [200, 228, 244, 0.5],
  water: [34, 98, 170, 0.5],
  pool: [34, 150, 190, 0.5],
  wood: [126, 78, 36, 0.5],
  carpet: [130, 60, 90, 0.4],
  road: [52, 52, 56, 0.5],
  street: [52, 52, 56, 0.45],
  pavement: [90, 90, 95, 0.45],
  tile: [200, 200, 205, 0.35],
  marble: [215, 215, 220, 0.4],
};

function groundTintFor(text) {
  const t = String(text).toLowerCase();
  for (const w of t.match(/[a-z-]+/g) || []) {
    if (GROUND_TINT_MAP[w]) return GROUND_TINT_MAP[w];
  }
  return null;
}

function hexLerp(a, b, u) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(lerp((pa >> sh) & 255, (pb >> sh) & 255, u));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** Background colors at time t (with smooth cross-scene fading). */
function bgAt(scenes, t) {
  let idx = scenes.length - 1;
  for (let i = 0; i < scenes.length; i++) {
    if (t >= scenes[i].start && t < scenes[i].end) { idx = i; break; }
  }
  const cur = scenes[idx];
  let c0 = cur.bg[0];
  let c1 = cur.bg[1];
  if (idx > 0) {
    const prev = scenes[idx - 1];
    const u = clamp01((t - cur.start) / 1.2);
    c0 = hexLerp(prev.bg[0], c0, u);
    c1 = hexLerp(prev.bg[1], c1, u);
  }
  return { c0, c1 };
}

/* Scene props picked from the scene text (furniture / environment). */
const PROP_KEYS = {
  bed: ["wake", "wakes", "woke", "sleep", "bed", "tired", "yawn", "alarm", "morning", "bedroom"],
  tree: ["park", "tree", "outside", "forest", "garden", "walk", "walked", "journey", "away", "nature"],
  couch: ["watch", "watches", "tv", "couch", "sofa", "relax", "rest", "television"],
  desk: ["desk", "write", "writes", "writing", "work", "office", "laptop", "study", "notebook"],
  box: ["gift", "present", "box", "package", "parcel", "wrap", "wrapping", "unbox", "surprise"],
  door: ["door", "doorstep", "doorbell", "entrance", "knock", "knocks", "knocking", "knocked"],
  window: ["window", "windows", "windowsill"],
  table: ["table", "dinner", "dining", "plate", "plates", "breakfast", "lunch", "cake"],
  chair: ["chair", "stool", "bench", "armchair"],
  car: ["car", "drive", "drives", "driving", "drove", "road", "street", "taxi", "bus", "traffic"],
  ball: ["ball", "football", "soccer", "basketball", "baseball"],
  tv: ["television", "channel", "movie", "news"],
  plant: ["plant", "plants", "flower", "flowers", "pot", "garden"],
  cup: ["cup", "mug", "coffee", "tea", "juice", "lemonade", "soda", "bottle"],
  book: ["book", "books", "diary", "novel"],
  phone: ["phone", "mobile", "cellphone", "smartphone"],
  plate: ["plate", "plates", "meal", "dinner"],
};

/* Held objects (interaction DSL step 1): when the Visual text mentions one of
 * these AND the action carries/throws/catches/eats/drinks it, the object is
 * drawn IN the character's hands instead of on the ground. */
const HELD_KEYS = {
  box: ["gift", "present", "box", "parcel", "package"],
  ball: ["ball", "football", "soccer", "basketball", "volleyball"],
  book: ["book", "books", "notebook", "diary", "journal"],
  plate: ["plate", "meal", "dinner", "food", "cake", "lunch", "breakfast"],
  cup: ["cup", "mug", "coffee", "tea", "juice", "lemonade", "soda", "bottle"],
  phone: ["phone", "mobile", "cellphone", "smartphone", "texting", "call"],
};

/** Which object the text says the character interacts with (word-boundary,
 * first in reading order wins — same rule as matchProp). */
function matchHeld(text) {
  const t = String(text).toLowerCase();
  let best = null;
  for (const [held, keys] of Object.entries(HELD_KEYS)) {
    for (const k of keys) {
      const m = new RegExp(`\\b${k.replace(/[^a-z0-9 ]/g, ".")}\\b`).exec(t);
      if (m && (!best || m.index < best.at)) best = { at: m.index, held };
    }
  }
  return best ? best.held : "";
}
/* The prop whose keyword appears FIRST in reading order wins, so "walks
 * outside toward a tree ... morning sky" is a tree scene, not a bed.
 * Word-boundary matching (like matchAction) so "carries" doesn't pick car. */
function matchProp(text) {
  const t = String(text).toLowerCase();
  let best = null;
  for (const [prop, keys] of Object.entries(PROP_KEYS)) {
    for (const k of keys) {
      const m = new RegExp(`\\b${k.replace(/[^a-z0-9 ]/g, ".")}\\b`).exec(t);
      if (m && (!best || m.index < best.at)) best = { at: m.index, prop };
    }
  }
  return best ? best.prop : "";
}

/**
 * Render the full animation as PNG frames.
 * opts: { words, scenes?, framesDir, style: {c0, c1, auto?}, characterId, onProgress(pct) }
 *   words:  [{ w, start, end }] — absolute times on the final audio track
 *   scenes: optional [{ start, end, action?, title? }] (story mode); built
 *           from word timings when omitted (plain mode)
 * Returns { framesDir, total, fps, duration }.
 */
async function renderStickmanFrames(opts) {
  const ch = CHARACTERS.find((c) => c.id === opts.characterId) || CHARACTERS[0];
  const words = opts.words;
  const auto = !!opts.style.auto;
  const scenes = (opts.scenes || buildScenes(words, Infinity)).map((s, i) => ({
    ...s,
    action: ACTIONS[s.action] ? s.action : "talk",
    // color words from the Colors line decide the background first (it's the
    // scene's actual color description); title/action keywords only fill in
    bg: auto ? pickAutoBg(`${s.colors || ""} || ${s.title || ""} ${s.action}`, i) : null,
    prop: matchProp(`${s.title || ""} ${s.visual || ""} ${s.colors || ""}`),
    // interaction DSL step 1: if the action holds an object at ANY point in
    // its animation (throw winds up holding, catch holds after the grab) AND
    // the text mentions a carryable one, it's drawn in the hands
    held: (ACTIONS[s.action] && [0, 0.12, 0.3, 0.5, 0.8].some((u) => {
      const d = Math.max(0.5, s.end - s.start);
      return ACTIONS[s.action](u * d, d).holdIt;
    })) ? matchHeld(`${s.title || ""} ${s.visual || ""}`) : "",
    // ground surface (grass/sand/snow/…) from the Colors line, fading in
    // over the first 1.2s of the scene like the background colors do
    ground: auto ? groundTintFor(`${s.colors || ""}`) : null,
  }));
  const lastTime = Math.max(
    words.length ? words[words.length - 1].end : 0,
    scenes.length ? scenes[scenes.length - 1].end : 0,
  );
  // duration cap: default 60s, or the requested maxLen (hard ceiling 900s —
  // Zotomic sends 900 for admins = unlimited video time)
  const duration = Math.min(Math.max(lastTime + 1.2, 2.5), Math.min(opts.maxLen || 60, 900));
  const total = Math.ceil(duration * FPS);
  const groups = groupWords(words);
  const framesDir = opts.framesDir;
  fs.mkdirSync(framesDir, { recursive: true });

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    let idx = -1;
    for (let j = 0; j < scenes.length; j++) {
      if (t >= scenes[j].start && t < scenes[j].end) { idx = j; break; }
    }
    const si = idx >= 0 ? idx : scenes.length - 1;
    const scene = scenes[si];
    // ground surface tint (grass/sand/snow/…) fades in over the scene cut
    // just like the background colors do
    let groundTint = null;
    if (scene && scene.ground) {
      groundTint = { rgb: scene.ground, a: si > 0 ? clamp01((t - scene.start) / 1.2) : 1 };
    }
    // gentle camera drift (scene only — captions and titles stay fixed)
    const z = 1 + 0.03 * Math.sin(t * 0.3 + 1);
    ctx.save();
    ctx.translate(W / 2, H * 0.55);
    ctx.scale(z, z);
    ctx.translate(-W / 2, -H * 0.55);
    drawBackground(ctx, auto ? bgAt(scenes, t) : opts.style, GROUND_Y, t, groundTint);
    const g = groups.find((gr) => t >= gr[0].start && t <= gr[gr.length - 1].end + 0.35);
    if (scene) {
      let pose = ACTIONS[scene.action](t - scene.start, scene.end - scene.start);
      // blend from the previous scene's end pose — no teleporting at cuts
      if (si > 0 && t - scene.start < 0.6) {
        const prev = scenes[si - 1];
        const from = ACTIONS[prev.action](prev.end - prev.start, prev.end - prev.start);
        pose = mixPose(from, pose, (t - scene.start) / 0.6);
      }
      drawFigure(ctx, ch, pose, W / 2, GROUND_Y, t, !!g, scene.prop, scene.held);
    }
    ctx.restore();
    if (scene && scene.title && t - scene.start < 2.4) drawSceneTitle(ctx, scene.title, (t - scene.start) / 2.4);
    drawCaptions(ctx, g, t);
    fs.writeFileSync(path.join(framesDir, `f${String(i).padStart(4, "0")}.png`), canvas.toBuffer("image/png"));
    if (i % 10 === 0) {
      if (opts.onProgress) opts.onProgress(15 + (i / total) * 55);
      await new Promise((r) => setImmediate(r)); // keep the event loop responsive
    }
  }
  return { framesDir, total, fps: FPS, duration };
}

/** Scene title card at the top of the frame — word-wrapped (up to 3 lines,
 * shrinking font) so long detail-line titles stay inside the frame. */
function drawSceneTitle(ctx, title, u) {
  const alpha = Math.min(1, u / 0.2, (1 - u) / 0.25);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxW = 480;
  const words = String(title).split(/\s+/).filter(Boolean);
  let size = 30;
  let lines = [[]];
  for (;;) {
    ctx.font = `bold ${size}px Stick`;
    lines = [[]];
    let width = 0;
    let truncated = false;
    for (const w of words) {
      const ww = ctx.measureText(w).width;
      if (width + ww > maxW && lines[lines.length - 1].length) {
        if (lines.length >= 3) { truncated = true; break; }
        lines.push([]);
        width = 0;
      }
      lines[lines.length - 1].push(w);
      width += ww + 8;
    }
    if (!truncated || size <= 20) {
      if (truncated) lines[lines.length - 1].push("…");
      break;
    }
    size -= 3;
  }
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.fillStyle = "#FFFFFF";
  const lineH = size + 8;
  let y = 96 - ((lines.length - 1) * lineH) / 2;
  for (const line of lines) {
    const text = line.join(" ");
    ctx.strokeText(text, W / 2, y);
    ctx.fillText(text, W / 2, y);
    y += lineH;
  }
  ctx.restore();
}

module.exports = { CHARACTERS, renderStickmanFrames, parseStoryScript, pickAction, matchAction, matchProp, matchHeld };
