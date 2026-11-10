'use strict';

/*
 * Decides when the pet may start a conversation on her own.
 * Triggers: random idle timer, user returning, late night, long sessions.
 * Every trigger passes the same gate (presence, cooldown, daily cap, quiet hours, pet idle).
 */

const LEVELS = {
  off: null,
  occasional: { idleMin: 40, idleMax: 90, cooldownMin: 30, dailyCap: 6 },
  chatty: { idleMin: 15, idleMax: 35, cooldownMin: 12, dailyCap: 15 }
};

const QUIET_START = 1;
const QUIET_END = 8;
const PRESENT_IDLE_SECONDS = 180;
const LONG_SESSION_MIN = 120;

class ProactiveScheduler {
  /**
   * host: { level(), idleSeconds(), petIsIdle(), canTalk(), speak(reason, context) -> Promise }
   */
  constructor(host) {
    this.host = host;
    this.lastAt = 0;
    this.day = new Date().toDateString();
    this.count = 0;
    this.timer = null;
    this.sessionStart = Date.now();
    this.lateNightDay = null;
    this.watch = setInterval(() => this.checkClock(), 60000);
    this.reschedule();
  }

  config() {
    return LEVELS[this.host.level()] || null;
  }

  reschedule() {
    clearTimeout(this.timer);
    const cfg = this.config();
    if (!cfg) return;
    const minutes = cfg.idleMin + Math.random() * (cfg.idleMax - cfg.idleMin);
    this.timer = setTimeout(() => {
      this.trigger('你在桌面上待了好一会儿，有点无聊', { idle: true });
      this.reschedule();
    }, minutes * 60000);
  }

  resetDay() {
    const today = new Date().toDateString();
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
  }

  gate({ bypassCooldown = false } = {}) {
    const cfg = this.config();
    if (!cfg || !this.host.canTalk()) return false;
    this.resetDay();
    const hour = new Date().getHours();
    if (hour >= QUIET_START && hour < QUIET_END) return false;
    if (this.host.idleSeconds() > PRESENT_IDLE_SECONDS) return false;
    if (!this.host.petIsIdle()) return false;
    if (!bypassCooldown && Date.now() - this.lastAt < cfg.cooldownMin * 60000) return false;
    return this.count < cfg.dailyCap;
  }

  async trigger(reason, opts = {}) {
    if (!this.gate(opts)) return false;
    this.lastAt = Date.now();
    this.count += 1;
    const sessionMin = Math.round((Date.now() - this.sessionStart) / 60000);
    const context = `用户这次已经连续用电脑约 ${sessionMin} 分钟。今天你已经主动搭话 ${this.count - 1} 次。`;
    try {
      await this.host.speak(reason, context);
    } catch (_err) {
      /* proactive chatter fails silently */
    }
    return true;
  }

  userAway() {
    this.awaySince = Date.now();
  }

  userBack() {
    const awayMin = this.awaySince ? Math.round((Date.now() - this.awaySince) / 60000) : 0;
    this.awaySince = null;
    this.sessionStart = Date.now();
    if (awayMin >= 3) {
      this.trigger(`用户离开电脑约 ${awayMin} 分钟，刚刚回来`, { bypassCooldown: true });
    }
  }

  checkClock() {
    const now = new Date();
    const hour = now.getHours();
    const today = now.toDateString();
    if ((hour === 23 || hour === 0) && this.lateNightDay !== today) {
      if (this.host.idleSeconds() < 60) {
        this.lateNightDay = today;
        this.trigger(`已经深夜 ${hour === 0 ? '0' : '23'} 点多了，用户还在用电脑`, { bypassCooldown: true });
      }
    }
    const sessionMin = (Date.now() - this.sessionStart) / 60000;
    if (sessionMin >= LONG_SESSION_MIN) {
      this.sessionStart = Date.now();
      this.trigger('用户已经连续用电脑两个小时没休息了');
    }
  }

  dispose() {
    clearTimeout(this.timer);
    clearInterval(this.watch);
  }
}

module.exports = { ProactiveScheduler, LEVELS };
