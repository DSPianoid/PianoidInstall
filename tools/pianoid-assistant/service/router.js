/**
 * The model router (assistant v2 P1, proposal §5). Pure: no I/O, unit-tested against a routing
 * corpus built from the 2026-10-16 transcripts (test/routing-corpus.json, `node --test`, no spend).
 *
 * Three layers; the pane's forced Sonnet / Opus choice wins over all of them (the session skips the
 * router when the picker is not Auto):
 *  1. pre-routing before the turn (`preRoute`): English + Russian keyword sets over the user text,
 *     plus context signals (the engine reports a crash / an exception);
 *  2. tool and failure triggers during the turn (`Router.onToolCall` / `onToolResult`): the first
 *     call of a heavy tool, two consecutive tool errors, a retry of a denied / declined command;
 *  3. self-escalation (`escalate_model`, unchanged; the session reports it with `onEscalated`).
 * Stickiness: a turn that went to Opus by layer 1, 2 or 3 keeps Opus for the next STICKY_TURNS turns
 * (follow-ups such as "and the bass?"); sticky turns do not renew it.
 *
 * Conservative choices where the proposal is open (noted in the dev-fcef log):
 *  - context: only a crashed engine routes to Opus; `warnings` alone do not (the 2026-10-16 F15
 *    session had a load-mismatch warning on every turn, which would have made every turn Opus);
 *  - "any write while no recipe matched" (§5 layer 2) waits for the runbook (P3): without recipes
 *    it would escalate every write, including "lower the volume";
 *  - "no sound" is a complaint only as one ("no sound", "still no sound", "there is no sound"), not
 *    the instruction "(..., no sound)" / "do not play any sound" the live checks used.
 */

export const STICKY_TURNS = 2;

// Tools whose first call in a turn escalates it (§5 layer 2). They arrive in P5 / P6 / P7; listing
// them here keeps the trigger in one place.
export const HEAVY_TOOLS = new Map([
  ['analysis.run_python', 'code run'],
  ['bug.draft', 'bug draft'],
  ['research.ask', 'web research'],
]);

// Word boundaries that work for Cyrillic too (\b is ASCII-only in JS).
const W = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const re = (body) => new RegExp(body, 'iu');
const words = (list) => re(`${W}(?:${list.join('|')})${E}`);
const stems = (list) => re(`${W}(?:${list.join('|')})`);

const TIMBRE_EN = ['brighter', 'darker', 'warmer', 'duller', 'mellower', 'softer', 'harsher', 'richer', 'fuller',
  'thinner', 'sharper', 'rounder', 'more metallic', 'less metallic', 'bell-like', 'more percussive',
  'more attack', 'less attack', 'more sustain', 'longer sustain', 'shorter sustain', 'more body', 'less ring'];
const TIMBRE_RU = ['ярче', 'темнее', 'теплее', 'глуше', 'звонче', 'мягче', 'жёстче', 'жестче', 'богаче', 'насыщенн',
  'металлич', 'мягк', 'тускл'];

/**
 * Layer-1 rules in priority order: the first match decides. `ctx` = the per-turn digest
 * (service/contextDigest.js) or null.
 */
export const RULES = [
  {
    category: 'bug analysis', route: 'opus',
    test: [
      words(['bug', 'bugs', 'broken', 'crash', 'crashed', 'crashes', 'crashing', 'glitch', 'glitches', 'glitchy',
        "doesn't work", 'does not work', "doesn't respond", 'not working', 'stopped working', 'error', 'errors',
        'wrong', 'fails', 'failed', 'failing', 'distorted', 'distortion', 'stuck', 'frozen', 'freezes',
        "don't hear", 'do not hear', "can't hear", 'cannot hear', 'hear nothing', "don't hear anything",
        'no effect', "don't see any effect", 'does nothing', 'nothing happens']),
      re(`^\\W*(?:still\\s+)?no\\s+sound${E}`),
      re(`${W}(?:still|there\\s+is|there's|i\\s+get|i\\s+have|getting|i\\s+hear)\\s+no\\s+sound${E}`),
      re(`${W}(?:completely|totally|still|all)\\s+(?:mute|muted|silent|quiet)${E}`),
      stems(['ошибк', 'ошибоч', 'не работает', 'не работают', 'сломал', 'баг', 'глюк', 'искаж', 'вылет', 'завис',
        'нет звука', 'не слышно', 'ничего не слыш', 'не слышу', 'тишина', 'не реагирует']),
    ],
    context: (ctx) => {
      const b = ctx?.backend;
      if (!b) return null;
      if (b.exception) return 'the engine reports an exception';
      if (b.status === 'crashed') return 'the engine status is crashed';
      return null;
    },
  },
  {
    category: 'timbre edit', route: 'opus',
    test: [
      re(`${W}(?:make|making|get)\\s+(?:it|the\\s+\\w+(?:\\s+\\w+)?|this|that|them|everything|the\\s+sound|the\\s+tone)\\s+(?:a\\s+(?:bit|little)\\s+|much\\s+|slightly\\s+)?(?:${TIMBRE_EN.join('|')})${E}`),
      re(`${W}(?:сдела\\p{L}*)\\s+(?:\\p{L}+\\s+){0,3}(?:${TIMBRE_RU.join('|')})`),
    ],
  },
  {
    category: 'physics / prediction', route: 'opus',
    test: [
      words(['why', 'what happens if', 'what would happen', 'what will happen', 'predict', 'prediction', 'physics',
        'physical model', 'explain', 'inharmonic', 'inharmonicity', 'timbre', 'timbral',
        'sustain', 'attack', 'decay time', 'resonance', 'resonances', 'overtones', 'partials', 'harmonics', 'cfl',
        ...TIMBRE_EN]),
      stems(['почему', 'зачем', 'что будет', 'что произойд', 'предскаж', 'спрогноз', 'объясни', 'физик', 'тембр',
        'обертон', 'гармоник', 'сустейн', 'атак', 'затухан', 'резонанс', 'ярче', 'темнее', 'теплее', 'звонче', 'глуше']),
    ],
  },
  {
    category: 'code / analysis', route: 'opus',
    test: [
      words(['compare', 'comparison', 'spectrum', 'spectra', 'spectral', 'fft', 'psd', 'plot', 'correlate',
        'correlation', 'analyse', 'analyze', 'analysis', 'measure', 'centroid', 'waveform', 'research',
        'calculate', 'compute', 'statistics']),
      stems(['сравни', 'сравн', 'спектр', 'анализ', 'проанализ', 'измер', 'график', 'коррел', 'вычисл', 'посчита',
        'исследу']),
    ],
  },
  {
    category: 'comparison', route: 'opus',
    test: [words(['vs', 'versus', 'difference between', 'a/b', 'a-b test', 'ab test']),
      stems(['разниц', 'отличи', 'отличае', 'по сравнению'])],
  },
  {
    category: 'multi-step plan', route: 'opus',
    test: [
      words(['then', 'after that', 'afterwards', 'for each', 'for every', 'in turn', 'one by one', 'one after another',
        'step by step', 'each channel', 'every channel', 'all channels', 'each pitch', 'every pitch', 'all pitches',
        'each key', 'every key', 'each mode', 'every mode']),
      words(['потом', 'затем']),
      stems(['после этого', 'по очереди', 'по одному', 'для каждого', 'для каждой', 'каждый канал',
        'все каналы', 'каждую ноту', 'все ноты', 'шаг за шагом']),
    ],
  },
];

/** Layer 1: the route for one user turn: {route, category, rule, match?}. */
export function preRoute(text, ctx = null) {
  const t = String(text || '');
  for (const rule of RULES) {
    for (const pattern of rule.test) {
      const m = pattern.exec(t);
      if (m) return { route: rule.route, category: rule.category, rule: `${rule.category} ("${m[0].trim()}")`, match: m[0].trim() };
    }
    const why = rule.context?.(ctx);
    if (why) return { route: rule.route, category: rule.category, rule: `${rule.category} (context: ${why})` };
  }
  return { route: 'sonnet', category: 'plain action / read', rule: 'plain action / read' };
}

/**
 * Per-session routing state: stickiness across turns + the in-turn triggers. The session owns the
 * model switch (query.setModel); the router only decides.
 */
export class Router {
  constructor({ stickyTurns = STICKY_TURNS } = {}) {
    this.stickyTurns = stickyTurns;
    this.stickyLeft = 0;
    this.turn = null;
  }

  /** Start a turn: {model: 'opus' | 'sonnet', layer, category, rule}. */
  beginTurn(text, ctx = null) {
    const pre = preRoute(text, ctx);
    this.turn = { opus: false, renews: false, errors: 0, refused: new Set(), heavy: new Set() };
    if (pre.route === 'opus') {
      this.turn.opus = true;
      this.turn.renews = true;
      return { model: 'opus', layer: 'pre-route', category: pre.category, rule: pre.rule };
    }
    if (this.stickyLeft > 0) {
      const n = this.stickyTurns - this.stickyLeft + 1;
      this.stickyLeft -= 1;
      this.turn.opus = true;
      return { model: 'opus', layer: 'sticky', category: 'follow-up', rule: `sticky follow-up (${n} of ${this.stickyTurns} after an Opus turn)` };
    }
    return { model: 'sonnet', layer: 'pre-route', category: pre.category, rule: pre.rule };
  }

  /** Escalation reason for the turn, or null; `trigger` is the reason a layer-2/3 rule fired. */
  escalate(trigger) {
    if (!this.turn) return null;
    this.turn.renews = true;
    if (this.turn.opus) return null;           // already on Opus: nothing to switch
    this.turn.opus = true;
    return trigger;
  }

  /** Layer 2 before a tool call runs: a heavy tool's first call, or a retry of a refused command. */
  onToolCall(command) {
    if (!this.turn) return null;
    if (HEAVY_TOOLS.has(command) && !this.turn.heavy.has(command)) {
      this.turn.heavy.add(command);
      return this.escalate(`tool trigger: first ${HEAVY_TOOLS.get(command)} (${command})`);
    }
    if (this.turn.refused.has(command)) return this.escalate(`failure trigger: retry of the refused ${command}`);
    return null;
  }

  /** A call the policy denied or the user declined (a retry of the same command escalates). */
  onRefused(command) {
    this.turn?.refused.add(command);
  }

  /** Layer 2 after a tool result: two consecutive errors escalate. */
  onToolResult(isError) {
    if (!this.turn) return null;
    this.turn.errors = isError ? this.turn.errors + 1 : 0;
    return this.turn.errors >= 2 ? this.escalate('failure trigger: 2 consecutive tool errors') : null;
  }

  /** Layer 3: the model called escalate_model. */
  onEscalated(reason) {
    return this.escalate(`self-escalation: ${reason}`);
  }

  /** End of the turn: the model the NEXT turn starts on ('opus' while stickiness is left). */
  endTurn() {
    if (this.turn?.renews) this.stickyLeft = this.stickyTurns;
    this.turn = null;
    return this.stickyLeft > 0 ? 'opus' : 'sonnet';
  }

  reset() {
    this.stickyLeft = 0;
    this.turn = null;
  }
}
