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
  for (const k of ["lean", "rot", "lift", "head"]) o[k] = lerp(a[k] ?? 0, b[k] ?? 0, u);
  for (const k of ["armL", "armR", "legL", "legR"]) {
    o[k] = [lerp(a[k][0], b[k][0], u), lerp(a[k][1], b[k][1], u)];
  }
  o.mood = u > 0.5 ? b.mood : a.mood;
  return o;
}

const ACTIONS = {
  walk(t) {
    const s = Math.sin(t * 5);
    return {
      ...STAND,
      lean: 0.08,
      armL: [0.35 + s * 0.45, 0.3], armR: [0.35 - s * 0.45, 0.3],
      legL: [-0.12 - s * 0.55, Math.max(0, s) * 0.5], legR: [-0.12 + s * 0.55, Math.max(0, -s) * 0.5],
      lift: Math.abs(s) * 4,
      mood: "smile",
    };
  },
  run(t) {
    const s = Math.sin(t * 8.5);
    return {
      ...STAND,
      lean: 0.32,
      armL: [0.5 + s * 0.85, 0.9], armR: [0.5 - s * 0.85, 0.9],
      legL: [-0.12 - s * 0.9, Math.max(0, s) * 1.0], legR: [-0.12 + s * 0.9, Math.max(0, -s) * 1.0],
      lift: Math.abs(s) * 9 + 2,
      mood: "smile",
    };
  },
  jump(t, d) {
    // The action completes quickly and holds a stand through any pause.
    const span = Math.min(1.6, Math.max(0.8, d));
    const u = clamp01(t / span);
    const crouch = { ...STAND, legL: [0.55, 0.95], legR: [-0.55, -0.95], armL: [0.75, 0.35], armR: [-0.75, -0.35], lift: -16, mood: "flat" };
    const air = { ...STAND, legL: [-0.6, -1.0], legR: [0.6, 1.0], armL: [-2.5, -0.35], armR: [2.5, 0.35], lift: 70, mood: "smile" };
    const land = { ...STAND, legL: [0.5, 0.9], legR: [-0.5, -0.9], armL: [0.5, 0.3], armR: [-0.5, -0.3], lift: -14, mood: "smile" };
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
    const landed = { ...STAND, rot: 1.5, lift: -78, armL: [-1.8, -0.2], armR: [1.6, 0.2], legL: [-0.25, -0.1], legR: [0.2, 0.15], mood: "o" };
    if (u < 0.66) return mixPose(STAND, air, Math.min(1, u * 1.5));
    return mixPose(air, landed, (u - 0.66) / 0.34);
  },
  celebrate(t) {
    const wig = Math.sin(t * 9) * 0.25;
    return {
      ...STAND,
      armL: [-2.35 + wig, -0.35], armR: [2.35 - wig, 0.35],
      lift: Math.abs(Math.sin(t * 4.5)) * 12,
      mood: "smile",
    };
  },
  think() {
    return { ...STAND, armL: [-0.5, -0.6], armR: [2.1, 1.5], head: 0.12, mood: "flat" };
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
};

/* Keyword → action (checked in object order; matchAction uses word-boundary
 * regexes so substrings like "hi" in "shine" don't match). */
const KEYWORDS = {
  write: ["write", "writes", "writing", "wrote", "novel", "notebook", "scribble", "scribbles", "scribbling", "pencil", "pen", "desk", "essay", "notes", "type", "typing", "keyboard"],
  cook: ["cook", "cooking", "whisk", "whisking", "eggs", "kitchen", "food", "meal", "sandwich", "chef", "recipe", "stomach", "sizzle"],
  dance: ["dance", "dancing", "polka", "lo-fi", "beats"],
  run: ["run", "runs", "running", "sprint", "rush", "flee", "chase", "hurry", "frantic", "frantically", "fast", "quick"],
  jump: ["jump", "jumps", "jumped", "leap", "hop", "bounce", "dive", "dives", "dives"],
  fall: ["fall", "falls", "fell", "falling", "trip", "slip", "slipped", "drop", "dropped", "crash", "tumble", "face-plant", "faceplant", "thud"],
  celebrate: ["win", "wins", "won", "celebrate", "triumph", "triumphant", "success", "proud", "hooray", "finally", "victory", "nailed it"],
  think: ["think", "thought", "wonder", "why", "how", "maybe", "idea", "question", "imagine", "what if", "suppose", "wondering", "science", "research"],
  wave: ["hello", "hi", "hey", "wave", "waves", "greet", "bye", "goodbye", "welcome", "meet"],
  point: ["look", "looks", "see", "watch", "notice", "point", "spot", "appear", "appears", "eyes widen"],
  walk: ["walk", "walked", "walking", "step", "go", "went", "move", "moving", "travel", "journey", "away"],
};
const FALLBACK_ACTIONS = ["talk", "walk", "point", "think", "wave"];

const KEYWORD_RE = Object.entries(KEYWORDS).map(([act, keys]) => [
  act,
  keys.map((k) => new RegExp(`\\b${k.replace(/[^a-z0-9 ]/g, ".")}`, "i")),
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

function drawBackground(ctx, style, groundLine, t = 0) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, hex(style.c0));
  g.addColorStop(1, hex(style.c1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
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
  ctx.fillRect(0, groundLine + 4, W, H - groundLine);
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, groundLine + 4);
  ctx.lineTo(W, groundLine + 4);
  ctx.stroke();
}

function drawFace(ctx, hx, hy, mood) {
  ctx.fillStyle = "#111111";
  ctx.beginPath(); ctx.arc(hx - 8, hy - 3, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(hx + 8, hy - 3, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 2.6;
  if (mood === "o") {
    ctx.beginPath(); ctx.ellipse(hx, hy + 9, 4, 5.5, 0, 0, Math.PI * 2); ctx.stroke();
  } else if (mood === "talk") {
    ctx.beginPath(); ctx.ellipse(hx, hy + 9, 4.5, 3.5, 0, 0, Math.PI * 2); ctx.stroke();
  } else if (mood === "flat") {
    ctx.beginPath(); ctx.moveTo(hx - 6, hy + 9); ctx.lineTo(hx + 6, hy + 9); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(hx, hy + 4, 8, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
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
  }
}

/** Stick figure: hip at (0,0) local, feet ~80 below, head above the spine. */
function drawFigure(ctx, ch, pose, cx, groundY) {
  const s = 1.15;
  const hipY = groundY - 82 * s + (pose.lift || 0);

  // shadow shrinks/fades as the character lifts off
  ctx.save();
  ctx.globalAlpha = 0.25 * Math.max(0.2, 1 - Math.max(0, pose.lift || 0) / 110);
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.ellipse(cx, groundY + 10, 46 * s, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(cx, hipY);
  if (pose.rot) ctx.rotate(pose.rot);
  ctx.scale(s, s);
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
    ctx.lineWidth = 15;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    path();
    ctx.lineWidth = 8;
    ctx.strokeStyle = ch.color;
    path();
    return [ex, ey];
  };

  // desk prop (writing / cooking scenes) — drawn behind the character
  if (pose.prop === "desk") {
    ctx.fillStyle = "rgba(0,0,0,0.38)";
    ctx.fillRect(16, -50, 178, 12);
    ctx.fillRect(28, -38, 10, 118);
    ctx.fillRect(168, -38, 10, 118);
  }

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
  ctx.lineWidth = 15;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  spine();
  ctx.lineWidth = 8;
  ctx.strokeStyle = ch.color;
  spine();

  // arms (from the shoulder)
  seg(shX, shY, pose.armL[0], 34, pose.armL[1], 32);
  seg(shX, shY, pose.armR[0], 34, pose.armR[1], 32);

  // head
  const hy = shY - 34;
  const hx = shX + Math.sin((pose.lean || 0) + (pose.head || 0)) * 10;
  const head = () => {
    ctx.beginPath();
    ctx.arc(hx, hy, 24, 0, Math.PI * 2);
    ctx.stroke();
  };
  ctx.lineWidth = 13;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  head();
  ctx.lineWidth = 6;
  ctx.strokeStyle = ch.color;
  head();
  drawFace(ctx, hx, hy, pose.mood);
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
    bg: auto ? pickAutoBg(`${s.title || ""} ${s.colors || ""} ${s.action}`, i) : null,
  }));
  const lastTime = Math.max(
    words.length ? words[words.length - 1].end : 0,
    scenes.length ? scenes[scenes.length - 1].end : 0,
  );
  const duration = Math.min(Math.max(lastTime + 1.2, 2.5), 60); // hard cap 60s
  const total = Math.ceil(duration * FPS);
  const groups = groupWords(words);
  const framesDir = opts.framesDir;
  fs.mkdirSync(framesDir, { recursive: true });

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    drawBackground(ctx, auto ? bgAt(scenes, t) : opts.style, GROUND_Y, t);
    let idx = -1;
    for (let j = 0; j < scenes.length; j++) {
      if (t >= scenes[j].start && t < scenes[j].end) { idx = j; break; }
    }
    const si = idx >= 0 ? idx : scenes.length - 1;
    const scene = scenes[si];
    if (scene) {
      let pose = ACTIONS[scene.action](t - scene.start, scene.end - scene.start);
      // blend from the previous scene's end pose — no teleporting at cuts
      if (si > 0 && t - scene.start < 0.6) {
        const prev = scenes[si - 1];
        const from = ACTIONS[prev.action](prev.end - prev.start, prev.end - prev.start);
        pose = mixPose(from, pose, (t - scene.start) / 0.6);
      }
      drawFigure(ctx, ch, pose, W / 2, GROUND_Y);
      if (scene.title && t - scene.start < 2.4) drawSceneTitle(ctx, scene.title, (t - scene.start) / 2.4);
    }
    const g = groups.find((gr) => t >= gr[0].start && t <= gr[gr.length - 1].end + 0.35);
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

module.exports = { CHARACTERS, renderStickmanFrames, parseStoryScript, pickAction, matchAction };
