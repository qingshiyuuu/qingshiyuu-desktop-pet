'use strict';

/*
 * Minimal finite state machine.
 *
 * states: {
 *   name: {
 *     enter(ctx, payload, machine), exit(ctx, machine), update(ctx, dtSeconds, machine),
 *     on: { EVENT: 'target' | ['target', payload] | (ctx, payload, machine) => target | null }
 *   }
 * }
 * global: fallback handlers for events a state does not list in `on`.
 * A state listing an event (even with a handler that returns null) overrides the global handler.
 */
(function (global) {
  class StateMachine {
    constructor({ states, global: globalHandlers = {}, context }) {
      this.states = states;
      this.global = globalHandlers;
      this.context = context;
      this.current = null;
      this.data = {};
      this.enteredAt = 0;
      this.listeners = [];
    }

    onTransition(listener) {
      this.listeners.push(listener);
    }

    is(...names) {
      return names.includes(this.current);
    }

    start(name, payload) {
      this.transition(name, payload);
    }

    send(event, payload) {
      const def = this.states[this.current];
      const local = def && def.on && Object.prototype.hasOwnProperty.call(def.on, event);
      const handler = local ? def.on[event] : this.global[event];
      if (handler === undefined) return false;
      const result = typeof handler === 'function' ? handler(this.context, payload, this) : handler;
      this.apply(result);
      return true;
    }

    apply(result) {
      if (!result) return;
      if (Array.isArray(result)) this.transition(result[0], result[1]);
      else this.transition(result);
    }

    transition(target, payload) {
      const next = this.states[target];
      if (!next) throw new Error(`Unknown state "${target}"`);
      const from = this.current;
      const prev = this.states[from];
      if (prev && prev.exit) prev.exit(this.context, this);
      this.current = target;
      this.data = {};
      this.enteredAt = performance.now();
      for (const listener of this.listeners) listener({ from, to: target, payload });
      if (next.enter) this.apply(next.enter(this.context, payload || {}, this));
    }

    update(dt) {
      const def = this.states[this.current];
      if (def && def.update) this.apply(def.update(this.context, dt, this));
    }
  }

  global.StateMachine = StateMachine;
})(window);
