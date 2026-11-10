'use strict';

(function (global) {
  // Turns the per-action atlas JSON into named clips: "idle.breathe", "idle.smoke", "walk", "think", ...
  function buildClips(manifest) {
    const clips = {};
    for (const [action, info] of Object.entries(manifest.actions)) {
      const atlas = info.atlas;
      const frameOf = (name) => {
        const f = atlas.frames[name];
        if (!f) throw new Error(`Atlas ${action} has no frame ${name}`);
        return { name, x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h, durationMs: f.durationMs };
      };
      const add = (key, seq) => {
        clips[key] = {
          name: key,
          action,
          label: info.label,
          loop: Boolean(seq.loop),
          frames: seq.frames.map(frameOf),
          cell: { w: atlas.layout.cellWidth, h: atlas.layout.cellHeight },
          anchor: { x: atlas.anchor.x, y: atlas.anchor.y }
        };
      };
      if (atlas.sequences) {
        for (const [key, seq] of Object.entries(atlas.sequences)) add(`${action}.${key}`, seq);
      }
      if (atlas.sequence) add(action, atlas.sequence);
    }
    return clips;
  }

  class Animator {
    constructor(clips, images) {
      this.clips = clips;
      this.images = images;
      this.clip = null;
      this.index = 0;
      this.elapsed = 0;
      this.loop = false;
      this.flipX = false;
      this.held = false;
      this.finished = false;
      this.onLoop = null;
      this.onEnd = null;
      this.onClipChange = null;
      this.dirty = true;
    }

    get frame() {
      return this.clip.frames[this.index];
    }

    get image() {
      return this.images[this.clip.action];
    }

    play(name, opts = {}) {
      const clip = this.requireClip(name);
      const continuing = this.clip === clip && clip.loop && !this.held && !this.finished && !opts.restart;
      if (!continuing && this.onClipChange && this.clip) this.onClipChange();
      this.flipX = Boolean(opts.flipX);
      this.loop = opts.loop !== undefined ? opts.loop : clip.loop;
      this.onLoop = opts.onLoop || null;
      this.onEnd = opts.onEnd || null;
      this.held = false;
      this.finished = false;
      this.dirty = true;
      if (continuing) return;
      this.clip = clip;
      this.index = 0;
      this.elapsed = 0;
    }

    hold(name, index, opts = {}) {
      const clip = this.requireClip(name);
      const target = Math.max(0, Math.min(clip.frames.length - 1, index));
      if (this.onClipChange && this.clip && (this.clip !== clip || this.index !== target)) this.onClipChange();
      this.clip = clip;
      this.index = target;
      this.elapsed = 0;
      this.flipX = Boolean(opts.flipX);
      this.held = true;
      this.finished = false;
      this.onLoop = null;
      this.onEnd = null;
      this.dirty = true;
    }

    setFlip(flipX) {
      if (this.flipX !== flipX) {
        this.flipX = flipX;
        this.dirty = true;
      }
    }

    requireClip(name) {
      const clip = this.clips[name];
      if (!clip) throw new Error(`Unknown clip "${name}"`);
      return clip;
    }

    update(dtMs) {
      const clip = this.clip;
      if (!clip || this.held || this.finished) return;
      this.elapsed += dtMs;
      let guard = 0;
      while (this.clip === clip && this.elapsed >= clip.frames[this.index].durationMs && guard++ < 64) {
        this.elapsed -= clip.frames[this.index].durationMs;
        if (this.index < clip.frames.length - 1) {
          this.index += 1;
          this.dirty = true;
        } else if (this.loop) {
          this.index = 0;
          this.dirty = true;
          if (this.onLoop) this.onLoop();
        } else {
          this.finished = true;
          this.elapsed = 0;
          const done = this.onEnd;
          this.onEnd = null;
          if (done) done();
          break;
        }
      }
    }
  }

  global.PetAnimation = { buildClips, Animator };
})(window);
