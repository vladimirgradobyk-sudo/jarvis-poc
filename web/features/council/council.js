// The Council modal (screen-specs §4). Shared by EVERY agent family and artifact kind — there
// is no per-agent council UI, matching the server's one engine.
//
// Tabs are the skill's DECLARED phases; future phases are disabled. Every status string comes
// from lib/reducer.js, so the pilot's "Captain deliberating…" above "✓ Verdict ready" cannot
// recur (FR-HUM-006).

import { h, mount, frag, clear, Button, Chip, Badge, Banner, ScoreTile, RubricMeter, Modal, Tabs,
         EmptyState, KV, DocumentView, DiffView, band, toast, renderMarkdown } from '../../components/ui.js';
import { api, ApiError } from '../../lib/api.js';
import { statusLabel, phaseLabel, activePhaseFor, reachablePhases, createProjection,
         applyEvent, duration } from '../../lib/reducer.js';

export class CouncilModal {
  constructor({ runId, stream, onClosed, onPublished }) {
    this.runId = runId;
    this.stream = stream;
    this.onClosed = onClosed;
    this.onPublished = onPublished;
    this.projection = createProjection();
    this.activeTab = null;
    this.userPinnedTab = false;
    this.data = null;
    this.selectedCompare = null;
    this.decision = { baseId: null, suggestionIds: new Set() };
    this.busy = false;
    this.el = null;
    this.unsub = null;
  }

  async open() {
    this.data = await api.run(this.runId);
    this.activeTab = activePhaseFor(this.data.run);

    this.unsub = this.stream.onEvent((ev) => this.onStreamEvent(ev));

    this.el = Modal({
      title: this.modalTitle(),
      subtitle: null,
      headerExtra: [],
      body: h('div', { id: 'council-body' }),
      onClose: () => this.close(),
      closable: this.isClosable(),
    });
    mount(document.body, this.el);
    this.render();
    // Focus the active tab so keyboard users land somewhere meaningful.
    this.el.querySelector('.tab[aria-selected="true"]')?.focus();
    return this.el;
  }

  modalTitle() {
    const kind = this.data.run.artifactKind;
    return kind === 'code_plan' ? 'Council Code Plan Writer'
         : kind === 'report' ? 'Single-Pass Report'
         : 'Council Document Generator';
  }

  isClosable() {
    // Esc and ✕ are blocked while a run is active, to prevent accidental loss (§7.2).
    return !['generating', 'reviewing', 'adjudicating', 'synthesizing', 'executing']
      .includes(this.data?.run.state);
  }

  close() {
    if (!this.isClosable()) return;
    this.unsub?.();
    this.el?.remove();
    this.onClosed?.();
  }

  async refresh() {
    const prevState = this.data?.run.state;
    this.data = await api.run(this.runId);
    // Follow the run's phase unless the user has deliberately pinned a tab.
    if (!this.userPinnedTab || prevState !== this.data.run.state) {
      const next = activePhaseFor(this.data.run);
      if (!this.userPinnedTab) this.activeTab = next;
    }
    this.render();
  }

  onStreamEvent(ev) {
    if (ev.payload?.runId && ev.payload.runId !== this.runId) return;
    applyEvent(this.projection, ev);

    // A phase change, settlement or terminal event changes server-side truth, so refetch.
    const refetch = ['run.phase', 'writer.settled', 'review.complete', 'verdict.ready',
                     'verdict.failed', 'synthesis.complete', 'exec.complete', 'exec.blocked',
                     'quality.scored', 'run.failed', 'run.degraded', 'candidate.edited'];
    if (refetch.includes(ev.type)) { this.refresh().catch(() => {}); return; }
    this.renderBody();
  }

  render() {
    if (!this.el) return;
    const head = this.el.querySelector('.modal-head');
    clear(head);
    const run = this.data.run;

    mount(head, 
      h('div', { class: 'stack stack-1 grow' },
        h('h2', { id: 'modal-title' }, this.modalTitle()),
        h('div', { class: 'row small' },
          // ONE status string, derived from run state.
          h('span', { class: 'muted' }, statusLabel(run)),
          run.degraded && Chip({ label: 'Degraded', tone: 'warning', glyph: '!',
                                 title: run.degradedReason ?? 'This run degraded' }),
          !this.projection.connection && Chip({ label: 'Reconnecting', tone: 'info' }),
        ),
      ),
      h('div', { class: 'row' },
        Chip({ label: run.title, title: run.title }),
        this.isClosable()
          ? Button({ label: '✕', variant: 'ghost', size: 'sm', onClick: () => this.close(), title: 'Close' })
          : h('span', { class: 'caption muted' }, 'Run in progress'),
      ),
    );

    const reachable = reachablePhases(run);
    const tabs = run.phases.filter((p) => p !== 'publish').map((p) => ({
      id: p,
      label: phaseLabel(p, run.artifactKind, this.data.uiLabels),
      disabled: !reachable.has(p),
    }));

    const body = this.el.querySelector('.modal-body');
    clear(body);
    mount(body, 
      Tabs({ tabs, active: this.activeTab, onSelect: (id) => { this.activeTab = id; this.userPinnedTab = true; this.render(); } }),
      h('div', { id: 'council-body', class: 'stack stack-4', style: 'padding-top:var(--space-4)' }),
    );
    this.renderBody();
    this.renderFooter();
  }

  renderFooter() {
    let foot = this.el.querySelector('.modal-foot');
    if (!foot) { foot = h('div', { class: 'modal-foot' }); this.el.querySelector('.modal').append(foot); }
    clear(foot);
    const run = this.data.run;
    const cost = this.data.cost;

    mount(foot, 
      h('div', { class: 'row small grow wrap' },
        // FR-COST-004: cost is EXPOSED in the UI. The pilot had no cost surface at all.
        Chip({ label: `${cost.total.premiumRequests} premium requests`, glyph: '\u25c8',
               title: 'Actual consumption so far' }),
        Chip({ label: `${cost.total.totalTokens.toLocaleString()} tokens` }),
        run.estimate && Chip({
          label: `est ${run.estimate.premiumRequests}`,
          tone: cost.variancePercent != null && Math.abs(cost.variancePercent) > 25 ? 'warning' : '',
          title: cost.variancePercent != null ? `Actual vs estimate: ${cost.variancePercent}%` : 'Pre-run estimate',
        }),
        this.data.budgetState && Chip({
          label: `budget ${this.data.budgetState.premiumRequests.remaining} left today`,
          tone: this.data.budgetState.warning ? 'warning' : '',
        }),
      ),
      ['generating', 'reviewing', 'adjudicating'].includes(run.state) &&
        Button({ label: 'Cancel run', variant: 'secondary',
                 onClick: async () => { await api.cancelRun(this.runId); toast('Cancellation requested — partial results are retained.', 'info'); } }),
    );
  }

  renderBody() {
    const host = this.el?.querySelector('#council-body');
    if (!host) return;
    clear(host);
    const run = this.data.run;

    for (const n of this.projection.notices.slice(-3)) {
      mount(host, Banner({ tone: n.kind, message: n.text }));
    }
    if (run.degraded && run.degradedReason) {
      mount(host, Banner({ tone: 'warning', title: 'This run is degraded', message: run.degradedReason,
                           requirementId: 'FR-COUNCIL-009' }));
    }
    if (!this.projection.connection) {
      mount(host, Banner({ tone: 'info', message: 'Reconnecting to run… the run continues on the server.' }));
    }

    switch (this.activeTab) {
      case 'configure':  mount(host, this.renderConfigure()); break;
      case 'generate':   mount(host, this.renderGenerate()); break;
      case 'review':     mount(host, this.renderReview()); break;
      case 'compare':    mount(host, this.renderCompare()); break;
      case 'adjudicate': mount(host, this.renderAdjudicate()); break;
      case 'execute':    mount(host, this.renderExecute()); break;
      default:           mount(host, this.renderAdjudicate());
    }
  }

  // €€ 4.1 Configure €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderConfigure() {
    const run = this.data.run;
    const sel = run.writerSelection;
    return frag(
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Input summary'),
        h('div', { class: 'panel-body' },
          KV(Object.entries(run.inputs).map(([k, v]) => [k, typeof v === 'string' && v.length > 160 ? v.slice(0, 157) + '…' : v]))),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' },
          run.artifactKind === 'code_plan' ? 'Plan authors' : 'Council authors',
          h('span', { class: 'count' }, `${sel.length}/${sel.length} selected, min 1`)),
        h('div', { class: 'panel-body grid-3' },
          sel.map((w) => h('div', { class: 'card card-selected stack stack-2' },
            h('div', { class: 'row' },
              h('strong', {}, w.displayName),
              h('span', { class: 'right', 'aria-hidden': 'true' }, '✓')),
            Chip({ label: w.focusChip, overline: true, tone: 'accent' }),
            h('div', { class: 'small secondary' }, this.rosterDetail(w.profileId)?.roleDescription ?? ''),
            h('div', { class: 'small accent-text' }, `Looks for: ${this.rosterDetail(w.profileId)?.looksFor ?? ''}`),
            h('div', { class: 'row caption' },
              Chip({ label: w.modelDisplayName }),
              Chip({ label: w.family, title: 'Model family — distinctness is enforced on this' }),
              w.deprecated && Chip({ label: 'deprecated', tone: 'warning' })),
          ))),
      ),
      this.data.skill.artifactKind !== 'report' && this.data.verdict !== undefined && h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Captain'),
        h('div', { class: 'panel-body stack stack-3' },
          h('div', { class: 'row' },
            h('strong', {}, 'Captain'), h('span', { class: 'muted' }, '· Synthesis & Verdict'),
            Badge({ label: 'Captain' })),
          // AM-10: shown READ-ONLY. The Captain model is fixed by policy, not user-selectable.
          h('div', { class: 'row caption' },
            Chip({ label: this.data.verdict?.modelDisplayName ?? 'policy model' }),
            h('span', { class: 'muted' }, 'Model fixed by policy — not selectable')),
          h('div', { class: 'row caption' },
            h('span', { class: 'overline' }, 'Mode'),
            Chip({ label: run.captainMode ?? '—', tone: 'accent' })),
        ),
      ),
    );
  }

  rosterDetail(profileId) {
    return this._roster?.find((r) => r.id === profileId) ?? null;
  }

  // €€ 4.2 Generate €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderGenerate() {
    const run = this.data.run;
    const live = [...this.projection.writers.values()];
    const writers = live.length ? live : run.writerSelection.map((w) => ({
      profileId: w.profileId, displayName: w.displayName, modelDisplayName: w.modelDisplayName,
      state: 'waiting', steps: [],
    }));

    const cols = writers.map((w) => {
      const cand = this.data.candidates.find((c) => c.writerProfileId === w.profileId && c.origin === 'writer');
      const stateChip = w.state === 'done' ? Chip({ label: 'Done', tone: 'success', glyph: '\u2713' })
                      : w.state === 'failed' ? Chip({ label: 'Failed', tone: 'danger', glyph: '\u2715' })
                      : w.state === 'generating' ? Chip({ label: 'Generating…', tone: 'info' })
                      : Chip({ label: 'Waiting to start' });

      return h('div', { class: 'card writer-col' },
        h('div', { class: 'row' },
          h('strong', { class: 'grow' }, w.displayName ?? w.profileId),
          stateChip),
        h('div', { class: 'row caption' }, Chip({ label: w.modelDisplayName ?? '—' })),

        // A failed writer's error appears IN THAT WRITER'S COLUMN (§7.6: errors are placed
        // where the cause is), and the run continues on quorum.
        w.error && Banner({ tone: 'danger', message: `${w.displayName} failed: ${w.error}` }),

        h('div', { class: 'steplog', 'aria-live': 'polite', 'aria-label': `Progress for ${w.displayName}` },
          w.steps.length === 0 && h('div', { class: 'muted caption' }, 'Waiting to start…'),
          w.steps.slice(-8).map((s) => h('div', { class: 'steplog-line' },
            h('span', { class: 'tick', 'aria-hidden': 'true' }, s.status === 'done' ? '✓' : '·'),
            h('span', { class: 'grow' }, s.step),
            h('span', { class: 'elapsed' }, s.status === 'done' ? '' : duration(s.elapsedMs)))),
        ),
        h('div', { class: 'row caption muted' },
          h('span', {}, (cand ? cand.wordCount : w.words ?? 0) + ' words'),
          h('span', { class: 'right' }, w.premiumRequests != null ? `${w.premiumRequests} PR` : ''),
        ),
        cand && cand.placeholders.length > 0 && Chip({
          label: `${cand.placeholders.length} unresolved placeholder${cand.placeholders.length === 1 ? '' : 's'}`,
          tone: 'warning', glyph: '!' }),
      );
    });

    return frag(
      h('div', { class: 'grid-3' }, cols),
      this.projection.degradedReason && Banner({ tone: 'warning', message: this.projection.degradedReason }),
    );
  }

  // €€ 4.3 Self & Peer Eval €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderReview() {
    const { aggregates, reviews, consensus, reviewProgress } = this.data;
    if (reviews.length === 0) {
      return EmptyState({ title: 'No reviews yet',
                          message: `Evaluating… ${reviewProgress.actual} of ${reviewProgress.expected} reviews complete.` });
    }

    const rubric = this.data.skill.artifactKind === 'code_plan'
      ? ['feasibility', 'completeness', 'sequencing', 'riskManagement', 'clarity']
      : this.data.skill.artifactKind === 'report'
        ? ['accuracy', 'coverage', 'severity', 'actionability', 'clarity']
        : ['clarity', 'completeness', 'accuracy', 'relevance', 'quality'];
    const labels = { riskManagement: 'Risk Management', actionability: 'Actionability' };
    const lbl = (k) => labels[k] ?? k.charAt(0).toUpperCase() + k.slice(1);

    const evaluators = [...new Set(reviews.map((r) => r.evaluatorProfileId))];

    return frag(
      h('div', { class: 'row' },
        h('h3', { class: 'grow' }, 'Self & Peer Evaluation'),
        Chip({ label: `${reviewProgress.actual} of ${reviewProgress.expected} reviews` })),
      h('div', { class: 'small muted' },
        'Each author evaluates all candidates including their own. Self-reviews are flagged and excluded from the peer average.'),

      h('div', { class: 'grid-3' }, aggregates.map((a) => h('div', { class: 'card stack stack-2' },
        ScoreTile({ value: a.peerAverage, label: a.writerDisplayName, caption: 'peer average' }),
        h('div', { class: 'row caption wrap' },
          Chip({ label: a.modelDisplayName }),
          // Self-score shown SEPARATELY, with the bias it would have introduced (AM-09).
          a.selfScore != null && Chip({ label: `self ${a.selfScore}`, tone: '', title: 'Self-review — excluded from the peer average' }),
          a.selfBias != null && Chip({ label: `bias ${a.selfBias > 0 ? '+' : ''}${a.selfBias}`,
                                       tone: a.selfBias > 8 ? 'warning' : '',
                                       title: 'How much the self-review would have inflated this candidate had it counted' }),
        ),
        // FR-REV-006: the single most direct mitigation of the rubber-stamp risk — it tells
        // the reviewer where to look.
        a.contested
          ? Banner({ tone: 'warning', message: `Contested · ${a.scoreRange}. Evaluators disagreed substantially about this draft. Worth your attention.`, requirementId: 'FR-REV-006' })
          // A 20-point spread sits exactly on the threshold, so calling it "broadly agreed"
          // would overstate the consensus. Say what the number is and let the reader judge.
          : h('div', { class: 'caption muted' },
              a.scoreSpread >= 14
                ? `Spread ${a.scoreSpread} points — some disagreement, below the ${20}-point threshold.`
                : `Spread ${a.scoreSpread} points — evaluators broadly agreed.`),
        a.highestRatedBy && h('div', { class: 'caption muted' }, `${a.highestRatedBy} rated this highest.`),
        h('div', { class: 'stack stack-1' },
          rubric.map((c) => RubricMeter({ label: lbl(c), value: a.criterionAverages[c] }))),
      ))),

      // ReviewMatrix: evaluators as columns, candidates as rows, contested rows marked.
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Review matrix', h('span', { class: 'count' }, `${reviews.length} reviews`)),
        h('div', { class: 'panel-body', style: 'overflow-x:auto' },
          h('table', { role: 'grid' },
            h('thead', {}, h('tr', {},
              h('th', {}, 'Candidate'),
              evaluators.map((e) => h('th', { class: 'num' },
                reviews.find((r) => r.evaluatorProfileId === e)?.evaluatorDisplayName ?? e)),
              h('th', { class: 'num' }, 'Peer avg'))),
            h('tbody', {}, aggregates.map((a) => h('tr', {},
              h('td', {}, h('div', { class: 'row' },
                h('span', {}, a.writerDisplayName),
                a.contested && Chip({ label: `Contested ${a.scoreRange}`, tone: 'warning', glyph: '!' }))),
              evaluators.map((e) => {
                const r = reviews.find((x) => x.evaluatorProfileId === e && x.candidateId === a.candidateId);
                if (!r) return h('td', { class: 'num muted' }, '—');
                return h('td', { class: 'num' },
                  h('span', { class: band(r.overallScore) }, String(r.overallScore)),
                  r.isSelf && frag(' ', Badge({ label: 'Self', tone: 'self' })));
              }),
              h('td', { class: `num ${band(a.peerAverage)}` }, String(a.peerAverage)),
            ))),
          ),
        ),
      ),

      // FR-REV-005: items raised by ≥2 evaluators. This is the signal reviewers act on.
      h('div', { class: 'grid-2' },
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Common strengths'),
          h('div', { class: 'panel-body stack stack-2' },
            consensus.commonStrengths.length === 0
              ? h('div', { class: 'caption muted' }, 'No strength was raised by two or more evaluators.')
              : consensus.commonStrengths.map((s) => h('div', { class: 'row small' },
                  Chip({ label: `${s.evaluatorCount}`, tone: 'success' }), h('span', {}, s.text))))),
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Common concerns'),
          h('div', { class: 'panel-body stack stack-2' },
            consensus.commonConcerns.length === 0
              ? h('div', { class: 'caption muted' }, 'No concern was raised by two or more evaluators.')
              : consensus.commonConcerns.map((s) => h('div', { class: 'row small' },
                  Chip({ label: `${s.evaluatorCount}`, tone: 'warning' }), h('span', {}, s.text))))),
      ),

      h('details', {}, h('summary', {}, 'All individual reviews'),
        h('div', { class: 'stack stack-3', style: 'padding-top:var(--space-3)' },
          reviews.map((r) => h('div', { class: 'card stack stack-2' },
            h('div', { class: 'row' },
              h('strong', {}, r.evaluatorDisplayName),
              h('span', { class: 'muted small' }, '→'),
              h('span', { class: 'small' }, aggregates.find((a) => a.candidateId === r.candidateId)?.writerDisplayName ?? ''),
              r.isSelf && Badge({ label: 'Self', tone: 'self' }),
              h('span', { class: `right score-value ${band(r.overallScore)}`, style: 'font:var(--text-h3)' },
                `${r.overallScore}/100`)),
            h('div', { class: 'grid-2' },
              h('div', { class: 'stack stack-1' },
                h('div', { class: 'overline', style: 'color:var(--status-success)' }, 'Strengths'),
                h('ul', { style: 'margin:0;padding-left:var(--space-5)' },
                  r.strengths.map((s) => h('li', { class: 'small' }, s)))),
              h('div', { class: 'stack stack-1' },
                h('div', { class: 'overline', style: 'color:var(--status-warning)' }, 'Concerns'),
                h('ul', { style: 'margin:0;padding-left:var(--space-5)' },
                  r.concerns.map((s) => h('li', { class: 'small' }, s))))),
            h('div', { class: 'small secondary' }, r.feedback),
          )))),

      this.proceedButton(this.data.run.phases.includes('compare') ? 'compare' : 'adjudicate',
        this.data.run.phases.includes('compare') ? 'Proceed to Compare' : "Proceed to Captain's Pick"),
    );
  }

  proceedButton(tab, label) {
    return h('div', { class: 'row' },
      Button({ label, variant: 'primary', onClick: () => { this.activeTab = tab; this.userPinnedTab = true; this.render(); } }));
  }

  // €€ 4.4 Compare €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderCompare() {
    const writerCands = this.data.candidates.filter((c) => c.origin === 'writer');
    if (writerCands.length < 2) {
      return EmptyState({ title: 'Comparison unavailable',
                          message: 'Only one candidate completed, so there is nothing to compare side by side.' });
    }
    if (!this.selectedCompare) this.selectedCompare = new Set(writerCands.slice(0, 3).map((c) => c.id));

    // FR-GEN-005 / PlaceholderWarning: a BLOCKING banner listing every unresolved placeholder
    // with the section it is in. The pilot shipped exactly these strings into Confluence.
    const withPlaceholders = writerCands.filter((c) => c.placeholders.length > 0);

    const panes = writerCands.filter((c) => this.selectedCompare.has(c.id));
    return frag(
      withPlaceholders.length > 0 && Banner({
        tone: 'danger',
        title: 'Unresolved placeholders block publication',
        message: withPlaceholders.map((c) =>
          `${c.placeholders.length} in ${c.writerDisplayName} — "${c.placeholders[0].text}" in ` +
          c.placeholders.map((p) => p.sectionHeading).join(', ')).join(' · '),
        requirementId: 'FR-GEN-005',
      }),

      h('div', { class: 'row wrap' },
        h('span', { class: 'small muted grow' }, 'Select 2–3 candidates to compare side by side:'),
        writerCands.map((c) => h('label', { class: 'check-opt small' },
          h('input', {
            type: 'checkbox', checked: this.selectedCompare.has(c.id),
            onchange: (e) => {
              if (e.target.checked) { if (this.selectedCompare.size < 3) this.selectedCompare.add(c.id); else e.target.checked = false; }
              else this.selectedCompare.delete(c.id);
              this.renderBody();
            },
          }),
          h('span', {}, c.writerDisplayName))),
      ),

      h('div', { class: 'compare-grid', style: `grid-template-columns:repeat(${panes.length},minmax(0,1fr))` },
        panes.map((c) => h('div', { class: 'compare-pane-wrap' },
          h('div', { class: 'compare-pane-head' },
            h('span', { class: 'dot dot-published', 'aria-hidden': 'true' }),
            h('strong', {}, c.writerDisplayName),
            h('span', { class: 'muted' }, `— ${c.modelDisplayName}`),
            h('span', { class: 'right caption' }, `${c.wordCount.toLocaleString()} words`)),
          h('div', { class: 'compare-pane-body', tabindex: '0',
                     'aria-label': `${c.writerDisplayName} draft` },
            DocumentView(c.body, { compare: true })))),
      ),

      this.proceedButton('adjudicate', "Proceed to Captain's Pick"),
    );
  }

  // €€ 4.5 Captain's Pick — THE most important screen €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderAdjudicate() {
    const run = this.data.run;
    const verdict = this.data.verdict;
    const writerCands = this.data.candidates.filter((c) => c.origin === 'writer');

    if (['generating', 'reviewing'].includes(run.state)) {
      return EmptyState({ title: 'Not yet', message: statusLabel(run) });
    }

    if (run.state === 'adjudicating') {
      return h('div', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('span', {}, 'Captain deliberating…'));
    }

    // Captain failure: candidates and reviews preserved, THREE labelled options, and the last
    // one explicitly marked as unadjudicated (council-engine-spec §10).
    if (!verdict && run.state === 'awaiting_human') {
      return frag(
        Banner({ tone: 'danger', title: 'The Captain did not return a verdict',
                 message: run.degradedReason ?? 'Candidates and reviews are preserved.' }),
        h('div', { class: 'row wrap' },
          Button({ label: 'Retry Captain', onClick: () => this.readjudicate(run.captainMode) }),
          Button({ label: 'Retry in Peer Scored mode (cheaper)', onClick: () => this.readjudicate('peer_scored') }),
          Button({ label: 'Proceed with highest peer average (no verdict)', variant: 'secondary',
                   onClick: () => this.submitDecision(this.data.aggregates
                     .slice().sort((a, b) => b.peerAverage - a.peerAverage)[0]?.candidateId, []) })),
      );
    }

    if (!verdict) {
      const finalCand = this.data.candidates.slice(-1)[0];
      return frag(
        Banner({ tone: 'info', message: `This is a single-pass ${run.artifactKind} — there is no council verdict to adjudicate.` }),
        finalCand && h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Report'),
          h('div', { class: 'panel-body' }, DocumentView(finalCand.body))),
      );
    }

    if (!this.decision.baseId) this.decision.baseId = verdict.winnerCandidateId;
    const winnerAgg = this.data.aggregates.find((a) => a.candidateId === verdict.winnerCandidateId);
    const selCount = this.decision.suggestionIds.size;
    const total = verdict.suggestions.length;
    const decided = !['awaiting_human'].includes(run.state);

    return frag(
      // VerdictCard
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Verdict'),
        h('div', { class: 'panel-body stack stack-3' },
          h('div', { class: 'row wrap' },
            h('strong', {}, 'Captain'), h('span', { class: 'muted' }, '· Synthesis & Verdict'),
            Chip({ label: verdict.captainMode, tone: 'accent',
                   title: 'What the Captain was shown. A verdict is not interpretable without this.' }),
            Chip({ label: verdict.modelDisplayName }),
            h('span', { class: 'right' }, Badge({ label: 'Winner selected', tone: 'winner' }))),
          h('div', {}, verdict.rationale),
          winnerAgg?.contested && Banner({ tone: 'warning',
            message: `Evaluators disagreed about the winning draft (${winnerAgg.scoreRange}). Review the concerns before approving.` }),
          // FR-ADJ-003: the FULL analysis in a disclosure, not a summary line. Rendered
          // through the same sanitising path as every other artifact — it is model output.
          h('details', {}, h('summary', {}, "Captain's full analysis"),
            h('div', { class: 'doc', style: 'padding-top:var(--space-3)',
                       html: renderMarkdown(verdict.fullAnalysis) })),
        ),
      ),

      // DecisionPanel — ONE decision (FR-HUM-001). The pilot had two competing radio groups
      // over the same three candidates.
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Your decision'),
        h('div', { class: 'panel-body stack stack-5' },
          h('div', { class: 'stack stack-2' },
            h('div', { class: 'overline' }, `1. Base ${run.artifactKind === 'code_plan' ? 'plan' : 'document'}`),
            h('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': 'Base candidate' },
              writerCands.map((c) => {
                const agg = this.data.aggregates.find((a) => a.candidateId === c.id);
                return h('label', { class: 'radio-opt' },
                  h('input', { type: 'radio', name: 'base', checked: this.decision.baseId === c.id,
                               disabled: decided,
                               onchange: () => { this.decision.baseId = c.id; this.renderBody(); } }),
                  h('span', { class: 'stack stack-1' },
                    h('span', { class: 'row' },
                      h('strong', {}, c.writerDisplayName),
                      c.id === verdict.winnerCandidateId && Badge({ label: 'Winner', tone: 'winner' }),
                      agg?.contested && Chip({ label: 'Contested', tone: 'warning', glyph: '!' })),
                    h('span', { class: 'caption muted' },
                      `${c.modelDisplayName} · ${c.wordCount.toLocaleString()} words · peer ${agg?.peerAverage ?? '—'}` +
                      (c.placeholders.length ? ` · ${c.placeholders.length} placeholder(s)` : ''))));
              })),
          ),

          total > 0 && h('div', { class: 'stack stack-2' },
            h('div', { class: 'row' },
              h('span', { class: 'overline grow' }, '2. Improvements to apply'),
              h('span', { class: 'small' }, `${selCount}/${total} selected`),
              !decided && Button({ label: selCount === total ? 'Deselect all' : 'Select all', variant: 'ghost', size: 'sm',
                       onClick: () => {
                         if (selCount === total) this.decision.suggestionIds.clear();
                         else for (const s of verdict.suggestions) this.decision.suggestionIds.add(s.id);
                         this.renderBody();
                       } })),
            h('div', { class: 'stack stack-2' },
              verdict.suggestions.map((s) => {
                const on = this.decision.suggestionIds.has(s.id);
                return h('label', {
                  class: 'check-opt card',
                  style: on ? 'border-left:3px solid var(--accent-default);background:var(--accent-subtle)' : '',
                }, h('input', { type: 'checkbox', checked: on, disabled: decided,
                      onchange: (e) => { e.target.checked ? this.decision.suggestionIds.add(s.id) : this.decision.suggestionIds.delete(s.id); this.renderBody(); } }),
                  h('span', { class: 'stack stack-1' },
                    // FR-ADJ-002: EVERY suggestion attributed to its source candidate.
                    h('span', { class: 'caption accent-text' }, s.sourceLabel),
                    // Model-authored text: rendered through the sanitising markdown path so a
                    // **section name** reads as emphasis rather than literal asterisks.
                    h('span', { class: 'small', html: renderMarkdown(s.text).replace(/^<p>|<\/p>$/g, '') })));
              })),
          ),

          !decided && h('div', { class: 'stack stack-2' },
            Button({
              label: selCount > 0
                ? `Build ${run.artifactKind === 'code_plan' ? 'from plan' : 'document'} with ${selCount} improvement${selCount === 1 ? '' : 's'}`
                : `Use ${writerCands.find((c) => c.id === this.decision.baseId)?.writerDisplayName ?? 'this candidate'} unchanged`,
              variant: 'primary', busy: this.busy,
              onClick: () => this.submitDecision(this.decision.baseId, [...this.decision.suggestionIds]),
            }),
            // FR-HUM-004: publishing the base unmodified, with zero suggestions, is always
            // available as its own action.
            selCount > 0 && Button({
              label: `Use ${writerCands.find((c) => c.id === this.decision.baseId)?.writerDisplayName} unchanged`,
              variant: 'secondary', busy: this.busy,
              onClick: () => this.submitDecision(this.decision.baseId, []),
            }),
            h('div', { class: 'row wrap caption' },
              h('span', { class: 'muted' }, 'Or:'),
              // FR-HUM-005: re-adjudicate under a different mode WITHOUT re-running writers.
              Button({ label: 'Re-adjudicate · Evidence Only', variant: 'ghost', size: 'sm',
                       onClick: () => this.readjudicate('evidence_only') }),
              Button({ label: 'Re-adjudicate · Peer Scored', variant: 'ghost', size: 'sm',
                       onClick: () => this.readjudicate('peer_scored') }),
              Button({ label: 'Reject run', variant: 'ghost', size: 'sm',
                       onClick: async () => { await api.decide(this.runId, { action: 'reject' }); this.refresh(); } })),
          ),

          decided && Banner({ tone: 'success',
            message: `Decision recorded by ${this.data.decisions.slice(-1)[0]?.actor ?? 'you'}. ${statusLabel(run)}` }),
        ),
      ),

      // The synthesised or chosen artifact.
      this.renderFinalArtifact(),
    );
  }

  renderFinalArtifact() {
    const final = this.data.candidates.find((c) => c.origin === 'human_edit')
               ?? this.data.candidates.find((c) => c.origin === 'synthesis');
    if (!final) return null;
    return h('div', { class: 'panel' },
      h('div', { class: 'section-bar' }, 'Result',
        h('span', { class: 'count' }, `${final.wordCount.toLocaleString()} words · ${final.sections.length} sections`)),
      h('div', { class: 'panel-body stack stack-3' },
        final.placeholders.length > 0 && Banner({
          tone: 'danger', title: 'Publication is blocked',
          message: `${final.placeholders.length} unresolved placeholder(s) in ${final.placeholders.map((p) => p.sectionHeading).join(', ')}. Resolve them with an edit before publishing.`,
          requirementId: 'FR-GEN-005',
          actions: [Button({ label: 'Edit to resolve', variant: 'primary', size: 'sm',
                             onClick: () => this.openEditor(final) })],
        }),
        h('div', { class: 'row caption' },
          Chip({ label: final.origin === 'human_edit' ? 'Human revision' : 'Synthesised' }),
          Chip({ label: final.writerDisplayName })),
        DocumentView(final.body),
      ),
    );
  }

  // €€ 5.1 Execute — changed files and diff €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderExecute() {
    const ex = this.data.execution;
    if (!ex) {
      return this.projection.execSteps.length
        ? h('div', { class: 'stack stack-2' }, this.projection.execSteps.map((s) => h('div', { class: 'steplog-line' },
            h('span', { class: 'tick' }, s.status === 'done' ? '✓' : '·'), h('span', {}, s.step))))
        : EmptyState({ title: 'Not executed yet', message: 'Choose a plan at the Captain’s Pick step first.' });
    }

    if (!this._activeFile) this._activeFile = ex.files[0]?.path ?? null;
    const active = ex.files.find((f) => f.path === this._activeFile) ?? ex.files[0];

    return frag(
      ex.secretFindings.length > 0 && Banner({
        tone: 'danger', title: 'Secret detected — this change cannot be proposed as a PR',
        message: ex.secretFindings[0].message, requirementId: 'NFR-SEC-007' }),

      h('div', { class: 'grid-2', style: 'grid-template-columns:minmax(0,1fr) minmax(0,2fr)' },
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, `Files changed (${ex.files.length})`),
          h('div', { class: 'panel-body stack stack-3' },
            h('div', { class: 'filetree' }, ex.files.map((f) => h('button', {
              class: f.path === active?.path ? 'active' : '', type: 'button',
              onclick: () => { this._activeFile = f.path; this.renderBody(); },
            }, h('span', { class: `op op-${f.op === 'add' ? 'A' : 'M'}` }, f.op === 'add' ? 'A' : 'M'),
               h('span', { class: 'grow', style: 'overflow:hidden;text-overflow:ellipsis' },
                 f.path.split('/').slice(-1)[0]),
               h('span', { class: 'caption muted' }, `+${f.linesAdded}`)))),

            // FR-EXE-003: "not measured", NEVER 0/0. The pilot showed Tests: 0/0 beside a PR
            // that demonstrably contained tests — a counter contradicting visible reality
            // costs more trust than no counter.
            h('div', { class: 'sunken stack stack-1' },
              h('div', { class: 'overline' }, 'Test summary'),
              h('div', { class: 'row small' }, h('span', { class: 'grow' }, 'Tests'),
                h('span', { class: ex.testsMeasured ? '' : 'muted' },
                  ex.testsMeasured ? `${ex.testsPassed}/${ex.testsTotal}` : 'not measured')),
              h('div', { class: 'row small' }, h('span', { class: 'grow' }, 'Coverage'),
                h('span', { class: ex.testsMeasured ? '' : 'muted' },
                  ex.testsMeasured ? `${ex.coveragePct}%` : 'not measured')),
              !ex.testsMeasured && h('div', { class: 'caption muted' },
                'No test run was executed in the sandbox, so no figure is reported.')),

            KV([['Repository', ex.repository], ['Branch', ex.branchName], ['Base', ex.baseBranch],
                ['Sandbox', ex.sandboxRuntime], ['Workspace', ex.workspacePath],
                ['Fork detected', ex.forkDetected ? 'yes' : 'no']]),
          ),
        ),
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, active?.path ?? 'No file',
            h('span', { class: 'count' },
              `${ex.files.length} files, +${ex.linesAdded} -${ex.linesRemoved}`)),
          h('div', { class: 'panel-body' },
            active ? DiffView(active.beforeBody, active.afterBody)
                   : EmptyState({ title: 'No changes', message: 'The plan produced no file changes. Review the plan before retrying.' })),
        ),
      ),
    );
  }

  // €€ actions €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  async submitDecision(baseId, suggestionIds) {
    this.busy = true; this.renderBody();
    try {
      await api.decide(this.runId, { action: 'accept', baseCandidateId: baseId, appliedSuggestionIds: suggestionIds });
      toast('Decision recorded.', 'success');
      await this.refresh();
      this.onPublished?.();   // the host refreshes the rail and may open the next gate
    } catch (err) {
      toast(err.message, 'danger', 9000);
    } finally { this.busy = false; this.renderBody(); }
  }

  async readjudicate(mode) {
    try {
      await api.decide(this.runId, { action: 'readjudicate', captainMode: mode });
      toast(`Re-adjudicating in ${mode} mode — the writers are not re-run.`, 'info');
      this.userPinnedTab = false;
      await this.refresh();
    } catch (err) { toast(err.message, 'danger', 9000); }
  }

  openEditor(candidate) {
    const ta = h('textarea', { rows: '22', style: 'font:var(--text-mono-small)' });
    ta.value = candidate.body;
    const summary = h('input', { type: 'text', placeholder: 'What did you change, and why?' });
    const modal = Modal({
      title: 'Edit before publishing', size: 'md', labelledBy: 'edit-title',
      subtitle: 'Your revision is recorded as a new version with provenance. The original is never altered.',
      body: h('div', { class: 'stack stack-3' },
        Banner({ tone: 'info', message: 'Resolve every TBD [UNKNOWN …] marker. Publication stays blocked until none remain.' }),
        h('div', { class: 'field' }, h('label', { for: 'edit-summary' }, 'Change summary'), summary),
        ta),
      footer: frag(
        Button({ label: 'Save revision', variant: 'primary', onClick: async () => {
          try {
            await api.editCandidate(candidate.id, { body: ta.value, summary: summary.value || 'Human revision.' });
            toast('Revision saved.', 'success');
            modal.remove();
            await this.refresh();
          } catch (err) { toast(err.message, 'danger', 9000); }
        } }),
        Button({ label: 'Cancel', onClick: () => modal.remove() }),
      ),
      onClose: () => modal.remove(),
    });
    mount(document.body, modal);
    ta.focus();
  }

  setRoster(roster) { this._roster = roster; return this; }
}
