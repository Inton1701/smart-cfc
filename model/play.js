// Hands-on simulator for the 3D chamber model: clicks on the model drive the
// simulated controller (sim.js) and the physical setup (door, water, cup,
// cyanoacrylate, test objects), with plate glow, steam, fumes, developing prints
// and beeps. The page calls startPlay() once and play.frame(dtMs) every frame.
import { createSim, createPanel, createBeeper, hints, nextStep } from './sim.js';
import { drawOled } from './oled.js';

const NAMES = {
  power: 'Power switch', push: 'Lock button', door: 'Door', water: 'Water tray', cup: 'Foil cup',
  cyano: 'Cyanoacrylate', bottle: 'Glass bottle', glass: 'Drinking glass', oled: 'OLED display',
  inc: 'INC', dec: 'DEC', next: 'NEXT', prev: 'BEFORE', sel: 'SEL',
};

export function startPlay({ THREE, scene, camera, stage, parts, M, solid, flyTo, dom }) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- state ----------
  let sim, world, speed = 10, transient = { text: '', until: 0 };
  function reset() {
    sim = createSim();
    sim.fault(dom.fault.value || null);
    world = {
      doorOpen: false, locked: true, doorT: 0, water: false, cup: false, drops: 0, cyano: 0,
      waterC: 80, fume: 0, touchedHot: false, touchedUntil: 0,
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
  // Two latent prints, white ridges on clear: the decal on each test object.
  const printTex = canvasTex(256, 128, (c) => {

    for (const [cx, cy, rot] of [[78, 64, -0.3], [176, 60, 0.25]]) {
      c.save(); c.translate(cx, cy); c.rotate(rot);
      for (const [col, lw] of [['rgba(40,46,50,0.55)', 3.6], ['rgba(255,255,255,0.97)', 1.8]]) for (let k = 2; k < 15; k++) {
        c.strokeStyle = col; c.lineWidth = lw;
        c.beginPath();
        for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.08) {
          const wob = 1 + 0.06 * Math.sin(a * 5 + k), rx = k * 2.3 * wob, ry = k * 3.2 * wob;
          const x = Math.cos(a) * rx, y = Math.sin(a) * ry - (a > Math.PI ? k * 0.6 : 0);
          if (Math.sin(a * 9 + k * 1.7) > 0.86) { c.stroke(); c.beginPath(); c.moveTo(x, y); continue; }
          a === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
        }
        c.stroke();
      }
      c.restore();
    }
  });
  const oledCanvas = document.createElement('canvas'); oledCanvas.width = 512; oledCanvas.height = 256;
  const oledTex = new THREE.CanvasTexture(oledCanvas);
  oledTex.colorSpace = THREE.SRGBColorSpace; oledTex.magFilter = THREE.NearestFilter;
  const staticOled = M.oled.map;
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
  const steam = pool(reduceMotion ? 10 : 36, 0xcfd9df, 1.6), fumes = pool(reduceMotion ? 16 : 70, 0xc4c8c2, 2.6);
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
    plateMat = M.alu.clone(); plate.material = plateMat;
    fog = new THREE.Mesh(new THREE.BoxGeometry(g.W - 1, g.H - 1, g.D - 1), fogMat);
    fog.position.set(0, g.floorY + g.H / 2, 0); fog.renderOrder = 2; chamber.add(fog);
    glow = new THREE.Sprite(glowMat); glow.scale.set(g.padW * 1.8, g.padD * 1.2, 1);
    glow.position.set(g.px, g.plateTop + 0.6, g.pz); chamber.add(glow);
    liquid = solid(new THREE.CylinderGeometry(1.2, 1.2, 0.08, 24), liquidMat, 0, 0.1, 0); parts.cup.add(liquid);

    const bottle = new THREE.Group();
    const prof = [[0, 0], [2.3, 0], [2.4, 0.4], [2.4, 8.2], [1.9, 9.4], [0.95, 10.4], [0.9, 12.2], [1.05, 12.4], [1.05, 12.8]].map(([r, y]) => new THREE.Vector2(r, y));
    bottle.add(solid(new THREE.LatheGeometry(prof, 40), bottleMat));
    bottle.add(printDecal(new THREE.CylinderGeometry(2.43, 2.43, 4.2, 32, 1, true, -0.55, 1.1), 4.6));
    const glass = new THREE.Group();
    glass.add(solid(new THREE.CylinderGeometry(2.3, 1.9, 8, 40, 1, true), glassMat, 0, 4, 0));
    glass.add(solid(new THREE.CircleGeometry(1.9, 40).rotateX(-Math.PI / 2), glassMat, 0, 0.15, 0));
    glass.add(printDecal(new THREE.CylinderGeometry(2.16, 2.07, 3.6, 32, 1, true, -0.55, 1.1), 4.4));
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
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: printTex, transparent: true, opacity: 0, depthWrite: false }));
    m.position.y = y; m.userData.print = true; return m;
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
      if (world.doorOpen && sim.snap().state === 'Running') say('Fumes escaping: close the door');
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

  // ---------- picking ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
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

  let down = null, heldKey = null;
  const onDown = e => {
    if (e.button !== 0) return;
    if (!audio) try { audio = new AudioContext(); } catch (_) { audio = null; }
    const p = pick(e); if (!p) return;
    if (p.kind === 'keypad' || p.kind === 'oled') {
      e.stopPropagation(); e.preventDefault();
      if (!near()) { const t = controlsPos(); flyTo(t.clone().add(V(0, 2.5, 22)), t); return; }
      const k = p.kind === 'keypad' && keyAt(p.h);
      if (k) { heldKey = k; panel.key(k, true, performance.now()); keypadMesh.position.z -= 0.04; stage.setPointerCapture(e.pointerId); }
      return;
    }
    down = { kind: p.kind, x: e.clientX, y: e.clientY };
  };
  const release = () => {
    if (heldKey) { panel.key(heldKey, false, performance.now()); keypadMesh.position.z += 0.04; heldKey = null; }
  };
  const onUp = e => {
    if (heldKey) return release();
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
      const k = down.kind;
      if (k === 'bottle' || k === 'glass') ACT.object(k); else ACT[k]?.();
    }
    down = null;
  };
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
  stage.addEventListener('pointercancel', release, true);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerleave', onLeave);
  stage.addEventListener('contextmenu', noMenu);

  // ---------- sidebar ----------
  dom.speed.forEach(b => b.addEventListener('click', () => {
    speed = +b.dataset.speed; dom.speed.forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  }));
  dom.fault.addEventListener('change', () => sim.fault(dom.fault.value || null));
  dom.reset.addEventListener('click', () => { reset(); place(true); });

  // ---------- per frame ----------
  const tmp = V(0, 0, 0), up = V(0, 1, 0);
  let lastOled = -1, lastUi = 0;
  function frame(dtMs) {
    const now = performance.now(), dt = Math.min(dtMs, 250), simDt = dt * speed / 1000;
    const { ev, click } = panel.poll(now);
    sim.input(ev);
    sim.advance(dt, speed);
    const s = sim.snap();
    for (const ms of beeper.update(s.on && !s.booting ? s.state : 'Off', now, click && s.on)) beep(ms);
    if (world.touchedHot && now > world.touchedUntil) world.touchedHot = false;

    // Door: hinged along its bottom edge, drops forward to lie flat (like an oven door).
    world.doorT += ((world.doorOpen ? 1 : 0) - world.doorT) * (reduceMotion ? 1 : Math.min(1, dt / 120));
    const a = world.doorT * Math.PI / 2, hinge = V(0, g.floorY, g.front);
    parts.door.rotation.x = a;
    parts.door.position.copy(hinge).sub(hinge.clone().applyAxisAngle(V(1, 0, 0), a));
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
      const decal = items[k].children.find(c => c.userData.print);
      decal.material.opacity = Math.min(1, world.objects[k].exposure) * 0.9;
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
    if (Math.random() < Math.min(1, evap * 400) * secs * (reduceMotion ? 6 : 30)) {
      parts.cup.getWorldPosition(tmp).add(V((Math.random() - 0.5) * 2, 1.2, (Math.random() - 0.5) * 2));
      emit(fumes, tmp, V((Math.random() - 0.5) * 0.8, 1.2 + Math.random() * 0.8, (Math.random() - 0.5) * 0.8), 6);
    }
    const top = g.topY - 1.5, frontZ = g.front;
    for (const list of [steam, fumes]) for (const p of list) {
      if (!p.visible) continue;
      const u = p.userData; u.life += secs;
      if (u.life >= u.max) { p.visible = false; continue; }
      p.position.addScaledVector(u.v, secs);
      if (list === fumes) {
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
    const w = { ...world, objectsInside: Object.values(world.objects).filter(o => o.inside).length };
    const lines = hints(w, s);
    if (transient.text && performance.now() < transient.until) lines.unshift(transient.text);
    dom.next.textContent = nextStep(w, s);
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
    stop() { M.oled.map = staticOled; scene.remove(fx); },
    // For scripted checks: click a part by kind, press/release a key, read state.
    act(kind) { (kind === 'bottle' || kind === 'glass') ? ACT.object(kind) : ACT[kind](); },
    key(name, isDown) { panel.key(name, isDown, performance.now()); },
    state: () => ({ snap: sim.snap(), world: JSON.parse(JSON.stringify(world)), next: dom.next.textContent }),
    setSpeed(x) { speed = x; },
  };
}
