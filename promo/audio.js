// Procedural score + sound design for the Great Plan promo.
// Music (pads, bass, arpeggio, drone) and every sound effect are driven by window.__cues,
// which index.html builds in output time. Fully deterministic (seeded noise), 48 kHz stereo.
(() => {
  'use strict';
  const SR = 48000;

  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const CHORDS = {
    C: [48, 55, 59, 62, 64],
    Am: [45, 52, 55, 59, 60],
    F: [41, 48, 52, 55, 57],
    G: [43, 50, 52, 57, 60],
    Em: [40, 47, 50, 54, 55],
  };

  async function renderScore() {
    const cues = window.__cues;
    const DUR = cues.duration;
    const beat = 60 / cues.bpm;
    const ctx = new OfflineAudioContext(2, Math.round(SR * DUR), SR);
    const rand = mulberry32(20261108);

    // ---- buses ----
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.008; comp.release.value = 0.28; comp.knee.value = 10;
    const master = ctx.createGain(); master.gain.value = 0.9;
    master.connect(comp); comp.connect(ctx.destination);
    master.gain.setValueAtTime(0.9, DUR - 1.8);
    master.gain.linearRampToValueAtTime(0.0, DUR - 0.03);

    const ir = ctx.createBuffer(2, Math.round(SR * 3.6), SR);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = (rand() * 2 - 1) * Math.pow(1 - i / d.length, 3.4);
    }
    const verb = ctx.createConvolver(); verb.buffer = ir;
    const verbOut = ctx.createGain(); verbOut.gain.value = 0.42;
    verb.connect(verbOut); verbOut.connect(master);

    const noise = ctx.createBuffer(1, SR * 2, SR);
    { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1; }

    const send = (node, dry, wet) => {
      const g1 = ctx.createGain(); g1.gain.value = dry; node.connect(g1); g1.connect(master);
      const g2 = ctx.createGain(); g2.gain.value = wet; node.connect(g2); g2.connect(verb);
    };
    // input gain → (pan) → dry/wet
    const out = (dry = 0.8, wet = 0.4, pan = 0) => {
      const g = ctx.createGain();
      if (pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); send(p, dry, wet); } else send(g, dry, wet);
      return g;
    };
    const gainEnv = (dest, t, a, peak, d) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
      g.connect(dest); return g;
    };
    const osc = (type, f, t0, t1, dest, detune = 0) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune;
      o.connect(dest); o.start(t0); o.stop(Math.min(DUR, t1)); return o;
    };
    const noiseSrc = (t0, t1, dest) => {
      const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.connect(dest);
      s.start(t0, rand() * 1.5); s.stop(Math.min(DUR, t1)); return s;
    };
    const filt = (type, f, q, dest) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.connect(dest); return b; };
    const ok = (t) => t >= 0 && t < DUR;

    // ================= music =================
    const prog = cues.prog;
    const chordAt = (t) => { let c = prog[0][1]; for (const [s, n] of prog) if (t >= s) c = n; return CHORDS[c]; };

    const padLP = ctx.createBiquadFilter(); padLP.type = 'lowpass'; padLP.Q.value = 0.4;
    padLP.frequency.setValueAtTime(cues.cutoff[0][1], 0);
    for (const [t, f] of cues.cutoff.slice(1)) padLP.frequency.exponentialRampToValueAtTime(f, t);
    const padBus = ctx.createGain(); padBus.gain.value = 1; padBus.connect(padLP); send(padLP, 0.75, 0.55);

    prog.forEach(([start, name], idx) => {
      const end = idx < prog.length - 1 ? prog[idx + 1][0] : DUR;
      const notes = CHORDS[name];
      notes.forEach((m, j) => {
        const g = ctx.createGain();
        const level = 0.03 * (j === 0 ? 1.15 : 1);
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(level, start + (idx === 0 ? 2.4 : Math.min(1.2, (end - start) * 0.5)));
        g.gain.setValueAtTime(level, end);
        g.gain.linearRampToValueAtTime(0, Math.min(DUR, end + 2.2));
        g.connect(padBus);
        [['triangle', -7, 0.6], ['sine', 7, 0.6], ['sawtooth', 0, 0.16]].forEach(([type, cents, amp]) => {
          const og = ctx.createGain(); og.gain.value = amp; og.connect(g);
          osc(type, mtof(m), start, end + 2.3, og, cents);
        });
      });
      if (start >= cues.bassFrom) {
        const dark = start >= cues.dark[0] && start < cues.dark[1];
        const lvl = dark ? 0.15 : 0.1;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(lvl, start + 0.5);
        g.gain.setValueAtTime(lvl, Math.max(start + 0.5, end - 0.2)); g.gain.linearRampToValueAtTime(0, Math.min(DUR, end + 0.5));
        g.connect(master);
        osc('sine', mtof(notes[0] - 12), start, end + 0.6, g);
      }
    });

    // arpeggio
    const delay = ctx.createDelay(1); delay.delayTime.value = beat * 0.75;
    const fb = ctx.createGain(); fb.gain.value = 0.3;
    const dLP = filt('lowpass', 2600, 0.7, fb); delay.connect(dLP); fb.connect(delay);
    const dOut = ctx.createGain(); dOut.gain.value = 0.32; dLP.connect(dOut); dOut.connect(master);
    const arpBus = ctx.createGain(); send(arpBus, 0.8, 0.35); arpBus.connect(delay);
    const pluckTo = (dest, t, m, lvl, pan, decay = 0.7) => {
      const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(dest);
      const g = gainEnv(p, t, 0.006, lvl, decay);
      osc('sine', mtof(m), t, t + decay + 0.05, g);
      const g2 = ctx.createGain(); g2.gain.value = 0.18; g2.connect(g);
      osc('triangle', mtof(m) * 2, t, t + decay + 0.05, g2);
    };
    const pattern = [0, 2, 4, 3, 1, 4, 2, 3];
    for (const [a, b] of cues.arp) {
      for (let t = a, i = 0; t < b; t += beat / 2, i++) {
        const notes = chordAt(t);
        const m = notes[1 + (pattern[i % pattern.length] % 4)] + 12;
        const fade = Math.min(1, (t - a) / 2.0) * Math.min(1, (b - t) / 1.0);
        pluckTo(arpBus, t, m, 0.045 * (i % 4 === 0 ? 1 : 0.6) * fade, i % 2 ? 0.28 : -0.28);
      }
    }

    // dark-section drone
    {
      const [a, b] = cues.dark;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, a - 0.2); g.gain.linearRampToValueAtTime(0.09, a + 1.0);
      g.gain.setValueAtTime(0.09, b - 0.6); g.gain.linearRampToValueAtTime(0, b + 0.4);
      send(g, 0.8, 0.3);
      osc('sine', mtof(33), a - 0.2, b + 0.5, g);
      const g2 = ctx.createGain(); g2.gain.value = 0.25; g2.connect(g);
      osc('triangle', mtof(45), a - 0.2, b + 0.5, g2, 4);
    }

    // ================= sound design =================
    const bell = ({ t, m, lvl = 0.06, dec = 3.0, dry = 0.6, wet = 0.8, pan = 0 }) => {
      const o = out(dry, wet, pan);
      const g = gainEnv(o, t, 0.004, lvl, dec);
      [[1, 1], [2.76, 0.22], [5.4, 0.06]].forEach(([r, a]) => {
        const og = ctx.createGain(); og.gain.value = a; og.connect(g);
        osc('sine', mtof(m) * r, t, t + dec + 0.1, og);
      });
    };
    const SFX = {
      bell,
      ding: (e) => bell({ dec: 1.4, ...e }),
      chime: ({ t, ms, gap = 0.07, lvl = 0.04 }) => ms.forEach((m, i) => bell({ t: t + i * gap, m, lvl: lvl * (1 - i * 0.08), dec: 2.4, pan: (i - ms.length / 2) * 0.15 })),
      glass: ({ t, f = 1568, lvl = 0.08 }) => {
        const o = out(0.55, 0.95);
        [[1, 1, 2.2], [2.32, 0.5, 1.6], [4.25, 0.28, 1.1], [6.63, 0.15, 0.8], [9.38, 0.08, 0.5]].forEach(([r, a, d]) => {
          const g = gainEnv(o, t, 0.002, lvl * a, d);
          osc('sine', f * r, t, t + d + 0.05, g);
        });
        const n = gainEnv(o, t, 0.001, lvl * 0.5, 0.02);
        noiseSrc(t, t + 0.04, filt('highpass', 6000, 0.7, n));
      },
      sparkles: ({ t, end, rate = 8, lvl = 0.02 }) => {
        const n = Math.round((end - t) * rate);
        for (let i = 0; i < n; i++) {
          const tt = t + rand() * (end - t);
          const o = out(0.4, 0.9, (rand() * 2 - 1) * 0.7);
          const g = gainEnv(o, tt, 0.003, lvl * (0.35 + 0.65 * rand()), 0.06 + rand() * 0.2);
          osc('sine', 2200 + rand() * 4200, tt, tt + 0.3, g);
        }
      },
      drone: ({ t, end, lvl = 0.1 }) => {
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lvl, t + 1.2);
        g.gain.linearRampToValueAtTime(lvl * 1.4, end - 0.1); g.gain.linearRampToValueAtTime(0, end + 0.05);
        send(g, 0.9, 0.25);
        osc('sine', mtof(36), t, end + 0.1, g);
        const g2 = ctx.createGain(); g2.gain.value = 0.5; g2.connect(g); osc('sine', mtof(24), t, end + 0.1, g2);
        const g3 = ctx.createGain(); g3.gain.value = 0.6; g3.connect(g); noiseSrc(t, end + 0.1, filt('lowpass', 140, 0.8, g3));
      },
      swell: ({ t, end, lvl = 0.06 }) => {
        const o = out(0.5, 0.9);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(lvl, end); g.gain.linearRampToValueAtTime(0, end + 0.05); g.connect(o);
        [72, 79, 84, 88].forEach((m, i) => osc('sine', mtof(m), t, end + 0.1, g, i * 3));
        const n = ctx.createGain(); n.gain.value = 0.5; n.connect(g);
        const bp = filt('bandpass', 1200, 1.2, n); bp.frequency.setValueAtTime(1200, t); bp.frequency.exponentialRampToValueAtTime(7000, end);
        noiseSrc(t, end + 0.1, bp);
      },
      swish: ({ t, dur = 0.5, lvl = 0.03, f0 = 800, f1 = 5000, q = 1.2, pan = 0 }) => {
        const o = out(0.7, 0.4, pan);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lvl, t + dur * 0.4); g.gain.linearRampToValueAtTime(0, t + dur); g.connect(o);
        const bp = filt('bandpass', f0, q, g); bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
        noiseSrc(t, t + dur + 0.05, bp);
      },
      whoosh: ({ t, dur = 0.8, lvl = 0.07 }) => {
        const o = out(0.7, 0.5);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t - dur); g.gain.linearRampToValueAtTime(lvl, t - 0.04); g.gain.linearRampToValueAtTime(0, t + 0.28); g.connect(o);
        const bp = filt('bandpass', 300, 1.1, g); bp.frequency.setValueAtTime(300, t - dur); bp.frequency.exponentialRampToValueAtTime(3800, t);
        noiseSrc(t - dur, t + 0.3, bp);
      },
      text: ({ t, lvl = 0.025 }) => {
        const o = out(0.5, 0.5);
        const g = gainEnv(o, t, 0.07, lvl, 0.35);
        noiseSrc(t, t + 0.5, filt('lowpass', 5000, 0.5, filt('bandpass', 2600, 0.7, g)));
      },
      pop: ({ t, f = 900, lvl = 0.06 }) => {
        const o = out(0.8, 0.35);
        const g = gainEnv(o, t, 0.004, lvl, 0.12);
        const s = osc('sine', f * 0.72, t, t + 0.2, g); s.frequency.setValueAtTime(f * 0.72, t); s.frequency.exponentialRampToValueAtTime(f, t + 0.06);
        const n = gainEnv(o, t, 0.001, lvl * 0.3, 0.015); noiseSrc(t, t + 0.03, filt('highpass', 4000, 0.7, n));
      },
      digi: ({ t, f = 3000, lvl = 0.012 }) => {
        const o = out(0.8, 0.2, (rand() * 2 - 1) * 0.3);
        const g = gainEnv(o, t, 0.001, lvl, 0.025);
        osc('square', f, t, t + 0.04, filt('lowpass', 5200, 0.7, g));
      },
      riser: ({ t, end, lvl = 0.08 }) => {
        const o = out(0.7, 0.5);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(lvl, end); g.gain.linearRampToValueAtTime(0, end + 0.03); g.connect(o);
        const bp = filt('bandpass', 400, 2, g); bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(6500, end);
        noiseSrc(t, end + 0.05, bp);
        const sg = ctx.createGain(); sg.gain.value = 0.3; sg.connect(g);
        const s = osc('sine', 180, t, end + 0.05, sg); s.frequency.setValueAtTime(180, t); s.frequency.exponentialRampToValueAtTime(1400, end);
      },
      boom: ({ t, lvl = 0.25 }) => {
        const g = gainEnv(master, t, 0.02, lvl, 1.6);
        const s = osc('sine', 70, t, t + 1.7, g); s.frequency.setValueAtTime(70, t); s.frequency.exponentialRampToValueAtTime(36, t + 1.2);
      },
      hit: ({ t, lvl = 0.12 }) => {
        const g = gainEnv(master, t, 0.008, lvl, 0.5);
        const s = osc('sine', 120, t, t + 0.6, g); s.frequency.setValueAtTime(120, t); s.frequency.exponentialRampToValueAtTime(55, t + 0.4);
        const n = gainEnv(out(0.6, 0.4), t, 0.002, lvl * 0.4, 0.18); noiseSrc(t, t + 0.25, filt('lowpass', 900, 0.7, n));
      },
      impact: ({ t, lvl = 0.3 }) => {
        SFX.boom({ t, lvl });
        const n = gainEnv(out(0.6, 0.6), t, 0.002, lvl * 0.5, 0.5); noiseSrc(t, t + 0.6, filt('lowpass', 1400, 0.6, n));
        const h = gainEnv(out(0.5, 0.5), t, 0.001, lvl * 0.25, 0.08); noiseSrc(t, t + 0.1, filt('highpass', 3200, 0.7, h));
        [60, 67, 72, 76].forEach((m, i) => bell({ t: t + i * 0.012, m, lvl: lvl * 0.12, dec: 4, wet: 1 }));
      },
      pluck2: ({ t, m1, m2, lvl = 0.05 }) => {
        const o = out(0.7, 0.6);
        pluckTo(o, t, m1, lvl, -0.15, 1.2); pluckTo(o, t + 0.16, m2, lvl * 0.9, 0.15, 1.6);
      },
      pluck: ({ t, m, lvl = 0.05, pan = 0 }) => pluckTo(out(0.7, 0.6), t, m, lvl, pan, 1.2),
      tick: ({ t, lvl = 0.015, f = 3200 }) => {
        const o = out(0.8, 0.2);
        const g = gainEnv(o, t, 0.001, lvl, 0.02); noiseSrc(t, t + 0.03, filt('bandpass', f, 2, g));
        const s = gainEnv(o, t, 0.001, lvl * 0.5, 0.02); osc('sine', f * 0.6, t, t + 0.03, s);
      },
      click: ({ t, lvl = 0.05 }) => {
        const o = out(0.85, 0.15);
        const a = gainEnv(o, t, 0.001, lvl, 0.018); noiseSrc(t, t + 0.03, filt('bandpass', 2500, 1.4, a));
        const s = gainEnv(o, t, 0.001, lvl * 0.4, 0.015); osc('sine', 1600, t, t + 0.03, s);
        const b = gainEnv(o, t + 0.075, 0.001, lvl * 0.45, 0.012); noiseSrc(t + 0.075, t + 0.1, filt('bandpass', 3400, 1.6, b));
      },
      key: ({ t, lvl = 0.04 }) => {
        const o = out(0.85, 0.15, (rand() * 2 - 1) * 0.15);
        const a = gainEnv(o, t, 0.001, lvl, 0.025); noiseSrc(t, t + 0.04, filt('bandpass', 1800 + rand() * 500, 1, a));
        const th = gainEnv(o, t, 0.002, lvl * 0.5, 0.03); osc('sine', 160, t, t + 0.05, th);
        const hi = gainEnv(o, t, 0.001, lvl * 0.3, 0.008); noiseSrc(t, t + 0.02, filt('highpass', 4000, 0.7, hi));
      },
      select: ({ t, lvl = 0.035 }) => {
        const o = out(0.7, 0.45);
        const a = gainEnv(o, t, 0.003, lvl, 0.12); osc('sine', 1320, t, t + 0.15, a);
        const b = gainEnv(o, t + 0.07, 0.003, lvl * 0.9, 0.2); osc('sine', 1760, t + 0.07, t + 0.3, b);
      },
      check: ({ t, on = true, lvl = 0.03 }) => SFX.tick({ t, lvl, f: on ? 2700 : 1900 }),
      switch: ({ t, on = true, lvl = 0.04 }) => {
        const o = out(0.8, 0.3);
        const g = gainEnv(o, t, 0.003, lvl, 0.08);
        const s = osc('sine', on ? 520 : 780, t, t + 0.12, g); s.frequency.setValueAtTime(on ? 520 : 780, t); s.frequency.exponentialRampToValueAtTime(on ? 780 : 520, t + 0.06);
        SFX.tick({ t: t + 0.01, lvl: lvl * 0.6, f: on ? 3000 : 2200 });
      },
      pulse: ({ t, lvl = 0.02 }) => { const g = gainEnv(out(0.6, 0.6), t, 0.02, lvl, 0.25); osc('sine', 880, t, t + 0.3, g); },
      zap: ({ t, dur = 0.7, lvl = 0.018, pan = 0 }) => {
        const o = out(0.6, 0.5, pan);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lvl, t + 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); g.connect(o);
        const s = osc('sine', 500, t, t + dur + 0.05, g); s.frequency.setValueAtTime(500, t); s.frequency.exponentialRampToValueAtTime(1800, t + dur);
        const n = ctx.createGain(); n.gain.value = 0.6; n.connect(g);
        const bp = filt('bandpass', 2000, 3, n); bp.frequency.setValueAtTime(2000, t); bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
        noiseSrc(t, t + dur + 0.05, bp);
      },
      shimmer: ({ t, dur = 0.8, lvl = 0.03 }) => {
        const o = out(0.4, 0.9);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lvl, t + dur * 0.5); g.gain.linearRampToValueAtTime(0, t + dur); g.connect(o);
        const bp = filt('bandpass', 4000, 1.5, filt('highpass', 3000, 0.7, g)); bp.frequency.setValueAtTime(4000, t); bp.frequency.exponentialRampToValueAtTime(10000, t + dur);
        noiseSrc(t, t + dur + 0.05, bp);
        [96, 98, 100, 103, 105, 108].forEach((m, i) => {
          const tt = t + (i / 6) * dur;
          const sg = gainEnv(out(0.3, 0.9, (i / 5 - 0.5) * 0.8), tt, 0.003, lvl * 0.5, 0.25);
          osc('sine', mtof(m), tt, tt + 0.3, sg);
        });
      },
    };
    for (const e of cues.sfx) {
      if (!ok(e.t)) continue;
      const fn = SFX[e.type];
      if (fn) fn(e); else console.warn('great-plan promo: unknown sfx', e.type);
    }

    const buf = await ctx.startRendering();
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
    const gain = peak > 0 ? 0.708 / peak : 1;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= gain; }
    return buf;
  }

  function toWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length;
    const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true);
    out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * ch * 2, true);
    const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return new Uint8Array(out.buffer);
  }
  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  let cached = null;
  const score = () => (cached || (cached = renderScore()));
  window.__renderAudio = async () => toBase64(toWav(await score()));
  window.GPScore = {
    async play(offset) {
      const buf = await score();
      const ac = new AudioContext();
      const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
      src.start(0, offset);
      return { stop() { try { src.stop(); } catch (_) { /* already stopped */ } ac.close(); } };
    },
  };
})();
