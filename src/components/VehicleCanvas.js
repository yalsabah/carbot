/**
 * VehicleCanvas.js — Pipeline-driven procedural 3-D vehicle renderer
 * ─────────────────────────────────────────────────────────────────────
 * Body uses THREE.ExtrudeGeometry with a mathematically correct coupe
 * side-profile (bezier curves).  Windows are exact BufferGeometry quads
 * fitted to the profile vertices so glass always aligns to the body.
 *
 * Props
 *   vehicleColor  – hex string for paint  (e.g. "#4A4E52")
 *   wheelColor    – 'gunmetal' | 'black' | 'chrome' | 'silver'
 *   bodyStyle     – 'coupe' | 'sedan' | 'suv'  (drives profile shape)
 *
 * Pipeline Step-4 PBR material spec applied:
 *   Body paint  → roughness 0.22, metalness 0.88
 *   Wheels      → roughness 0.40, metalness 0.75
 *   Glass       → opacity 0.18, roughness 0.0
 *   Tires       → roughness 1.00, metalness 0.00
 *   Chrome      → roughness 0.05, metalness 1.00
 *   Exhaust     → roughness 0.28, metalness 0.92
 */

import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

// ─── Coordinate convention ────────────────────────────────────────────────────
//  X  = car's length axis  (+X = front  /  –X = rear)
//  Y  = vertical           (+Y = up)
//  Z  = car's width axis   (+Z = driver right, –Z = driver left)
//
//  Key Y landmarks (Three.js units ≈ 0.65 m each):
//    0.00  ground
//    0.06  underbody bottom
//    0.28  wheel-centre height
//    0.57  beltline / window base
//    0.89  roofline
//
//  Key X landmarks:
//   +1.46  front bumper face
//   +0.90  front-axle centre
//   –0.84  rear-axle centre
//   –1.46  rear bumper face

// ─── PBR material factory ─────────────────────────────────────────────────────
function makeMats(paintHex, wheelColorKey) {
  const wheelColors = {
    gunmetal: '#4a4e56',
    black:    '#111111',
    chrome:   '#d8d8d8',
    silver:   '#a8a8a8',
  };
  const wheelHex = wheelColors[wheelColorKey] || wheelColors.gunmetal;
  const wheelRoughness = { gunmetal: 0.40, black: 0.90, chrome: 0.05, silver: 0.30 }[wheelColorKey] || 0.40;
  const wheelMetal    = { gunmetal: 0.75, black: 0.00, chrome: 1.00, silver: 0.70 }[wheelColorKey] || 0.75;

  return {
    body:         new THREE.MeshStandardMaterial({ color: new THREE.Color(paintHex || '#4A4E52'), roughness: 0.22, metalness: 0.88 }),
    blackTrim:    new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.15, metalness: 0.0 }),
    glass:        new THREE.MeshStandardMaterial({ color: new THREE.Color('#4477aa'), transparent: true, opacity: 0.20, roughness: 0.0, metalness: 0.05, depthWrite: false, side: THREE.DoubleSide }),
    wheel:        new THREE.MeshStandardMaterial({ color: new THREE.Color(wheelHex), roughness: wheelRoughness, metalness: wheelMetal }),
    wheelDisc:    new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.55, metalness: 0.30 }),
    spoke:        new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.18, metalness: 0.95 }),
    tire:         new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 1.0, metalness: 0.0 }),
    chrome:       new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.05, metalness: 1.0 }),
    drl:          new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(0xffffff), emissiveIntensity: 6.0, roughness: 0.0 }),
    tailLight:    new THREE.MeshStandardMaterial({ color: 0xff1100, emissive: new THREE.Color(0xdd0000), emissiveIntensity: 2.0, transparent: true, opacity: 0.90 }),
    exhaust:      new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.28, metalness: 0.92 }),
    exhaustHole:  new THREE.MeshStandardMaterial({ color: 0x040404, roughness: 1.0, metalness: 0.0 }),
    grille:       new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.75, metalness: 0.25 }),
    grilleSur:    new THREE.MeshStandardMaterial({ color: 0xbcbcbc, roughness: 0.08, metalness: 0.95 }),
    caliper:      new THREE.MeshStandardMaterial({ color: 0xcc0000, roughness: 0.50, metalness: 0.30 }),
    shadow:       new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }),
  };
}

// ─── Quad geometry helper ─────────────────────────────────────────────────────
// p0=TL, p1=TR, p2=BR, p3=BL  (each is [x,y,z])
function quadGeo(p0, p1, p2, p3) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    ...p0, ...p1, ...p2,
    ...p0, ...p2, ...p3,
  ]), 3));
  geo.computeVertexNormals();
  return geo;
}

// ─── Car body profile shapes ──────────────────────────────────────────────────

/** Coupe / sports car profile — S5-style fastback */
function makeCoupeProfile() {
  const s = new THREE.Shape();

  s.moveTo(1.38, 0.06);                                     // front-bumper lower

  s.bezierCurveTo(1.46, 0.06, 1.46, 0.16, 1.46, 0.28);    // front bumper face
  s.lineTo(1.46, 0.42);
  s.bezierCurveTo(1.46, 0.56, 1.34, 0.58, 1.20, 0.57);    // bumper → hood leading edge
  s.lineTo(0.74, 0.57);                                     // hood surface

  s.bezierCurveTo(0.68, 0.57, 0.52, 0.70, 0.30, 0.89);    // windshield (42° rake)
  s.bezierCurveTo(0.16, 0.92, -0.18, 0.92, -0.34, 0.89);  // roof (slight arch)
  s.bezierCurveTo(-0.52, 0.87, -0.80, 0.74, -0.95, 0.57); // fastback C-pillar slope

  s.lineTo(-1.20, 0.57);                                    // trunk decklid
  s.bezierCurveTo(-1.38, 0.57, -1.46, 0.50, -1.46, 0.42); // trunk → rear bumper
  s.lineTo(-1.46, 0.28);
  s.bezierCurveTo(-1.46, 0.16, -1.44, 0.06, -1.38, 0.06); // rear bumper lower
  s.lineTo(1.38, 0.06);                                     // underbody

  return s;
}

/** Sedan profile — upright C-pillar, longer rear deck */
function makeSedanProfile() {
  const s = new THREE.Shape();

  s.moveTo(1.38, 0.06);
  s.bezierCurveTo(1.46, 0.06, 1.46, 0.16, 1.46, 0.28);
  s.lineTo(1.46, 0.42);
  s.bezierCurveTo(1.46, 0.56, 1.34, 0.60, 1.18, 0.59);
  s.lineTo(0.76, 0.59);

  s.bezierCurveTo(0.68, 0.59, 0.55, 0.68, 0.38, 0.91);    // moderate rake
  s.bezierCurveTo(0.22, 0.94, -0.28, 0.94, -0.52, 0.92);  // longer flat roof
  s.bezierCurveTo(-0.62, 0.92, -0.74, 0.88, -0.82, 0.78); // upright C-pillar
  s.bezierCurveTo(-0.90, 0.68, -0.92, 0.60, -0.94, 0.59);

  s.lineTo(-1.28, 0.59);                                    // long rear deck
  s.bezierCurveTo(-1.38, 0.59, -1.46, 0.52, -1.46, 0.42);
  s.lineTo(-1.46, 0.28);
  s.bezierCurveTo(-1.46, 0.16, -1.44, 0.06, -1.38, 0.06);
  s.lineTo(1.38, 0.06);

  return s;
}

/** SUV / crossover profile — tall, upright greenhouse */
function makeSUVProfile() {
  const s = new THREE.Shape();

  s.moveTo(1.30, 0.06);
  s.bezierCurveTo(1.44, 0.06, 1.46, 0.16, 1.46, 0.30);
  s.lineTo(1.46, 0.50);
  s.bezierCurveTo(1.44, 0.64, 1.30, 0.68, 1.14, 0.67);
  s.lineTo(0.80, 0.68);

  s.bezierCurveTo(0.70, 0.68, 0.60, 0.76, 0.44, 1.08);    // upright windshield
  s.bezierCurveTo(0.32, 1.12, -0.30, 1.12, -0.48, 1.10);  // flat tall roof
  s.bezierCurveTo(-0.60, 1.10, -0.72, 1.06, -0.80, 1.00); // upright C-pillar
  s.bezierCurveTo(-0.88, 0.94, -0.90, 0.82, -0.90, 0.68);

  s.lineTo(-1.14, 0.68);
  s.bezierCurveTo(-1.32, 0.68, -1.46, 0.56, -1.46, 0.44);
  s.lineTo(-1.46, 0.28);
  s.bezierCurveTo(-1.46, 0.14, -1.42, 0.06, -1.30, 0.06);
  s.lineTo(1.30, 0.06);

  return s;
}

// ─── Window geometry (exact quads matched to profile vertices) ────────────────
function addWindows(g, m, bodyStyle) {
  // Half-width of the glass panes (slightly inset from body edge)
  const hw = 0.415;

  if (bodyStyle === 'suv') {
    // Windshield
    g.add(new THREE.Mesh(quadGeo(
      [0.44, 1.08, -hw], [0.44, 1.08,  hw],
      [0.80, 0.68,  hw], [0.80, 0.68, -hw]), m.glass));
    // Rear glass
    g.add(new THREE.Mesh(quadGeo(
      [-0.48, 1.10, -hw], [-0.48, 1.10,  hw],
      [-0.90,  0.68,  hw], [-0.90,  0.68, -hw]), m.glass));
    // Side windows
    [-1, 1].forEach(side => {
      const wz = side * 0.524;
      g.add(new THREE.Mesh(quadGeo(
        [ 0.44, 1.08, wz], [-0.48, 1.10, wz],
        [-0.90, 0.68, wz], [ 0.80, 0.68, wz]), m.glass));
    });
  } else if (bodyStyle === 'sedan') {
    // Windshield
    g.add(new THREE.Mesh(quadGeo(
      [0.38, 0.91, -hw], [0.38, 0.91,  hw],
      [0.76, 0.59,  hw], [0.76, 0.59, -hw]), m.glass));
    // Rear glass (upright)
    g.add(new THREE.Mesh(quadGeo(
      [-0.52, 0.92, -hw], [-0.52, 0.92,  hw],
      [-0.94, 0.59,  hw], [-0.94, 0.59, -hw]), m.glass));
    // Side windows
    [-1, 1].forEach(side => {
      const wz = side * 0.524;
      g.add(new THREE.Mesh(quadGeo(
        [ 0.38, 0.91, wz], [-0.52, 0.92, wz],
        [-0.94, 0.59, wz], [ 0.76, 0.59, wz]), m.glass));
    });
  } else {
    // ── COUPE (default — Audi S5) ──
    // Windshield (matches bezier control points in makeCoupeProfile)
    g.add(new THREE.Mesh(quadGeo(
      [0.30, 0.89, -hw], [0.30, 0.89,  hw],
      [0.74, 0.57,  hw], [0.74, 0.57, -hw]), m.glass));
    // Fastback rear glass
    g.add(new THREE.Mesh(quadGeo(
      [-0.34, 0.89, -hw], [-0.34, 0.89,  hw],
      [-0.95,  0.57,  hw], [-0.95,  0.57, -hw]), m.glass));
    // Side windows (one large 2-door pane each side)
    [-1, 1].forEach(side => {
      const wz = side * 0.522;
      g.add(new THREE.Mesh(quadGeo(
        [ 0.30, 0.89, wz], [-0.34, 0.89, wz],
        [-0.95, 0.57, wz], [ 0.74, 0.57, wz]), m.glass));
    });
  }
}

// ─── Multi-spoke wheel builder ─────────────────────────────────────────────────
// side: +1 = right (+z face), –1 = left (–z face)
function addWheel(g, wx, wy, wz, side, m) {
  const faceZ = wz + side * 0.118;

  // Tire
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.285, 0.285, 0.226, 36), m.tire);
  tire.rotation.x = Math.PI / 2;
  tire.position.set(wx, wy, wz);
  g.add(tire);

  // Rim barrel (visible ring between tyre and spoke face)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.258, 0.258, 0.226, 36, 1, true), m.wheel);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(wx, wy, wz);
  g.add(barrel);

  // Outer face disc (dark background)
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.224, 0.224, 0.016, 36), m.wheelDisc);
  disc.rotation.x = Math.PI / 2;
  disc.position.set(wx, wy, faceZ);
  g.add(disc);

  // 5 Y-spokes — each splits into 2 tines near the rim (machined bright aluminium)
  for (let i = 0; i < 5; i++) {
    const base = (i / 5) * Math.PI * 2 + 0.3;
    // Main spoke trunk (from hub to mid-radius)
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.120, 0.044, 0.028), m.spoke);
    trunk.position.set(wx + Math.cos(base) * 0.072, wy + Math.sin(base) * 0.072, faceZ + 0.002);
    trunk.rotation.z = base;
    g.add(trunk);
    // Two tines fanning outward
    [-0.20, 0.20].forEach(fan => {
      const ang = base + fan;
      const tine = new THREE.Mesh(new THREE.BoxGeometry(0.112, 0.030, 0.024), m.spoke);
      tine.position.set(wx + Math.cos(ang) * 0.162, wy + Math.sin(ang) * 0.162, faceZ + 0.002);
      tine.rotation.z = ang;
      g.add(tine);
    });
  }

  // Chrome centre cap
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.022, 16), m.chrome);
  cap.rotation.x = Math.PI / 2;
  cap.position.set(wx, wy, faceZ + side * 0.012);
  g.add(cap);

  // Red brake caliper (visible through spokes)
  const cal = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.09, 0.06), m.caliper);
  cal.position.set(wx, wy + 0.162, wz + side * 0.055);
  g.add(cal);
}

// ─── Full car group ───────────────────────────────────────────────────────────
function buildCarGroup(paintHex, wheelColorKey, bodyStyle) {
  const m   = makeMats(paintHex, wheelColorKey);
  const g   = new THREE.Group();
  const CAR_WIDTH = 1.05;

  // ══ BODY — ExtrudeGeometry from the correct side profile ═══════════════════
  const profileFn = bodyStyle === 'suv' ? makeSUVProfile
                  : bodyStyle === 'sedan' ? makeSedanProfile
                  : makeCoupeProfile;

  const extrudeSettings = {
    steps: 1,
    depth: CAR_WIDTH,
    bevelEnabled: true,
    bevelThickness: 0.038,
    bevelSize:      0.028,
    bevelSegments:  5,
  };
  const bodyGeo = new THREE.ExtrudeGeometry(profileFn(), extrudeSettings);
  bodyGeo.translate(0, 0, -CAR_WIDTH / 2);   // centre along Z
  g.add(new THREE.Mesh(bodyGeo, m.body));

  // ══ WINDOWS (exact BufferGeometry quads matched to profile) ════════════════
  addWindows(g, m, bodyStyle);

  // ══ BODY SIDE SILL TRIM ════════════════════════════════════════════════════
  [-1, 1].forEach(side => {
    const sill = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.050, 0.018), m.blackTrim);
    sill.position.set(0, 0.058, side * 0.545);
    g.add(sill);
  });

  // ══ DOOR CREASE LINE ═══════════════════════════════════════════════════════
  [-1, 1].forEach(side => {
    const crease = new THREE.Mesh(new THREE.BoxGeometry(2.10, 0.025, 0.014), m.body);
    crease.position.set(0, 0.36, side * 0.540);
    g.add(crease);
  });

  // ══ SIDE MIRRORS (gloss black) ════════════════════════════════════════════
  [-1, 1].forEach(side => {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.038), m.blackTrim);
    base.position.set(0.76, 0.60, side * 0.565);
    g.add(base);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.062, 0.170), m.blackTrim);
    head.position.set(0.740, 0.622, side * 0.602);
    g.add(head);
  });

  // ══ FRONT GRILLE — single-frame honeycomb (S5 style) ══════════════════════
  // Chrome outer surround
  const gSurround = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.238, 0.598), m.grilleSur);
  gSurround.position.set(1.458, 0.305, 0);
  g.add(gSurround);
  // Dark mesh fill
  const gFill = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.208, 0.562), m.grille);
  gFill.position.set(1.452, 0.305, 0);
  g.add(gFill);
  // Three horizontal bars across grille face
  [-0.072, 0, 0.072].forEach(dy => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.013, 0.540), m.grilleSur);
    bar.position.set(1.456, 0.305 + dy, 0);
    g.add(bar);
  });
  // Lower air intakes (two slots with black surrounds)
  [-1, 1].forEach(side => {
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.092, 0.210), m.grille);
    intake.position.set(1.452, 0.138, side * 0.325);
    g.add(intake);
    const intSur = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.106, 0.224), m.blackTrim);
    intSur.position.set(1.460, 0.138, side * 0.325);
    g.add(intSur);
  });

  // ══ DRL HEADLIGHTS — LED strip signature ══════════════════════════════════
  [-1, 1].forEach(side => {
    // Glass housing
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.122, 0.290), m.glass);
    housing.position.set(1.440, 0.405, side * 0.356);
    g.add(housing);
    // Primary DRL strip (upper, full width)
    const d1 = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.019, 0.252), m.drl);
    d1.position.set(1.462, 0.432, side * 0.356);
    g.add(d1);
    // Secondary strip (lower, shorter)
    const d2 = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.015, 0.172), m.drl);
    d2.position.set(1.462, 0.372, side * 0.370);
    g.add(d2);
    // Vertical inner return
    const d3 = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.065, 0.015), m.drl);
    d3.position.set(1.462, 0.402, side * 0.242);
    g.add(d3);
  });

  // ══ REAR TAIL LIGHTS — thin LED blades (Audi signature) ═══════════════════
  [-1, 1].forEach(side => {
    const t1 = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.024, 0.382), m.tailLight);
    t1.position.set(-1.448, 0.415, side * 0.255);
    g.add(t1);
    const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.018, 0.242), m.tailLight);
    t2.position.set(-1.448, 0.368, side * 0.280);
    g.add(t2);
  });

  // ══ REAR DIFFUSER + FINS ═══════════════════════════════════════════════════
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.090, 0.122, 0.938), m.blackTrim);
  diffuser.position.set(-1.452, 0.100, 0);
  g.add(diffuser);
  [-0.22, 0, 0.22].forEach(zOff => {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.106, 0.108, 0.013), m.grille);
    fin.position.set(-1.452, 0.094, zOff);
    g.add(fin);
  });

  // ══ QUAD EXHAUST TIPS (2+2 symmetric) ════════════════════════════════════
  [
    [-0.294, 0.092,  0.292], [-0.294, 0.092,  0.418],
    [-0.294, 0.092, -0.292], [-0.294, 0.092, -0.418],
  ].forEach(([ex, ey, ez]) => {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.040, 0.034, 0.145, 14), m.exhaust);
    tip.rotation.z = Math.PI / 2;
    tip.position.set(ex, ey, ez);
    g.add(tip);
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.018, 14), m.exhaustHole);
    hole.rotation.z = Math.PI / 2;
    hole.position.set(ex - 0.074, ey, ez);
    g.add(hole);
  });

  // ══ WHEELS (multi-spoke, all four corners) ════════════════════════════════
  [
    [ 0.90, 0.285,  0.555,  1],
    [ 0.90, 0.285, -0.555, -1],
    [-0.84, 0.285,  0.555,  1],
    [-0.84, 0.285, -0.555, -1],
  ].forEach(([wx, wy, wz, side]) => addWheel(g, wx, wy, wz, side, m));

  // ══ GROUND SHADOW ═════════════════════════════════════════════════════════
  const shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.55), m.shadow);
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.position.y = -0.001;
  g.add(shadowMesh);

  return g;
}

// ─── React component ──────────────────────────────────────────────────────────
export default function VehicleCanvas({ vehicleColor, wheelColor, bodyStyle }) {
  const mountRef   = useRef(null);
  const isDragging = useRef(false);
  const lastMouse  = useRef({ x: 0, y: 0 });
  // Start at 3/4 front-left view (negative Y shows front quarter panel toward camera)
  const rotation   = useRef({ y: -0.5, x: 0.06 });

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const W = el.clientWidth  || 420;
    const H = el.clientHeight || 320;

    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace    = THREE.SRGBColorSpace;
    renderer.toneMapping         = THREE.ReinhardToneMapping;
    renderer.toneMappingExposure = 2.0;
    el.appendChild(renderer.domElement);

    // ── Scene ─────────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    const car   = buildCarGroup(vehicleColor || '#4A4E52', wheelColor || 'gunmetal', bodyStyle || 'coupe');
    scene.add(car);

    // ── Studio lighting (key + front fill + cool fill + rim + top) ───────────
    const key   = new THREE.DirectionalLight(0xfff8f0, 3.5);   key.position.set(5, 6, 5);
    const front = new THREE.DirectionalLight(0xfff0e0, 2.0);   front.position.set(3, 2, 0);
    const fill  = new THREE.DirectionalLight(0xc0d0ff, 2.0);   fill.position.set(-5, 3, 2);
    const rim   = new THREE.DirectionalLight(0xffe0b0, 1.8);   rim.position.set(-3, 5, -5);
    const top   = new THREE.DirectionalLight(0xffffff, 0.80);  top.position.set(0, 10, 0);
    scene.add(key, front, fill, rim, top);
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));

    // ── Camera — 3/4 front angle ──────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
    camera.position.set(3.20, 1.80, 3.00);
    camera.lookAt(0, 0.48, 0);

    // ── Render loop ───────────────────────────────────────────────────────────
    let autoRotate = true;
    let frameId;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      if (autoRotate && !isDragging.current) rotation.current.y += 0.006;
      car.rotation.y = rotation.current.y;
      car.rotation.x = rotation.current.x;
      renderer.render(scene, camera);
    };
    animate();

    // ── Drag-to-rotate ────────────────────────────────────────────────────────
    const onDown = e => { isDragging.current = true; autoRotate = false; lastMouse.current = { x: e.clientX, y: e.clientY }; };
    const onMove = e => {
      if (!isDragging.current) return;
      rotation.current.y += (e.clientX - lastMouse.current.x) * 0.010;
      rotation.current.x  = Math.max(-0.38, Math.min(0.38, rotation.current.x + (e.clientY - lastMouse.current.y) * 0.010));
      lastMouse.current = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => { isDragging.current = false; setTimeout(() => { autoRotate = true; }, 2000); };

    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);

    // ── Resize ────────────────────────────────────────────────────────────────
    const onResize = () => {
      const nW = el.clientWidth, nH = el.clientHeight;
      if (nW && nH) { renderer.setSize(nW, nH); camera.aspect = nW / nH; camera.updateProjectionMatrix(); }
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => {
      cancelAnimationFrame(frameId);
      ro.disconnect();
      renderer.domElement.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  // Re-build the scene when any of the vehicle spec props change
  }, [vehicleColor, wheelColor, bodyStyle]);

  return <div ref={mountRef} style={{ width: '100%', height: '100%' }} />;
}
