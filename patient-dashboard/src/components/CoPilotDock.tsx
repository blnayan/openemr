/**
 * Clinical Co-Pilot floating dock.
 *
 * In #33 we wired the SSE stream end-to-end:
 *
 *   - The input pill's Send button (and Enter key) call
 *     `useChatStream().submit(question)`.
 *   - The conversation body renders one `(question, answer)` pair per
 *     completed turn from `history`, plus the live `current` turn while
 *     streaming.
 *   - Citation chips render in a deduped row beneath each answer
 *     (color-split: blue for chart/rule, amber for documents).
 *
 * Markdown-bold rendering of the summary and Suggested-next chip
 * rendering are still OUT OF SCOPE — they land in #34.
 *
 * Escape handling: a single `keydown` listener on `document` so the dock
 * closes regardless of which element holds focus. The listener mounts
 * only while the dock is open and tears down on unmount or close.
 */

import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import { X } from 'lucide-react';

import { AnswerBubble } from '../copilot/AnswerBubble';
import { QuestionBubble } from '../copilot/QuestionBubble';
import {
    useChatStream,
    type UseChatStreamResult,
} from '../copilot/useChatStream';

const DOCK_BASE =
    'fixed bottom-4 right-4 z-1001 bg-bg-card border border-border-2 rounded-6 shadow-dock flex flex-col overflow-hidden font-sans text-ink';
const HEAD =
    'flex items-center gap-2.5 py-2.75 px-3.5 border-b border-border-soft';
const BADGE =
    'w-6.5 h-6.5 rounded-4 bg-blue text-white flex items-center justify-center text-xs font-semibold flex-none';
const CTRL =
    'w-5.5 h-5.5 border-0 rounded-3 bg-transparent text-inherit inline-flex items-center justify-center cursor-pointer text-xs leading-none p-0 hover:bg-bg-control-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-1';
const CTX =
    'py-1.75 px-3.5 text-xs text-ink-muted bg-bg-rail border-b border-border-soft flex items-center gap-1.5';
const CTX_PILL =
    'bg-blue-soft text-blue py-0.5 px-2 rounded-3 font-medium text-xs font-mono';
const BODY_BASE =
    'flex flex-col gap-2.5 py-3 px-3.5 overflow-auto min-h-20 flex-1';
const EMPTY = 'text-xs text-ink-faint italic py-1';
const ERROR_NOTICE =
    'text-xs text-severe bg-severe-bg border border-severe rounded-4 py-1.75 px-2.5 mt-1';
const INPUT_OUTER = 'border-t border-border-soft pt-2 px-2.5 pb-2.5';
const INPUT_BOX =
    'flex gap-1.5 items-center bg-bg-page border border-border rounded-4 py-1.25 pl-2.5 pr-1.25 focus-within:border-blue focus-within:shadow-input-focus focus-within:bg-bg-card';
const INPUT_FIELD =
    'flex-1 border-0 text-xs outline-0 bg-transparent py-0.75 text-ink placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60';
const SEND_BTN =
    'bg-blue text-white border-0 rounded-3 py-1.25 px-2.75 text-xs font-semibold cursor-pointer hover:brightness-105 focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:filter-none';

/**
 * Canned question that auto-fires once per dock-open session in
 * `previsit` mode. Mirrors the legacy `agent-sidebar.js` PREVISIT_QUESTION
 * so the agent's pre-visit code path is exercised the same way it always
 * has been; the response renders through AnswerBubble like any other turn,
 * with `claim.section` driving the per-claim section label.
 */
const PREVISIT_QUESTION =
    "Give me a brief pre-visit triage glance — only what could change today's plan.";

interface CoPilotDockProps {
    /** Whether the dock is mounted-and-visible. When false, returns null. */
    isOpen: boolean;
    /** Close handler — wired to the ✕ control AND the Escape key. */
    onClose: () => void;
    /**
     * SMART OAuth `patient` claim — exposed so future chart-switch logic
     * can re-key conversation state. Not displayed directly in v1.
     */
    patientId: string;
    /**
     * Display name from the bound Patient resource (`PatientDTO.name`).
     * Used both in the context-bar pill and woven into the input
     * placeholder ("Ask a follow-up about <First>…").
     */
    patientName: string;
    /**
     * First-name slice for the placeholder copy. Kept as a separate prop
     * so the orchestrator owns name parsing — the dock should not have
     * to know whether the bound DTO splits given/family or not.
     */
    patientFirstName: string;
    /**
     * Optional chat-stream hook injection point — used by tests to
     * supply canned streaming state. In production the dock instantiates
     * `useChatStream` itself.
     */
    useChatStreamImpl?: () => UseChatStreamResult;
}

export function CoPilotDock({
    isOpen,
    onClose,
    patientId,
    patientName,
    patientFirstName,
    useChatStreamImpl = useChatStream,
}: CoPilotDockProps): React.JSX.Element | null {
    const [draft, setDraft] = useState('');

    const chat = useChatStreamImpl();

    // Close on Escape. Listener is only installed while the dock is open
    // so it doesn't intercept Escape for unrelated UI when the dock is
    // closed (e.g. a future modal elsewhere on the page).
    useEffect(() => {
        if (!isOpen) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [isOpen, onClose]);

    // Auto-fire the previsit pull once per dock-open session. The dock
    // stays mounted while closed (returns null), so the hook state and
    // this ref persist across opens — resetting the ref on close lets a
    // re-open fire a fresh previsit. StrictMode's double-effect-firing
    // is also gated by the ref.
    const previsitFiredRef = useRef(false);
    useEffect(() => {
        if (!isOpen) {
            previsitFiredRef.current = false;
            return;
        }
        if (previsitFiredRef.current) return;
        previsitFiredRef.current = true;
        chat.submit(PREVISIT_QUESTION, { mode: 'previsit' });
    }, [isOpen, chat]);

    const handleSubmit = useCallback(() => {
        const text = draft.trim();
        if (text === '') return;
        chat.submit(text);
        setDraft('');
    }, [chat, draft]);

    const onInputKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSubmit();
            }
        },
        [handleSubmit],
    );

    // Auto-scroll the conversation body to the bottom as new content
    // streams in. Without this, the dock pins the user at the top of the
    // conversation and they have to scroll manually to see each new
    // delta — defeats the point of streaming.
    const bodyRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        const el = bodyRef.current;
        if (el === null) return;
        el.scrollTop = el.scrollHeight;
    }, [chat.history, chat.current, chat.error]);

    if (!isOpen) {
        return null;
    }

    // Fixed dock dimensions — the dock opens at its max size immediately
    // rather than growing as messages fill in. The body becomes flex-1 so
    // it fills the remaining vertical space and scrolls when the
    // conversation overflows. Width is intentionally a touch narrower so
    // the dock doesn't dominate the screen on smaller monitors.
    // Viewport clamp via max-h prevents the dock running off the top on
    // short windows.
    const widthClass = 'w-120';
    const heightClass = 'h-180 max-h-[calc(100vh-2rem)]';
    const dockClassName = `${DOCK_BASE} ${widthClass} ${heightClass}`;

    // Fall back gracefully when the bound Patient resource hasn't filled
    // in a name yet — show a short hash of the patient id instead. The
    // orchestrator already gates `isOpen` on having a Patient, but this
    // keeps the component robust if that contract ever loosens.
    const displayName = patientName !== '' ? patientName : shortHash(patientId);
    const placeholderName =
        patientFirstName !== '' ? patientFirstName : displayName;

    const isStreaming = chat.state === 'streaming';
    // 401 / 403 from chat.php — render an explicit "Session expired"
    // notice in the body rather than silently failing.
    const sessionExpired =
        chat.error?.reason === 'session_expired'
        || chat.error?.reason === 'forbidden';

    return (
        <aside
            className={dockClassName}
            role="dialog"
            aria-label="Clinical Co-Pilot"
            data-testid="copilot-dock"
        >
            <div className={HEAD}>
                <div className={BADGE} aria-hidden="true">
                    ✦
                </div>
                <div className="flex-1 min-w-0 leading-[1.2]">
                    <div className="text-base font-semibold text-ink">
                        Clinical Co-Pilot
                    </div>
                    <div className="text-xs text-ok before:content-['●'] before:mr-1">
                        Online
                    </div>
                </div>
                <div className="flex gap-0.5 text-ink-faint">
                    <button
                        type="button"
                        className={CTRL}
                        onClick={onClose}
                        aria-label="Close Clinical Co-Pilot"
                        data-testid="copilot-close"
                    >
                        <X className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
                    </button>
                </div>
            </div>

            <div className={CTX}>
                <span>Asking about</span>
                <span className={CTX_PILL} data-testid="copilot-patient-pill">
                    {displayName}
                </span>
            </div>

            <div
                className={BODY_BASE}
                data-testid="copilot-body"
                ref={bodyRef}
            >
                {chat.history.length === 0
                    && chat.current === null
                    && chat.error === null && (
                        <div
                            className={EMPTY}
                            data-testid="copilot-empty"
                        >
                            Ask a question grounded in this chart to get started.
                        </div>
                    )}
                {chat.history.map((turn) => (
                    <React.Fragment key={turn.id}>
                        <QuestionBubble text={turn.question} />
                        <AnswerBubble answer={turn.answer} />
                    </React.Fragment>
                ))}
                {chat.current !== null && (
                    <React.Fragment key={chat.current.id}>
                        <QuestionBubble text={chat.current.question} />
                        <AnswerBubble
                            answer={chat.current.answer}
                            isStreaming={isStreaming}
                        />
                    </React.Fragment>
                )}
                {sessionExpired && (
                    <div
                        className={ERROR_NOTICE}
                        data-testid="copilot-session-expired"
                        role="alert"
                    >
                        Session expired — please reload.
                    </div>
                )}
                {chat.error !== null && !sessionExpired && (
                    <div
                        className={ERROR_NOTICE}
                        data-testid="copilot-error-notice"
                        role="alert"
                    >
                        {chat.error.message}
                    </div>
                )}
            </div>

            <div className={INPUT_OUTER}>
                <div className={INPUT_BOX}>
                    <input
                        type="text"
                        className={INPUT_FIELD}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={onInputKeyDown}
                        placeholder={`Ask a follow-up about ${placeholderName}…`}
                        aria-label="Ask the Clinical Co-Pilot a question"
                        data-testid="copilot-input"
                        disabled={isStreaming}
                    />
                    <button
                        type="button"
                        className={SEND_BTN}
                        onClick={handleSubmit}
                        disabled={isStreaming || draft.trim() === ''}
                        data-testid="copilot-send"
                    >
                        Send
                    </button>
                </div>
            </div>
        </aside>
    );
}

/**
 * Short, stable hash of a patient id — used as a last-resort fallback
 * for the context pill when a display name isn't available. We don't
 * need cryptographic strength here, just something legible and bounded.
 */
function shortHash(patientId: string): string {
    if (patientId.length <= 8) {
        return patientId;
    }
    return `${patientId.slice(0, 8)}…`;
}
