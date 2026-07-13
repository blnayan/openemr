/**
 * AgentForge sidebar — Web Component for the patient dashboard.
 *
 * Streams SSE responses from /interface/agentforge/chat.php and renders
 * citation-grounded clinical claims with severity indicators. The chat
 * is read-only and additive — the EHR continues to function unchanged
 * if this component fails to load.
 */
(function () {
  'use strict';

  if (customElements.get('agent-sidebar')) {
    return;
  }

  const STYLES = `
    :host {
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 380px;
      max-height: min(70vh, 640px);
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      border-radius: 8px;
      overflow: hidden;
      z-index: 9999;
      background: #fff;
      border: 1px solid #d4d4d8;
      color: #1f2937;
    }
    :host([hidden]) { display: none; }
    :host([data-collapsed="true"]) {
      width: 220px;
      max-height: 44px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #1d4ed8;
      color: #fff;
      cursor: pointer;
      font-weight: 600;
    }
    .status-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: #22c55e;
    }
    .status-dot[data-state="loading"] { background: #f59e0b; animation: pulse 1.4s ease-in-out infinite; }
    .status-dot[data-state="error"]   { background: #ef4444; }
    @keyframes pulse { 50% { opacity: .35; } }
    .body {
      flex: 1; overflow-y: auto;
      padding: 12px;
      display: flex; flex-direction: column; gap: 10px;
      background: #f9fafb;
    }
    :host([data-collapsed="true"]) .body,
    :host([data-collapsed="true"]) .input-row,
    :host([data-collapsed="true"]) .footer-note { display: none; }
    .turn { padding: 8px 10px; border-radius: 6px; }
    .turn.user { background: #e0e7ff; align-self: flex-end; max-width: 92%; }
    .turn.assistant { background: #fff; border: 1px solid #e5e7eb; }
    .summary { font-weight: 600; margin-bottom: 6px; }
    .section-header {
      margin: 10px 0 4px 0;
      padding-bottom: 2px;
      border-bottom: 1px solid #e5e7eb;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #1f2937;
    }
    .section-header[data-section-key="actionItems"] { color: #b45309; }
    .section-empty {
      padding: 4px 8px;
      color: #6b7280;
      font-size: 12px;
      font-style: italic;
    }
    .claim {
      padding: 6px 8px;
      border-radius: 4px;
      margin: 4px 0;
      border-left: 3px solid #9ca3af;
      background: #f3f4f6;
    }
    .claim[data-severity="attention"] {
      border-left-color: #f59e0b;
      background: #fffbeb;
    }
    .claim[data-severity="urgent"] {
      border-left-color: #dc2626;
      background: #fee2e2;
      font-weight: 600;
    }
    .citations { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
    .citation-chip {
      display: inline-block;
      padding: 2px 6px;
      background: #1d4ed8;
      color: #fff;
      border-radius: 10px;
      font-size: 11px;
      cursor: pointer;
      border: none;
    }
    .footer-note {
      padding: 6px 12px;
      background: #fef3c7;
      color: #92400e;
      font-size: 12px;
      border-top: 1px solid #fcd34d;
    }
    .footer-note:empty { display: none; }
    .input-row {
      display: flex;
      gap: 6px;
      padding: 8px;
      border-top: 1px solid #e5e7eb;
      background: #fff;
    }
    textarea {
      flex: 1;
      resize: none;
      min-height: 36px; max-height: 120px;
      padding: 6px 8px;
      border: 1px solid #d4d4d8;
      border-radius: 4px;
      font: inherit;
    }
    button {
      padding: 0 14px;
      background: #1d4ed8;
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
    }
    button:disabled { background: #9ca3af; cursor: not-allowed; }
    .empty-hint {
      color: #6b7280;
      font-style: italic;
      padding: 12px 0;
      text-align: center;
    }
    .typing-dots {
      display: inline-flex;
      gap: 4px;
      padding: 4px 2px;
      align-items: center;
    }
    .typing-dots span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #9ca3af;
      animation: typing-bounce 1.2s ease-in-out infinite;
    }
    .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing-bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30%           { transform: translateY(-4px); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .typing-dots span { animation: typing-fade 1.4s ease-in-out infinite; }
      @keyframes typing-fade { 50% { opacity: 1; } }
    }
  `;

  const PREVISIT_QUESTION =
    "Give me a brief pre-visit triage glance — only what could change today's plan.";

  const TEMPLATE = `
    <style>${STYLES}</style>
    <div class="header" part="header">
      <span class="status-dot" data-state="ready" aria-live="polite"></span>
      <span class="title">Clinical Co-Pilot</span>
      <span style="margin-left:auto;font-weight:400;opacity:.85" class="toggle">_</span>
    </div>
    <div class="body" part="body">
      <div class="empty-hint">Loading pre-visit summary…</div>
    </div>
    <div class="footer-note" part="footer"></div>
    <div class="input-row">
      <textarea aria-label="Ask Co-Pilot" placeholder="Ask a follow-up…" maxlength="4000"></textarea>
      <button type="button" id="send-btn">Send</button>
    </div>
  `;

  class AgentSidebar extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = TEMPLATE;
      this._chatEndpoint = this.getAttribute('data-chat-endpoint') || '/interface/agentforge/chat.php';
      this._conversationEndpoint = this.getAttribute('data-conversation-endpoint') || '/interface/agentforge/conversation.php';
      this._launchEndpoint = this.getAttribute('data-launch-endpoint') || '/interface/agentforge/oauth/launch.php';
      this._pid = this.getAttribute('data-pid');
      this._encounterId = this.getAttribute('data-encounter-id') || null;
      this._patientUuid = this.getAttribute('data-patient-uuid');
      this._conversationId = null;
      this._storageKey = this._pid ? ('agentforge:cid:' + this._pid) : null;
      // Always start a fresh conversation on every mount. The Co-Pilot
      // lives inside the OpenEMR shell's iframe, so Ctrl+R at the top
      // level reloads the parent but the iframe sees navigation.type =
      // 'navigate' (not 'reload') — a reload-only clear would miss the
      // common refresh path. Wiping the pointer unconditionally guarantees
      // refresh = new conversation, which is also the behavior users
      // expect ("I refreshed; the old thread should be gone").
      if (this._storageKey) {
        try { sessionStorage.removeItem(this._storageKey); } catch (_) { /* */ }
      }
      this._loading = false;
      this._smartReady = false;
      this._smartReadyPromise = null;
      this._smartIframe = null;
      this._smartListener = null;

      this._body = this.shadowRoot.querySelector('.body');
      this._dot = this.shadowRoot.querySelector('.status-dot');
      this._textarea = this.shadowRoot.querySelector('textarea');
      this._sendBtn = this.shadowRoot.querySelector('#send-btn');
      this._footer = this.shadowRoot.querySelector('.footer-note');
      this._header = this.shadowRoot.querySelector('.header');

      this._sendBtn.addEventListener('click', () => this._submit());
      this._textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._submit();
        }
      });
      this._header.addEventListener('click', (e) => {
        if (e.target === this._sendBtn) return;
        const collapsed = this.getAttribute('data-collapsed') === 'true';
        this.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
      });
    }

    connectedCallback() {
      // UC-1: pre-visit pull. Auto-run a brief change-summary every time
      // the sidebar mounts so Dr. M sees an answer before they ask anything.
      console.log('[agentforge] sidebar mounted', {
        pid: this._pid,
        patientUuid: this._patientUuid,
        didPrevisit: this._didPrevisit,
      });
      if (this._didPrevisit) return;
      if (!this._patientUuid) {
        console.warn('[agentforge] sidebar has no data-patient-uuid — auto pre-visit skipped');
        const hint = this._body.querySelector('.empty-hint');
        if (hint) hint.textContent = 'Patient context unavailable — open a chart and reload.';
        return;
      }
      this._didPrevisit = true;
      // Kick off the SMART launch in parallel with a small settle delay.
      // The pre-visit fetch will await `_ensureSmartLaunched` before firing.
      this._ensureSmartLaunched().catch((err) => {
        console.error('[agentforge] SMART launch failed', err);
      });
      // Try to replay an existing conversation for this patient before
      // kicking off a fresh pre-visit pull. If replay succeeds the user
      // sees the prior thread on iframe refresh; otherwise we fall through
      // to the normal pre-visit flow.
      this._tryReplay().then((replayed) => {
        if (replayed) {
          console.log('[agentforge] replayed conversation from server', {
            conversation_id: this._conversationId,
          });
          return;
        }
        setTimeout(() => this._submit(PREVISIT_QUESTION, { silent: true, mode: 'previsit' }), 100);
      });
    }

    async _tryReplay() {
      if (!this._storageKey) return false;
      let stored = null;
      try { stored = sessionStorage.getItem(this._storageKey); } catch (_) { return false; }
      if (!stored) return false;
      try {
        const res = await fetch(
          this._conversationEndpoint + '?id=' + encodeURIComponent(stored),
          { credentials: 'same-origin', headers: { 'Accept': 'application/json' } },
        );
        if (!res.ok) {
          // Stale, foreign, or expired — drop the pointer so we never
          // re-attempt with the same dead id.
          try { sessionStorage.removeItem(this._storageKey); } catch (_) { /* */ }
          return false;
        }
        const body = await res.json();
        const messages = Array.isArray(body && body.messages) ? body.messages : [];
        if (messages.length === 0) {
          try { sessionStorage.removeItem(this._storageKey); } catch (_) { /* */ }
          return false;
        }
        // Render each persisted message. Assistant turns with a structured
        // payload (claims, citations, sections, suggestions) re-render to
        // the same fidelity as a live SSE response. Plain assistant turns
        // (legacy rows or Postgres without payload column) fall back to
        // summary-only rendering.
        const hint = this._body.querySelector('.empty-hint');
        if (hint) hint.remove();
        for (const m of messages) {
          if (!m || typeof m.content !== 'string') continue;
          if (m.role === 'user') {
            this._appendUserTurn(m.content);
          } else if (m.role === 'assistant') {
            const turn = this._newAssistantTurn();
            this._renderAssistantPayload(turn, m.payload, m.content);
          }
        }
        this._conversationId = body && body.conversation_id ? body.conversation_id : stored;
        return true;
      } catch (err) {
        console.warn('[agentforge] replay failed', err && err.message);
        return false;
      }
    }

    _renderAssistantPayload(turn, payload, fallbackSummary) {
      this._stopTyping(turn);
      if (!payload || typeof payload !== 'object') {
        turn.summary.textContent = fallbackSummary || '';
        return;
      }
      if (payload.kind === 'previsit') {
        const tag = document.createElement('div');
        tag.style.cssText = 'font-size:11px;color:#6b7280;margin-bottom:4px';
        tag.textContent = 'Pre-visit pull';
        turn.container.insertBefore(tag, turn.summary);
        turn.summary.textContent = payload.summary || fallbackSummary || '';
        const sections = Array.isArray(payload.sections) ? payload.sections : [];
        for (const sec of sections) {
          this._renderSection(turn, sec);
          if (sec.empty) {
            const empty = document.createElement('div');
            empty.className = 'section-empty';
            empty.textContent = sec.empty_message || 'Nothing to report.';
            turn.claims.appendChild(empty);
          } else if (Array.isArray(sec.claims)) {
            for (const claim of sec.claims) this._renderClaim(turn, claim, sec.key);
          }
        }
        return;
      }
      // followup
      turn.summary.textContent = payload.summary || fallbackSummary || '';
      if (Array.isArray(payload.claims)) {
        for (const claim of payload.claims) this._renderClaim(turn, claim, null);
      }
    }

    _renderSection(turn, section) {
      const sec = document.createElement('div');
      sec.className = 'section-header';
      sec.setAttribute('data-section-key', section.key || '');
      sec.textContent = section.label || '';
      turn.claims.appendChild(sec);
    }

    _renderClaim(turn, claim, sectionKey) {
      const div = document.createElement('div');
      div.className = 'claim';
      if (sectionKey) div.setAttribute('data-section', sectionKey);
      div.setAttribute('data-severity', claim.severity || 'info');
      if (claim.severity === 'urgent') div.setAttribute('role', 'alert');
      div.textContent = claim.text || '';
      if (Array.isArray(claim.citation_ids) && claim.citation_ids.length) {
        const cits = document.createElement('div');
        cits.className = 'citations';
        for (const cid of claim.citation_ids) {
          const chip = document.createElement('button');
          chip.className = 'citation-chip';
          chip.type = 'button';
          chip.textContent = this._citationLabel(cid);
          chip.setAttribute('data-citation-id', cid);
          chip.addEventListener('click', () => {
            this.dispatchEvent(new CustomEvent('agent-citation-click', {
              bubbles: true, composed: true,
              detail: { citationId: cid },
            }));
          });
          cits.appendChild(chip);
        }
        div.appendChild(cits);
      }
      turn.claims.appendChild(div);
    }

    _persistConversationId(id) {
      this._conversationId = id;
      if (!this._storageKey || !id) return;
      try { sessionStorage.setItem(this._storageKey, id); } catch (_) { /* */ }
    }

    disconnectedCallback() {
      this._teardownSmartIframe();
    }

    /**
     * Mount a hidden iframe to launch.php and resolve when the callback
     * postMessages `agentforge:smart-ready`. Subsequent calls reuse the
     * pending promise. Times out after 15 s and shows a graceful banner.
     */
    _ensureSmartLaunched() {
      if (this._smartReady) return Promise.resolve();
      if (this._smartReadyPromise) return this._smartReadyPromise;

      this._smartReadyPromise = new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.src = this._launchEndpoint;
        iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.setAttribute('title', 'AgentForge SMART launch');
        this._smartIframe = iframe;

        const expectedOrigin = window.location.origin;
        const onMessage = (event) => {
          if (event.origin !== expectedOrigin) return;
          let payload = event.data;
          // Some browsers deliver the payload as a JSON string.
          if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { return; }
          }
          if (!payload || typeof payload !== 'object') return;
          if (payload.type !== 'agentforge:smart-ready') return;
          cleanup();
          this._smartReady = true;
          resolve();
        };
        const onTimeout = () => {
          cleanup();
          reject(new Error('smart_launch_timeout'));
        };
        const cleanup = () => {
          window.removeEventListener('message', onMessage);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          this._smartListener = null;
          this._teardownSmartIframe();
          this._smartReadyPromise = null;
        };

        this._smartListener = onMessage;
        window.addEventListener('message', onMessage);
        const timeoutHandle = setTimeout(onTimeout, 15000);
        document.body.appendChild(iframe);
      });
      return this._smartReadyPromise;
    }

    _teardownSmartIframe() {
      if (this._smartIframe && this._smartIframe.parentNode) {
        this._smartIframe.parentNode.removeChild(this._smartIframe);
      }
      this._smartIframe = null;
      if (this._smartListener) {
        window.removeEventListener('message', this._smartListener);
        this._smartListener = null;
      }
    }

    _setStatus(state) { this._dot.setAttribute('data-state', state); }

    _appendUserTurn(text) {
      const hint = this._body.querySelector('.empty-hint');
      if (hint) hint.remove();
      const div = document.createElement('div');
      div.className = 'turn user';
      div.textContent = text;
      this._body.appendChild(div);
      this._scroll();
    }

    _newAssistantTurn() {
      const div = document.createElement('div');
      div.className = 'turn assistant';
      const summary = document.createElement('div');
      summary.className = 'summary';
      const claims = document.createElement('div');
      claims.className = 'claims';
      const typing = document.createElement('div');
      typing.className = 'typing-dots';
      typing.setAttribute('role', 'status');
      typing.setAttribute('aria-label', 'Co-Pilot is thinking');
      typing.innerHTML = '<span></span><span></span><span></span>';
      div.appendChild(typing);
      div.appendChild(summary);
      div.appendChild(claims);
      this._body.appendChild(div);
      this._scroll();
      return { container: div, summary, claims, typing };
    }

    _stopTyping(turn) {
      if (turn && turn.typing && turn.typing.parentNode) {
        turn.typing.parentNode.removeChild(turn.typing);
        turn.typing = null;
      }
    }

    _scroll() { this._body.scrollTop = this._body.scrollHeight; }

    async _submit(prefilledText, options) {
      if (this._loading) return;
      const opts = options || {};
      const mode = opts.mode || 'followup';
      const text = (prefilledText !== undefined ? prefilledText : this._textarea.value).trim();
      if (text === '') return;

      this._loading = true;
      this._sendBtn.disabled = true;
      this._setStatus('loading');
      if (prefilledText === undefined) this._textarea.value = '';
      this._footer.textContent = '';

      // Clear the loading hint on the very first turn.
      const hint = this._body.querySelector('.empty-hint');
      if (hint) hint.remove();

      if (!opts.silent) this._appendUserTurn(text);
      const turn = this._newAssistantTurn();
      if (opts.silent) {
        const tag = document.createElement('div');
        tag.style.cssText = 'font-size:11px;color:#6b7280;margin-bottom:4px';
        tag.textContent = 'Pre-visit pull';
        turn.container.insertBefore(tag, turn.summary);
      }

      try {
        // First, make sure the SMART launch has completed. Any failure
        // surfaces as the same "Co-Pilot unavailable" banner we use for
        // other transient errors — the EHR continues to work.
        try {
          await this._ensureSmartLaunched();
        } catch (smartErr) {
          this._setStatus('error');
          console.warn('[agentforge] SMART not ready', smartErr && smartErr.message);
          this._stopTyping(turn);
          turn.summary.textContent = 'Co-Pilot unavailable — EHR unaffected.';
          return;
        }

        console.log('[agentforge] POST /chat', { mode, endpoint: this._chatEndpoint });
        let res = await this._postChat(text, mode);

        // 409 smart_not_launched → re-launch once and retry. This covers
        // session timeouts and the very rare race where the cached SMART
        // token expired between the check and the request.
        if (res.status === 409) {
          let body = null;
          try { body = await res.clone().json(); } catch (_) { /* */ }
          if (body && body.error === 'smart_not_launched') {
            console.log('[agentforge] /chat 409 smart_not_launched — relaunching');
            this._smartReady = false;
            try {
              await this._ensureSmartLaunched();
              res = await this._postChat(text, mode);
            } catch (relaunchErr) {
              this._setStatus('error');
              console.warn('[agentforge] relaunch failed', relaunchErr && relaunchErr.message);
              turn.summary.textContent = 'Co-Pilot unavailable — EHR unaffected.';
              return;
            }
          }
        }

        if (!res.ok) {
          this._stopTyping(turn);
          this._setStatus('error');
          let detail = '';
          try { detail = (await res.clone().text()).slice(0, 200); } catch (_) { /* */ }
          console.warn('[agentforge] /chat returned', res.status, detail);
          turn.summary.textContent = res.status === 403
            ? 'Access denied.'
            : res.status === 429
              ? 'Too many requests — wait a moment.'
              : `Co-Pilot unavailable (HTTP ${res.status}) — EHR unaffected.`;
          return;
        }

        await this._consumeSse(res, turn);
      } catch (err) {
        this._stopTyping(turn);
        this._setStatus('error');
        console.error('[agentforge] fetch error', err);
        turn.summary.textContent = 'Co-Pilot unavailable — EHR unaffected.';
      } finally {
        this._loading = false;
        this._sendBtn.disabled = false;
      }
    }

    _postChat(text, mode) {
      return fetch(this._chatEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({
          question: text,
          conversation_id: this._conversationId,
          encounter_id: this._encounterId ? Number(this._encounterId) : null,
          mode,
        }),
      });
    }

    async _consumeSse(res, turn) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this._handleEvent(block, turn);
        }
      }
      this._setStatus('ready');
    }

    _handleEvent(rawBlock, turn) {
      let event = 'message';
      const dataLines = [];
      for (const line of rawBlock.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      const dataStr = dataLines.join('\n');
      let data = {};
      try { data = dataStr ? JSON.parse(dataStr) : {}; } catch { data = { raw: dataStr }; }

      switch (event) {
        case 'conversation':
          if (data.conversation_id) this._persistConversationId(data.conversation_id);
          break;
        case 'summary':
          this._stopTyping(turn);
          turn.summary.textContent = data.text || '';
          break;
        case 'section': {
          this._stopTyping(turn);
          const sec = document.createElement('div');
          sec.className = 'section-header';
          sec.setAttribute('data-section-key', data.key || '');
          sec.textContent = data.label || '';
          turn.claims.appendChild(sec);
          if (data.empty) {
            const empty = document.createElement('div');
            empty.className = 'section-empty';
            empty.textContent = data.empty_message || 'Nothing to report.';
            turn.claims.appendChild(empty);
          }
          break;
        }
        case 'claim': {
          this._stopTyping(turn);
          const div = document.createElement('div');
          div.className = 'claim';
          if (data.section) div.setAttribute('data-section', data.section);
          div.setAttribute('data-severity', data.severity || 'info');
          if (data.severity === 'urgent') div.setAttribute('role', 'alert');
          div.textContent = data.text || '';
          if (Array.isArray(data.citation_ids) && data.citation_ids.length) {
            const cits = document.createElement('div');
            cits.className = 'citations';
            for (const cid of data.citation_ids) {
              const chip = document.createElement('button');
              chip.className = 'citation-chip';
              chip.type = 'button';
              chip.textContent = this._citationLabel(cid);
              chip.setAttribute('data-citation-id', cid);
              chip.addEventListener('click', () => {
                this.dispatchEvent(new CustomEvent('agent-citation-click', {
                  bubbles: true, composed: true,
                  detail: { citationId: cid },
                }));
              });
              cits.appendChild(chip);
            }
            div.appendChild(cits);
          }
          turn.claims.appendChild(div);
          break;
        }
        case 'footer':
          this._footer.textContent = data.text || '';
          break;
        case 'error':
          this._stopTyping(turn);
          this._setStatus('error');
          turn.summary.textContent = data.reason
            ? 'Co-Pilot error: ' + data.reason
            : 'Co-Pilot error.';
          break;
        case 'done':
          this._stopTyping(turn);
          this._setStatus('ready');
          break;
        default:
          break;
      }
      this._scroll();
    }

    _citationLabel(cid) {
      // tool:get_medications:row-3 → meds #4
      const m = /^tool:([a-z_]+):row-(\d+)$/.exec(cid);
      if (m) {
        const short = m[1].replace(/^get_/, '').replace(/_/g, ' ');
        return short + ' #' + (Number(m[2]) + 1);
      }
      // doc:lab-<id> / doc:intake-<id> → render the raw id (e.g.
      // "doc:lab-449") so the pill carries the source-document
      // attribution verbatim. No friendly-form mapping — the doctor
      // sees the same string used in the AnswerSchema.
      if (/^doc:(lab|intake)-\d+$/.test(cid)) return cid;
      // rule:<category>:<slug> → "<category>:<ACRONYM>-<section>" when
      // the slug carries a recognizable source prefix and section id
      // (e.g. "rule:guideline:ada-standards-of-care-in-diabetes-2026-ch-16-16.1"
      // → "guideline:ADA-16.1"). Falls back to the bare category when
      // the slug doesn't carry a parseable section id.
      //
      // For chunk-id-shaped slugs like
      // "ada-standards-of-care-in-diabetes-2026::ch-13::13.7a::0", the
      // trailing "::0" is a chunk index — prefer the LAST dotted section
      // id ("13.7a") over the trailing integer.
      const r = /^rule:([a-z]+):(.+)$/.exec(cid);
      if (r) {
        const category = r[1];
        const slug = r[2];
        const dottedAll = slug.match(/\d+\.\d+[a-z]?/g);
        const section = dottedAll && dottedAll.length
          ? dottedAll[dottedAll.length - 1]
          : (/(\d+[a-z]?)$/.exec(slug) || [])[1];
        const sourceTok = /^([a-z]+)/.exec(slug);
        if (sourceTok && section) {
          return category + ':' + sourceTok[1].toUpperCase() + '-' + section;
        }
        if (sourceTok) {
          return category + ':' + sourceTok[1].toUpperCase();
        }
        return category;
      }
      return cid;
    }
  }

  customElements.define('agent-sidebar', AgentSidebar);
})();
