/**
 * Optional WebAudio graph: gain (ReplayGain) + 10-band EQ + crossfade.
 * Falls back cleanly — never steals output if attach fails.
 */

import { EQ_FREQS, dbToGain, type LocalPlaybackPrefs } from './localPlaybackPrefs';

export type AudioFxHandle = {
  /** true when MediaElementSource is wired to destination */
  active: boolean;
  resume: () => Promise<void>;
  setUserVolume: (v: number, muted: boolean) => void;
  setReplayGainDb: (db: number | null) => void;
  setNormalize: (on: boolean) => void;
  setEqEnabled: (on: boolean) => void;
  setEqGains: (gains: number[]) => void;
  applyPrefs: (prefs: LocalPlaybackPrefs) => void;
  setFade: (linear: number) => void;
  /** Apply volume to <audio> when graph inactive; always keep fade restored */
  syncElementVolume: () => void;
  dispose: () => void;
};

export function needsAudioGraph(prefs: LocalPlaybackPrefs): boolean {
  // WebAudio graph only when EQ is enabled. Crossfade/RG can use element volume.
  return Boolean(prefs.eqEnabled);
}

export function attachAudioFx(audio: HTMLAudioElement, prefs: LocalPlaybackPrefs): AudioFxHandle {
  let ctx: AudioContext | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let gainNode: GainNode | null = null;
  let fadeNode: GainNode | null = null;
  let filters: BiquadFilterNode[] = [];
  let active = false;

  let userVol = 1;
  let muted = false;
  let rgDb: number | null = null;
  let normalize = prefs.normalize;
  let eqOn = prefs.eqEnabled;
  let fade = 1;
  let useReplayGain = prefs.replayGain;

  const linearOut = () => {
    if (muted) return 0;
    let g = userVol;
    if (normalize) g = Math.min(g, 1);
    if (useReplayGain && rgDb != null && Number.isFinite(rgDb)) {
      g *= dbToGain(Math.max(-12, Math.min(12, rgDb)));
    }
    return Math.max(0, Math.min(2.5, g)) * Math.max(0, Math.min(1, fade));
  };

  const syncElementVolume = () => {
    try {
      // When graph is active, element volume stays 1 (gain is in the graph).
      // When inactive, element volume is the real output.
      if (active) {
        audio.volume = 1;
        audio.muted = false;
        if (gainNode) gainNode.gain.value = muted ? 0 : Math.max(0.0001, linearOut() / Math.max(0.0001, fade || 1));
        // Wait - if fade is in fadeNode, gain should be without fade
        let g = muted ? 0 : userVol;
        if (normalize) g = Math.min(g, 1);
        if (useReplayGain && rgDb != null && Number.isFinite(rgDb)) {
          g *= dbToGain(Math.max(-12, Math.min(12, rgDb)));
        }
        g = Math.max(0, Math.min(2.5, g));
        if (gainNode) gainNode.gain.value = g;
        if (fadeNode) fadeNode.gain.value = Math.max(0, Math.min(1, fade));
      } else {
        audio.volume = muted ? 0 : Math.min(1, Math.max(0, userVol * Math.max(0, Math.min(1, fade))));
        audio.muted = muted;
      }
    } catch {
      /* ignore */
    }
  };

  const applyEq = (gains: number[]) => {
    filters.forEach((f, i) => {
      const db = eqOn ? Number(gains[i]) || 0 : 0;
      f.gain.value = Math.max(-12, Math.min(12, db));
    });
  };

  const ensureGraph = (): boolean => {
    if (active) return true;
    try {
      ctx = new AudioContext();
      source = ctx.createMediaElementSource(audio);
      gainNode = ctx.createGain();
      fadeNode = ctx.createGain();
      filters = EQ_FREQS.map((freq, i) => {
        const f = ctx!.createBiquadFilter();
        if (i === 0) f.type = 'lowshelf';
        else if (i === EQ_FREQS.length - 1) f.type = 'highshelf';
        else f.type = 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1.0;
        f.gain.value = 0;
        return f;
      });
      let node: AudioNode = source;
      for (const f of filters) {
        node.connect(f);
        node = f;
      }
      node.connect(gainNode);
      gainNode.connect(fadeNode);
      fadeNode.connect(ctx.destination);
      active = true;
      applyEq(prefs.eq);
      syncElementVolume();
      return true;
    } catch (e) {
      console.warn('[audioFx] graph attach failed, using element volume', e);
      active = false;
      ctx = null;
      source = null;
      gainNode = null;
      fadeNode = null;
      filters = [];
      syncElementVolume();
      return false;
    }
  };

  // Only wire graph if features need it — avoids silent MediaElementSource issues
  if (needsAudioGraph(prefs)) {
    ensureGraph();
  } else {
    syncElementVolume();
  }

  const ensureRunning = () => {
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  };
  audio.addEventListener('play', ensureRunning);

  return {
    get active() {
      return active;
    },
    async resume() {
      if (needsAudioGraph(prefs) && !active) ensureGraph();
      if (ctx && ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          /* ignore */
        }
      }
      // Never leave output at 0 after resume
      if (fade <= 0) fade = 1;
      syncElementVolume();
    },
    setUserVolume(v, m) {
      userVol = Math.max(0, Math.min(1, v));
      muted = m;
      syncElementVolume();
    },
    setReplayGainDb(db) {
      rgDb = db;
      if (useReplayGain && db != null && !active) ensureGraph();
      syncElementVolume();
    },
    setNormalize(on) {
      normalize = on;
      syncElementVolume();
    },
    setEqEnabled(on) {
      eqOn = on;
      if (on && !active) ensureGraph();
      applyEq(prefs.eq);
      syncElementVolume();
    },
    setEqGains(gains) {
      prefs.eq = gains;
      if (eqOn && gains.some((g) => Math.abs(g) > 0.01) && !active) ensureGraph();
      applyEq(gains);
    },
    applyPrefs(p) {
      Object.assign(prefs, p);
      normalize = p.normalize;
      eqOn = p.eqEnabled;
      useReplayGain = p.replayGain;
      if (needsAudioGraph(p) && !active) ensureGraph();
      applyEq(p.eq);
      // Always restore fade when prefs change
      if (fade <= 0) fade = 1;
      syncElementVolume();
    },
    setFade(linear) {
      fade = Math.max(0, Math.min(1, linear));
      if (fadeNode) fadeNode.gain.value = fade;
      else syncElementVolume();
    },
    syncElementVolume,
    dispose() {
      try {
        audio.removeEventListener('play', ensureRunning);
        source?.disconnect();
        filters.forEach((f) => f.disconnect());
        gainNode?.disconnect();
        fadeNode?.disconnect();
        void ctx?.close();
      } catch {
        /* ignore */
      }
      active = false;
      ctx = null;
      source = null;
      // After dispose, restore direct element routing volume
      try {
        audio.volume = muted ? 0 : userVol;
        audio.muted = muted;
      } catch {
        /* ignore */
      }
    },
  };
}

export async function fadeOut(
  fx: AudioFxHandle | null,
  ms: number,
  shouldAbort?: () => boolean
): Promise<void> {
  if (!fx || ms <= 0) return;
  const steps = 16;
  const step = ms / steps;
  for (let i = steps; i >= 0; i--) {
    if (shouldAbort?.()) {
      fx.setFade(1);
      return;
    }
    fx.setFade(i / steps);
    await new Promise((r) => setTimeout(r, step));
  }
}

export async function fadeIn(fx: AudioFxHandle | null, ms: number): Promise<void> {
  if (!fx) return;
  if (ms <= 0) {
    fx.setFade(1);
    fx.syncElementVolume();
    return;
  }
  const steps = 16;
  const step = ms / steps;
  for (let i = 0; i <= steps; i++) {
    fx.setFade(i / steps);
    await new Promise((r) => setTimeout(r, step));
  }
  fx.setFade(1);
  fx.syncElementVolume();
}
