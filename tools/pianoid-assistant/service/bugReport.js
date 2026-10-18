/**
 * The assistant's bug filing (v2 proposal §7, P6 minimal; dev-947d). Native only: the report goes to
 * the backend's collector POST /bug_report, the same store as the 🐞 / automatic reports
 * (PianoidCore/logs/reports/bugreport-<createdAt>-assistant-<kind>-<reportId>.json). Never GitHub
 * (user decision 2026-10-17).
 *
 * The model writes the draft (title, classification, description, steps, expected / actual, evidence);
 * this module, not the model, attaches the context: the latest pianoid_context, the versions, a
 * transcript excerpt and the recent activity. Category `bug_local` (Ask by default): the confirm
 * dialog shows the full draft before anything is filed.
 */
import crypto from 'node:crypto';

export const BUG_TOOL = 'mcp__assistant__bug_report';
export const BUG_CMD = {
  name: 'bug.report', title: 'File a bug report (local collector)', tier: 'act', family: 'bug',
  category: 'bug_local', approval_category: 'bug_local',
};
// user_state is not a bug (v2 §7: the user's own settings, an R6 / envelope deny): it is not filable
export const CLASSIFICATIONS = ['app_bug', 'environment'];
const TRANSCRIPT_MESSAGES = 12;
const ACTIVITY_ENTRIES = 30;
const TEXT_MAX = 2000;

const clip = (s, n = TEXT_MAX) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const strings = (v) => (Array.isArray(v) ? v.map((x) => clip(String(x), 500)) : []);

/** Throws on a draft the collector should not get. */
export function validateDraft(d) {
  if (!d || typeof d !== 'object') throw new Error('the draft must be an object');
  for (const k of ['title', 'description']) {
    if (typeof d[k] !== 'string' || !d[k].trim()) throw new Error(`${k} is required`);
  }
  if (!CLASSIFICATIONS.includes(d.classification)) {
    throw new Error(`classification must be one of ${CLASSIFICATIONS.join(', ')} (the user's own settings are not a bug)`);
  }
}

/** The collector report (schemaVersion 2, the FE report's envelope fields + the assistant's sections). */
export function buildReport({ draft, transcript = [], activity = [], context = null, model = null, now = new Date(), reportId }) {
  const env = context?.environment || {};
  return {
    schemaVersion: 2,
    reportId: reportId || crypto.randomBytes(8).toString('hex'),
    createdAt: now.toISOString(),
    description: `ASSISTANT: ${clip(draft.title, 200)}`,
    trigger: { auto: false, source: 'assistant', kind: draft.classification },
    title: clip(draft.title, 200),
    classification: draft.classification,
    report: {
      description: clip(draft.description, 4000),
      component: draft.component ? clip(draft.component, 200) : null,
      steps: strings(draft.steps),
      expected: draft.expected ? clip(draft.expected) : null,
      actual: draft.actual ? clip(draft.actual) : null,
      evidence: strings(draft.evidence),
    },
    versions: {
      repos: env.repos ?? null, build: env.build ?? null, gpu: env.gpu ?? null, assistant_model: model,
    },
    pianoid_context: context,
    transcript_excerpt: transcript.slice(-TRANSCRIPT_MESSAGES).map((m) => ({
      role: m.role, at: m.at ? new Date(m.at).toISOString() : null, text: clip(m.text),
    })),
    activity: activity.slice(-ACTIVITY_ENTRIES).map((a) => ({
      at: a.at ? new Date(a.at).toISOString() : null, command: a.command, decision: a.decision, status: a.status,
      reason: a.reason ? clip(a.reason, 400) : undefined, input: a.input, result: a.result ? clip(a.result, 400) : undefined,
    })),
  };
}

/** What the confirm dialog shows: the draft as filed, the attachments by name and size. */
export function preview(report) {
  return {
    title: report.title, classification: report.classification, ...report.report,
    attached: [
      `pianoid_context${report.pianoid_context ? '' : ' (none)'}`, 'versions',
      `transcript (last ${report.transcript_excerpt.length} messages)`, `activity (last ${report.activity.length} entries)`,
    ],
    destination: 'local collector POST /bug_report (PianoidCore/logs/reports); never GitHub',
  };
}

/** POST the report to the native collector -> {ok, saved, path, reportId} or {ok: false, error}. */
export async function fileReport(report, { backendUrl, fetchImpl = fetch }) {
  try {
    const r = await fetchImpl(`${backendUrl}/bug_report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pianoid-Source': 'assistant' },
      body: JSON.stringify(report), signal: AbortSignal.timeout?.(30000),
    });
    const body = await r.json();
    return r.ok && body.ok ? { ok: true, saved: body.saved, path: body.path, reportId: report.reportId, duplicate: !!body.duplicate }
      : { ok: false, status: r.status, error: body.error || 'collector refused the report' };
  } catch (e) {
    return { ok: false, error: `collector unreachable: ${e.message}` };
  }
}
