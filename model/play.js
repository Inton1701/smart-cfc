// Hands-on simulator for the 3D chamber model: clicks on the model drive the
// simulated controller (sim.js) and the physical setup (door, water, cup,
// cyanoacrylate, test objects), with plate glow, steam, fumes, developing prints
// and beeps. The page calls startPlay() once and play.frame(dtMs) every frame.
import { createSim, createPanel, createBeeper, hints, nextStep, STEPS, currentStep, checkAction, checkKey, afterDoorClosed } from './sim.js';
import { drawOled } from './oled.js';

const NAMES = {
  power: 'Power switch', push: 'Lock button', door: 'Door', water: 'Water tray', cup: 'Foil cup',
  cyano: 'Cyanoacrylate', bottle: 'Glass bottle', glass: 'Drinking glass', oled: 'OLED display',
  inc: 'INC', dec: 'DEC', next: 'NEXT', prev: 'BEFORE', sel: 'SEL',
};

export function startPlay({ THREE, scene, camera, stage, parts, M, solid, flyTo, setView, dom }) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- state ----------
  let sim, world, speed = 10, transient = { text: '', until: 0 };
  function reset() {
    sim = createSim();
    sim.fault(dom.fault.value || null);
    world = {
      doorOpen: false, locked: true, doorT: 0, water: false, cup: false, drops: 0, cyano: 0,
      waterC: 80, fume: 0, touchedHot: false, touchedUntil: 0, cycleDone: false,
      objects: { bottle: { inside: false, exposure: 0 }, glass: { inside: false, exposure: 0 } },
    };
  }
  reset();
  const panel = createPanel(), beeper = createBeeper();
  const say = (text, ms = 3500) => { transient = { text, until: performance.now() + ms }; };

  // ---------- sound ----------
  let audio = null;
  function beep(ms, delay = 0) {
    if (!audio) return;
    const t = audio.currentTime + delay / 1000, o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square'; o.frequency.value = 2700; g.gain.value = 0.035;
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + ms / 1000);
  }

  // ---------- textures ----------
  function canvasTex(w, h, draw, nearest = false) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearFilter; }
    return t;
  }
  const puff = canvasTex(64, 64, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, w);
  });
  // Two latent prints as short ridge segments. Each segment has the exposure at which
  // the white polymer shows on it, in patches, so a print builds up the way real
  // cyanoacrylate development does instead of fading in all at once.
  const PRINT_SEGS = (() => {
    const segs = []; let seed = 7, th = 0;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [cx, cy, rot] of [[78, 64, -0.3], [176, 60, 0.25]]) for (let k = 2; k < 15; k++) {
      let prev = null, run = 0;
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.08) {
        const wob = 1 + 0.06 * Math.sin(a * 5 + k), lx = Math.cos(a) * k * 2.3 * wob, ly = Math.sin(a) * k * 3.2 * wob - (a > Math.PI ? k * 0.6 : 0);
        const x = cx + lx * Math.cos(rot) - ly * Math.sin(rot), y = cy + lx * Math.sin(rot) + ly * Math.cos(rot);
        if (run-- <= 0) { th = 0.06 + 0.8 * rnd() * (0.6 + 0.4 * k / 15); run = 3 + Math.floor(rnd() * 6); }   // patch
        const gap = Math.sin(a * 9 + k * 1.7) > 0.86;
        if (prev && !gap) segs.push([prev[0], prev[1], x, y, th]);
        prev = gap ? null : [x, y];
      }
    }
    return segs;
  })();
  function drawPrints(c, e) {
    c.clearRect(0, 0, 256, 128);
    if (e <= 0.02) return;
    const thick = Math.max(0, e - 1.1) * 3;                       // over-fumed: ridges fill in
    for (const [col, lw] of [['40,46,50', 3.4 + thick], ['255,255,255', 1.7 + thick]]) {
      c.lineWidth = lw; c.lineCap = 'round';
      for (const [x1, y1, x2, y2, th] of PRINT_SEGS) {
        if (e <= th) continue;
        c.strokeStyle = `rgba(${col},${Math.min(1, (e - th) * 5) * (col[0] === '4' ? 0.5 : 0.97)})`;
        c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      }
    }
  }
  const oledCanvas = document.createElement('canvas'); oledCanvas.width = 512; oledCanvas.height = 256;
  const oledTex = new THREE.CanvasTexture(oledCanvas);
  oledTex.colorSpace = THREE.SRGBColorSpace; oledTex.magFilter = THREE.NearestFilter;
  M.oled.map = oledTex;

  // ---------- materials ----------
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.32, roughness: 0.05,
    clearcoat: 1, side: THREE.DoubleSide, depthWrite: false });
  const bottleMat = glassMat.clone(); bottleMat.color.set(0xd2ecd8);
  const cyanoBody = new THREE.MeshStandardMaterial({ color: 0xf4f4f1, roughness: 0.5 });
  const cyanoCap = new THREE.MeshStandardMaterial({ color: 0xc8202a, roughness: 0.4 });
  const liquidMat = new THREE.MeshStandardMaterial({ color: 0xf2e7b0, roughness: 0.1, transparent: true, opacity: 0.85 });
  const fogMat = new THREE.MeshBasicMaterial({ color: 0xd9ddd8, transparent: true, opacity: 0, depthWrite: false });
  const glowMat = new THREE.SpriteMaterial({ map: puff, color: 0xff4a1a, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending });

  // ---------- particles (steam from the water, fumes from the cup) ----------
  const fx = new THREE.Group(); scene.add(fx);
  function pool(n, color, size) {
    return Array.from({ length: n }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puff, color, transparent: true, opacity: 0, depthWrite: false }));
      s.visible = false; s.userData = { life: 0, max: 1, v: V(0, 0, 0), size };
      fx.add(s); return s;
    });
  }
  const steam = pool(reduceMotion ? 10 : 36, 0xcfd9df, 1.6), fumes = pool(reduceMotion ? 20 : 120, 0xc4c8c2, 3.0);
  function emit(list, at, v, life) {
    const s = list.find(p => !p.visible); if (!s) return;
    s.position.copy(at); s.userData.v.copy(v); s.userData.life = 0; s.userData.max = life; s.visible = true;
  }

  // ---------- objects the simulator adds, rebuilt with the model ----------
  let g, plateMat, fog, glow, items, liquid, clickables, keypadMesh, oledMesh;
  function attach() {
    g = parts.geom;
    const { chamber, lock, roofPod, btnTop, plate } = parts;
    chamber.add(roofPod, btnTop);                  // roof half of the lock stays when the door comes off
    plateMat?.dispose();                                 // size change: free the previous build's materials
    for (const it of Object.values(items ?? {})) for (const c of it.children) if (c.userData.print) { c.material.map.dispose(); c.material.dispose(); }
    plateMat = M.alu.clone(); plate.material = plateMat;
    fog = new THREE.Mesh(new THREE.BoxGeometry(g.W - 1, g.H - 1, g.D - 1), fogMat);
    fog.position.set(0, g.floorY + g.H / 2, 0); fog.renderOrder = 2; chamber.add(fog);
    glow = new THREE.Sprite(glowMat); glow.raycast = () => {};   // light, not a thing to click
    glow.scale.set(g.padW * 1.8, g.padD * 1.2, 1);
    glow.position.set(g.px, g.plateTop + 0.6, g.pz); chamber.add(glow);
    liquid = solid(new THREE.CylinderGeometry(1.2, 1.2, 0.08, 24), liquidMat, 0, 0.1, 0); parts.cup.add(liquid);

    const bottle = new THREE.Group();
    const prof = [[0, 0], [2.3, 0], [2.4, 0.4], [2.4, 8.2], [1.9, 9.4], [0.95, 10.4], [0.9, 12.2], [1.05, 12.4], [1.05, 12.8]].map(([r, y]) => new THREE.Vector2(r, y));
    bottle.add(solid(new THREE.LatheGeometry(prof, 40), bottleMat));
    bottle.add(printDecal(new THREE.CylinderGeometry(2.43, 2.43, 4.6, 32, 1, true, -0.75, 1.5), 4.6));
    const glass = new THREE.Group();
    glass.add(solid(new THREE.CylinderGeometry(2.3, 1.9, 8, 40, 1, true), glassMat, 0, 4, 0));
    glass.add(solid(new THREE.CircleGeometry(1.9, 40).rotateX(-Math.PI / 2), glassMat, 0, 0.15, 0));
    glass.add(printDecal(new THREE.CylinderGeometry(2.16, 2.07, 4.0, 32, 1, true, -0.75, 1.5), 4.4));
    const cyano = new THREE.Group();
    cyano.add(solid(new THREE.CylinderGeometry(1.1, 1.2, 4.2, 24), cyanoBody, 0, 2.1, 0));
    cyano.add(solid(new THREE.CylinderGeometry(0.5, 0.9, 1.0, 20), cyanoBody, 0, 4.7, 0));
    cyano.add(solid(new THREE.ConeGeometry(0.28, 1.6, 16), cyanoCap, 0, 6.0, 0));
    chamber.add(bottle, glass, cyano);
    items = { bottle, glass, cyano };

    keypadMesh = parts.keypad; oledMesh = parts.oled;
    clickables = new Map([[parts.power, 'power'], [btnTop, 'push'], [parts.btnLow, 'push'], [parts.door, 'door'],
      [parts.water, 'water'], [parts.cup, 'cup'], [cyano, 'cyano'], [bottle, 'bottle'], [glass, 'glass'],
      [keypadMesh, 'keypad'], [oledMesh, 'oled']]);
    place(true);
  }
  function printDecal(geo, y) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }));
    m.position.y = y; m.userData = { print: true, ctx: c.getContext('2d'), step: -1 }; return m;
  }

  // Bench (outside, on the table) and inside positions, chamber coordinates.
  const bench = () => ({
    glass: V(-g.W / 2 - 7, 0, g.front - 11), bottle: V(-g.W / 2 - 7, 0, g.front - 4), water: V(-g.W / 2 - 7, 0, g.front + 3),
    cup: V(g.W / 2 + 6, 0, g.front - 6), cyano: V(g.W / 2 + 6, 0, g.front + 1),
  });
  const grillTop = () => g.gTop + 3 * g.wr;
  const inside = () => ({
    water: g.trayPos, cup: g.cupPos,
    bottle: V(g.gx - 3, grillTop(), g.gz + g.hz - 5), glass: V(g.gx + 5, grillTop(), g.gz + g.hz - 5),
  });
  function place(instant) {
    const b = bench(), i = inside();
    parts.water.position.copy(world.water ? i.water : b.water);
    parts.cup.position.copy(world.cup ? i.cup : b.cup);
    items.cyano.position.copy(b.cyano);
    for (const k of ['bottle', 'glass']) items[k].position.copy(world.objects[k].inside ? i[k] : b[k]);
    parts.water.visible = parts.cup.visible = true;
    if (instant) world.doorT = world.doorOpen ? 1 : 0;
  }

  // ---------- actions ----------
  const needOpen = () => { if (world.doorOpen) return true; say(world.locked ? 'Door locked: press PUSH, then open the door' : 'Open the door first'); return false; };
  const plateHot = () => sim.snap().padC >= 45;
  function touchHot() { world.touchedHot = true; world.touchedUntil = performance.now() + 5000; say('Too hot to touch: let the plate cool'); }
  const ACT = {
    power() {
      const on = !sim.snap().on; sim.power(on);
      if (on) { beep(120, 0); beep(120, 240); }
    },
    push() {
      if (world.doorOpen) return say('Put the door back first');
      world.locked = !world.locked; say(world.locked ? 'Door locked' : 'Door unlocked', 1800);
    },
    door() {
      if (!world.doorOpen && world.locked) return say('Door locked: press PUSH first');
      world.doorOpen = !world.doorOpen;
      if (world.doorOpen) world.locked = false;
    },
    water() {
      if (!needOpen()) return;
      world.water = !world.water;
      if (world.water) world.waterC = 80;              // freshly poured hot water
      place();
    },
    cup() {
      if (!needOpen()) return;
      if (world.cup && plateHot()) return touchHot();
      world.cup = !world.cup;
      if (!world.cup) { world.drops = 0; world.cyano = 0; }
      place();
    },
    cyano() {
      if (!needOpen()) return;
      if (!world.cup) return say('Put the foil cup on the heating plate first');
      if (world.drops >= 8) return say('Enough cyanoacrylate: 3 to 5 drops is plenty');
      world.drops++; world.cyano++; say(`${world.drops} drop${world.drops > 1 ? 's' : ''} of cyanoacrylate in the cup`, 1800);
    },
    object(k) {
      if (!needOpen()) return;
      const o = world.objects[k]; o.inside = !o.inside; place();
      if (!o.inside && o.exposure > 0.05) {
        const e = o.exposure, q = e < 0.35 ? 'faint' : e < 0.7 ? 'developing' : e < 1.5 ? 'good, clear ridges' : 'over-fumed, ridges filled in';
        say(`${NAMES[k]}: prints ${q}`, 5000);
      }
    },
  };

  // ---------- warnings ----------
  // A popup that pauses the simulator. Buttons: [label, fn|null]; the first is the default.
  let dialogOpen = false;
  function ask(w, first, second) {
    dialogOpen = true;
    dom.dlgTitle.textContent = w.title; dom.dlgText.textContent = w.text;
    const wire = (btn, [label, fn]) => { btn.textContent = label; btn.onclick = () => { close(); fn?.(); }; };
    wire(dom.dlgOk, first); wire(dom.dlgAlt, second);
    dom.dlg.hidden = false; dom.dlgOk.focus();
  }
  function close() { dom.dlg.hidden = true; dialogOpen = false; }
  dom.dlg.addEventListener('keydown', e => { if (e.key === 'Escape') dom.dlgOk.click(); });
  const view = () => ({ ...world, objectsInside: Object.values(world.objects).filter(o => o.inside).length });
  function run(k) {
    const wasOpen = world.doorOpen;
    if (k === 'bottle' || k === 'glass') ACT.object(k); else ACT[k]?.();
    if (k === 'door' && wasOpen && !world.doorOpen) {
      const w = afterDoorClosed(view(), sim.snap());
      if (w) ask(w, ['Lock it', () => { world.locked = true; say('Door locked', 1800); }], ['Leave unlocked', null]);
    }
  }
  function tryAct(k) {
    const w = checkAction(k, view(), sim.snap());
    if (w) ask(w, ['Go back', null], ['Do it anyway', () => run(k)]);
    else run(k);
  }

  // ---------- auto camera: frame the part the current step needs ----------
  const wpos = o => o.getWorldPosition(V(0, 0, 0));
  function frameStep(i) {
    const mid = (a, b) => wpos(a).add(wpos(b)).multiplyScalar(0.5);
    const look = (t, off) => flyTo(t.clone().add(off), t);
    switch (i) {
      case 0: return look(wpos(parts.power), V(16, 9, -34));                       // power switch, back of the controller
      case 1: return look(wpos(parts.btnLow), V(14, 4, 38));                       // lock and door
      case 2: return look(mid(items.bottle, parts.grill).add(V(0, 3, 0)), V(-12, 24, 50));
      case 3: case 10: case -1: { const t = controlsPos(); return look(t, V(0, 2.5, 22)); }   // keypad + OLED
      case 4: return look(mid(parts.water, parts.grill).add(V(0, 3, 0)), V(-12, 24, 50));
      case 5: return look(mid(parts.cup, parts.pad).add(V(0, 3, 0)), V(14, 24, 46));
      case 6: case 8: return setView('front');
      case 7: return look(wpos(parts.cup), V(12, 16, 32));
      case 9: return setView('iso');
      case 11: return look(mid(items.bottle, items.glass).add(V(0, 4, 0)), V(-6, 10, 34));
    }
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  ray.params.Line.threshold = 0.05;                     // edge outlines must not swallow clicks
  function pick(e) {
    const r = stage.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    let doorHit = null;
    for (const h of ray.intersectObject(parts.chamber.parent, true)) {
      let kind = null;
      for (let o = h.object; o && !kind; o = o.parent) kind = clickables.get(o) ?? null;
      if (kind === 'door') { if (world.doorOpen) { doorHit ??= { kind, h }; continue; } return { kind, h }; }
      if (kind) return { kind, h };
      const m = h.object.material;
      if (h.object.userData.print || (m && m.transparent && m.opacity < 0.5)) continue;   // see-through: keep looking
      break;                                                                            // solid, not clickable
    }
    return doorHit;
  }
  function keyAt(h) {
    if (!h.uv || h.face?.materialIndex !== 4) return null;
    const dx = h.uv.x - 0.5, dy = h.uv.y - 0.5;
    if (Math.hypot(dx, dy) < 0.14) return 'sel';
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'next' : 'prev') : (dy > 0 ? 'inc' : 'dec');
  }
  const controlsPos = () => keypadMesh.getWorldPosition(V(0, 0, 0)).add(oledMesh.getWorldPosition(V(0, 0, 0))).multiplyScalar(0.5);
  const near = () => camera.position.distanceTo(controlsPos()) < 40;

  // One key at a time, tied to the pointer (finger) that pressed it.
  let down = null, heldKey = null, heldPointer = null;
  // Audio may only start from a real user gesture: a touch pointerdown is not one, a pointerup is.
  const wakeAudio = () => {
    if (!audio) try { audio = new AudioContext(); } catch (_) { audio = null; }
    if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
  };
  const onDown = e => {
    if (e.button !== 0) return;
    wakeAudio();
    const p = pick(e); if (!p) return;
    if (p.kind === 'keypad' || p.kind === 'oled') {
      e.stopPropagation(); e.preventDefault();
      if (heldKey) return;                                  // a second finger on the keypad is ignored
      if (!near()) { const t = controlsPos(); flyTo(t.clone().add(V(0, 2.5, 22)), t); return; }
      const k = p.kind === 'keypad' && keyAt(p.h);
      if (k) {
        heldKey = k; heldPointer = e.pointerId; panel.key(k, true, performance.now());
        keypadMesh.position.z -= 0.04; stage.setPointerCapture(e.pointerId);
      }
      return;
    }
    down = { kind: p.kind, x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  // cancelled: the OS took the touch away; let go of the key without it counting as a tap.
  const release = (cancelled = false) => {
    if (!heldKey) return;
    if (cancelled) panel.cancel(heldKey); else panel.key(heldKey, false, performance.now());
    keypadMesh.position.z += 0.04; heldKey = null; heldPointer = null;
  };
  const onUp = e => {
    wakeAudio();
    if (heldKey) { if (e.pointerId === heldPointer) release(); return; }
    if (down && down.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) tryAct(down.kind);
    down = null;
  };
  const onCancel = e => { if (e.pointerId === heldPointer) release(true); if (down?.id === e.pointerId) down = null; };
  let hoverAt = 0;
  const onMove = e => {
    if (e.buttons || performance.now() - hoverAt < 60) return;
    hoverAt = performance.now();
    const p = pick(e);
    const name = p ? (p.kind === 'keypad' ? NAMES[keyAt(p.h)] ?? 'Keypad' : NAMES[p.kind]) : '';
    stage.style.cursor = p ? 'pointer' : '';
    dom.tip.hidden = !name; dom.tip.textContent = name;
    const r = stage.getBoundingClientRect();
    dom.tip.style.left = `${e.clientX - r.left + 14}px`; dom.tip.style.top = `${e.clientY - r.top + 10}px`;
  };
  const onLeave = () => { dom.tip.hidden = true; };
  const noMenu = e => e.preventDefault();
  stage.addEventListener('pointerdown', onDown, true);
  stage.addEventListener('pointerup', onUp, true);
  stage.addEventListener('pointercancel', onCancel, true);
  stage.addEventListener('lostpointercapture', onCancel);
  window.addEventListener('blur', () => release(true));
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerleave', onLeave);
  stage.addEventListener('contextmenu', noMenu);

  // ---------- sidebar ----------
  dom.speed.forEach(b => b.addEventListener('click', () => {
    speed = +b.dataset.speed; dom.speed.forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  }));
  dom.fault.addEventListener('change', () => sim.fault(dom.fault.value || null));
  dom.reset.addEventListener('click', () => { reset(); place(true); lastStep = null; });

  // ---------- per frame ----------
  const tmp = V(0, 0, 0), up = V(0, 1, 0);
  let lastOled = -1, lastUi = 0, lastStep = null, prevState = 'Off';
  function frame(dtMs) {
    const now = performance.now(), dt = dialogOpen ? 0 : Math.min(dtMs, 250), simDt = dt * speed / 1000;
    const { ev, click } = panel.poll(now);
    if (!dialogOpen) {                                   // a warning popup pauses everything
      const w = checkKey(ev, view(), sim.snap());
      if (w) ask(w, ['Go back', null], ['Do it anyway', () => sim.input(ev)]);
      else sim.input(ev);
      sim.advance(dt, speed);
    }
    const s = sim.snap();
    if (prevState === 'Ready' && s.state === 'Idle') say('STEP 4 ended: heater off. Nobody pressed a key for 10 min (or SEL was held). Start again.', 7000);
    prevState = s.state;
    if (s.state === 'Complete') world.cycleDone = true;
    if (s.state === 'StepWater') world.cycleDone = false;
    const step = currentStep(view(), s);
    if (step !== lastStep) {
      lastStep = step;
      if (dom.autoCam.checked && !down && !heldKey && step < STEPS.length) frameStep(step);
    }
    for (const ms of beeper.update(s.on && !s.booting ? s.state : 'Off', now, click && s.on && !s.booting)) beep(ms);
    if (world.touchedHot && now > world.touchedUntil) world.touchedHot = false;

    // Door: hinged along its bottom edge, drops forward to lie flat (like an oven door).
    world.doorT += ((world.doorOpen ? 1 : 0) - world.doorT) * (reduceMotion ? 1 : Math.min(1, dt / 120));
    const a = world.doorT * Math.PI / 2, hinge = V(0, g.floorY, g.front);
    const exZ = parts.door.position.z * (world.doorT === 0 ? 1 : 0);   // exploded view pulls the closed door forward
    parts.door.rotation.x = a;
    parts.door.position.copy(hinge).sub(hinge.clone().applyAxisAngle(V(1, 0, 0), a));
    parts.door.position.z += exZ;
    parts.lock.position.y = world.locked ? 0 : 0.5;
    parts.rocker.rotation.x = s.on ? -0.22 : 0.22;

    // Water cools toward the chamber air; cyanoacrylate evaporates off the hot plate.
    const air = 30 + 0.05 * (s.padC - 30);
    world.waterC += (air - world.waterC) * simDt / 1500;
    const evap = world.cyano > 0 && world.cup ? 0.006 * Math.min(1.5, Math.max(0, (s.padC - 90) / 40)) : 0;
    world.cyano = Math.max(0, world.cyano - evap * simDt);
    const tau = world.doorOpen ? 20 : 300;
    world.fume = Math.min(1, Math.max(0, world.fume + (evap * 0.55 - world.fume / tau) * simDt));
    const humid = world.water && world.waterC > 40 ? 1 : 0.45;
    for (const o of Object.values(world.objects)) if (o.inside) o.exposure += world.fume * humid * simDt / 650;   // ~1.0 after a 20 min cycle with 4 drops and hot water

    // Visuals.
    const t = Math.min(1, Math.max(0, (s.padC - 45) / 120));
    plateMat.color.setRGB(0.83 - 0.2 * t, 0.85 - 0.6 * t, 0.86 - 0.7 * t);
    plateMat.emissive.setRGB(t, 0.16 * t, 0.04 * t); plateMat.emissiveIntensity = 0.2 + 1.3 * t;
    glowMat.opacity = 0.55 * t;
    fogMat.opacity = 0.42 * world.fume;
    liquid.visible = world.cyano > 0.05; liquid.scale.setScalar(0.5 + Math.min(1, world.cyano / 5) * 0.6);
    for (const k of ['bottle', 'glass']) {
      const d = items[k].children.find(c => c.userData.print).userData, step = Math.round(world.objects[k].exposure * 60);
      if (step !== d.step) { d.step = step; drawPrints(d.ctx, world.objects[k].exposure); items[k].children.find(c => c.userData.print).material.map.needsUpdate = true; }
    }
    updateParticles(dt, s, evap);

    // OLED at the firmware's 4 frames per second.
    const f = Math.floor(now / 250);
    if (f !== lastOled) { lastOled = f; drawOled(oledCanvas.getContext('2d'), s, f); oledTex.needsUpdate = true; }

    if (now - lastUi > 250) { lastUi = now; ui(s); }
  }
  function updateParticles(dt, s, evap) {
    const secs = dt / 1000;
    const heat = Math.min(1, Math.max(0, (world.waterC - 35) / 45));
    if (Math.random() < heat * secs * (reduceMotion ? 3 : 14)) {
      parts.water.getWorldPosition(tmp).add(V((Math.random() - 0.5) * 4, 1.9, (Math.random() - 0.5) * 4));
      emit(steam, tmp, V((Math.random() - 0.5) * 0.4, 1.8 + Math.random(), (Math.random() - 0.5) * 0.4), 2.2);
    }
    if (Math.random() < Math.min(1, evap * 400) * secs * (reduceMotion ? 8 : 55)) {
      parts.cup.getWorldPosition(tmp).add(V((Math.random() - 0.5) * 2, 1.2, (Math.random() - 0.5) * 2));
      emit(fumes, tmp, V((Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 1.2, (Math.random() - 0.5) * 0.8), 9);
    }
    const top = g.topY - 1.5, frontZ = g.front;
    for (const list of [steam, fumes]) for (const p of list) {
      if (!p.visible) continue;
      const u = p.userData; u.life += secs;
      if (u.life >= u.max) { p.visible = false; continue; }
      p.position.addScaledVector(u.v, secs);
      if (list === fumes) {
        const sw = p.id * 0.7;                                       // swirl: each puff curls its own way
        u.v.x += Math.sin(u.life * 1.6 + sw) * 1.1 * secs; u.v.z += Math.cos(u.life * 1.3 + sw) * 1.1 * secs;
        if (world.doorOpen) u.v.z += 2.5 * secs;                      // pours out the front
        else if (p.position.z > frontZ - 1) u.v.z = -Math.abs(u.v.z);
        if (p.position.y > top && !world.doorOpen) { p.position.y = top; u.v.y = 0; u.v.x += (Math.random() - 0.5) * secs * 4; }
      }
      const k = u.life / u.max;
      p.material.opacity = (list === fumes ? 0.55 : 0.6) * Math.sin(Math.PI * k);
      p.scale.setScalar(u.size * (0.6 + k * 1.8));
    }
  }
  function ui(s) {
    const w = view();
    const lines = hints(w, s);
    if (transient.text && performance.now() < transient.until) lines.unshift(transient.text);
    dom.next.textContent = nextStep(w, s);
    const cur = currentStep(w, s);
    if (cur !== dom.steps.dataset.cur) {
      dom.steps.dataset.cur = cur;
      dom.steps.replaceChildren(...STEPS.map((t, i) => {
        const li = document.createElement('li'); li.textContent = t;
        li.className = cur >= STEPS.length || i < cur ? 'done' : i === cur ? 'cur' : '';
        if (i === cur) li.setAttribute('aria-current', 'step');
        return li;
      }));
    }
    dom.coach.replaceChildren(...lines.map(l => Object.assign(document.createElement('li'), { textContent: l })));
    dom.coach.hidden = lines.length === 0;
    const pr = Object.entries(world.objects).map(([k, o]) => `${NAMES[k]} ${Math.round(Math.min(2, o.exposure) * 100)} %`).join(' · ');
    dom.readout.textContent = `Plate ${s.padC.toFixed(0)} °C · Probe ${s.on ? s.tempC.toFixed(1) : '--'} °C · ` +
      `Water ${world.water ? world.waterC.toFixed(0) + ' °C' : 'out'} · Fumes ${Math.round(world.fume * 100)} % · Prints: ${pr}`;
  }

  attach();
  return {
    frame,
    attach,                                   // after a size change rebuilt the model
    // Fly the camera close to the two test objects to watch the prints develop.
    closeUp() {
      const t = items.bottle.getWorldPosition(V(0, 0, 0)).add(items.glass.getWorldPosition(V(0, 0, 0))).multiplyScalar(0.5).add(V(0, 5, 0));
      flyTo(t.clone().add(V(0, 2, 20)), t);
    },
    // For scripted checks: click a part by kind, press/release a key, read state.
    act(kind) { tryAct(kind); },
    key(name, isDown) { panel.key(name, isDown, performance.now()); },
    state: () => ({ snap: sim.snap(), world: JSON.parse(JSON.stringify(world)), next: dom.next.textContent }),
    setSpeed(x) { speed = x; },
  };
}
