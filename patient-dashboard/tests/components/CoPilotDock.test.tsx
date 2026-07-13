import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CoPilotDock } from '../../src/components/CoPilotDock';
import type { UseChatStreamResult } from '../../src/copilot/useChatStream';
import { emptyAnswer } from '../../src/copilot/answerSchema';

const DEFAULT_PROPS = {
  patientId: 'margaret-uuid',
  patientName: 'Margaret L. Chen',
  patientFirstName: 'Margaret L.',
};

/**
 * Build a stub `useChatStream` impl that returns canned state. The
 * production hook requires a Vite/jsdom-friendly streaming fetch mock —
 * here we just want to drive the component's render branches.
 */
function stubChatStream(
  overrides: Partial<UseChatStreamResult> = {},
): () => UseChatStreamResult {
  const submit = overrides.submit ?? vi.fn();
  const abort = overrides.abort ?? vi.fn();
  const result: UseChatStreamResult = {
    state: overrides.state ?? 'idle',
    history: overrides.history ?? [],
    current: overrides.current ?? null,
    error: overrides.error ?? null,
    conversationId: overrides.conversationId ?? null,
    submit,
    abort,
  };
  return () => result;
}

describe('CoPilotDock', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <CoPilotDock isOpen={false} onClose={() => {}} useChatStreamImpl={stubChatStream()} {...DEFAULT_PROPS} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders header, status, context pill, body, and input when open', () => {
    render(
      <CoPilotDock isOpen={true} onClose={() => {}} useChatStreamImpl={stubChatStream()} {...DEFAULT_PROPS} />,
    );

    expect(screen.getByTestId('copilot-dock')).toBeInTheDocument();
    expect(screen.getByText('Clinical Co-Pilot')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Asking about')).toBeInTheDocument();

    const pill = screen.getByTestId('copilot-patient-pill');
    expect(pill).toHaveTextContent('Margaret L. Chen');

    expect(screen.getByTestId('copilot-body')).toBeInTheDocument();
    const input = screen.getByTestId('copilot-input');
    expect(input).toHaveAttribute(
      'placeholder',
      'Ask a follow-up about Margaret L.…',
    );
  });

  it('falls back to a hashed patientId when no display name is provided', () => {
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream()}
        patientId="abcdef-1234-5678-9012"
        patientName=""
        patientFirstName=""
      />,
    );
    const pill = screen.getByTestId('copilot-patient-pill');
    expect(pill).toHaveTextContent('abcdef-1…');
  });

  it('invokes onClose when the ✕ control is clicked', () => {
    const onClose = vi.fn();
    render(
      <CoPilotDock isOpen={true} onClose={onClose} useChatStreamImpl={stubChatStream()} {...DEFAULT_PROPS} />,
    );

    fireEvent.click(screen.getByTestId('copilot-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <CoPilotDock isOpen={true} onClose={onClose} useChatStreamImpl={stubChatStream()} {...DEFAULT_PROPS} />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke onClose on Escape when the dock is closed', () => {
    const onClose = vi.fn();
    render(
      <CoPilotDock isOpen={false} onClose={onClose} useChatStreamImpl={stubChatStream()} {...DEFAULT_PROPS} />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('typing into the input and clicking Send forwards the question to submit()', () => {
    const submit = vi.fn();
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({ submit })}
        {...DEFAULT_PROPS}
      />,
    );

    const input = screen.getByTestId('copilot-input');
    fireEvent.change(input, { target: { value: 'How is the A1c trending?' } });
    fireEvent.click(screen.getByTestId('copilot-send'));

    expect(submit).toHaveBeenCalledWith('How is the A1c trending?');
  });

  it('Enter in the input submits the question (Shift+Enter does not)', () => {
    const submit = vi.fn();
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({ submit })}
        {...DEFAULT_PROPS}
      />,
    );
    // Discard the previsit auto-fire that runs on mount; this test
    // exercises only user-typed submissions.
    submit.mockClear();
    const input = screen.getByTestId('copilot-input');
    fireEvent.change(input, { target: { value: 'Show meds' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith('Show meds');
  });

  it('does not submit empty / whitespace-only questions', () => {
    const submit = vi.fn();
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({ submit })}
        {...DEFAULT_PROPS}
      />,
    );
    submit.mockClear();
    const input = screen.getByTestId('copilot-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('copilot-send'));
    expect(submit).not.toHaveBeenCalled();
  });

  it('auto-fires the canned previsit question with mode=previsit on open', () => {
    const submit = vi.fn();
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({ submit })}
        {...DEFAULT_PROPS}
      />,
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      expect.stringContaining('pre-visit triage'),
      { mode: 'previsit' },
    );
  });

  it('does not auto-fire previsit when the dock stays closed', () => {
    const submit = vi.fn();
    render(
      <CoPilotDock
        isOpen={false}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({ submit })}
        {...DEFAULT_PROPS}
      />,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('renders past turns from history with question and answer bubbles', () => {
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({
          state: 'done',
          history: [
            {
              id: 'turn-1',
              question: 'How is the A1c?',
              answer: {
                summary: 'A1c is at goal.',
                claims: [
                  {
                    text: 'A1c trending down',
                    citation_ids: ['tool:lab_results:row-1'],
                    severity: 'info',
                  },
                ],
                conflicts: [
                  {
                    type: 'source_disagreement',
                    message: 'Intake and chart disagree on metformin dose.',
                    severity: 'attention',
                    evidence_refs: ['ev_1'],
                  },
                ],
                confidence: 'high',
                evidence_catalog: {},
                data_gaps: [
                  {
                    message: 'No recent urine albumin/creatinine ratio found.',
                    severity: 'attention',
                    blocks: ['ckd_staging'],
                  },
                ],
                assumptions: [
                  {
                    message: 'Assuming latest lipid panel was fasting.',
                  },
                ],
              },
            },
          ],
        })}
        {...DEFAULT_PROPS}
      />,
    );

    expect(screen.getByText('How is the A1c?')).toBeInTheDocument();
    expect(screen.getByText('A1c is at goal.')).toBeInTheDocument();
    expect(screen.getByText('Supporting points')).toBeInTheDocument();
    expect(screen.getByText('Conflicts to reconcile')).toBeInTheDocument();
    expect(screen.getByText('Data gaps')).toBeInTheDocument();
    expect(screen.getByText('Assumptions')).toBeInTheDocument();
    const chips = screen.getAllByTestId('copilot-citation-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('Labs');
  });

  it('renders the live streaming answer bubble during streaming state', () => {
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({
          state: 'streaming',
          current: {
            id: 'turn-live',
            question: 'Latest BP?',
            answer: {
              ...emptyAnswer(),
              summary: 'Streaming…',
            },
          },
        })}
        {...DEFAULT_PROPS}
      />,
    );

    expect(screen.getByText('Latest BP?')).toBeInTheDocument();
    expect(screen.getByText('Streaming…')).toBeInTheDocument();
    // Send button is disabled while streaming.
    const send = screen.getByTestId('copilot-send');
    expect(send).toBeDisabled();
  });

  it('dedupes citation chips across multiple claims', () => {
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({
          state: 'done',
          history: [
            {
              id: 'turn-1',
              question: 'Q',
              answer: {
                summary: 'A',
                claims: [
                  {
                    text: 'first',
                    citation_ids: ['tool:lab_results:row-1', 'doc:lab-3'],
                    severity: 'info',
                  },
                  {
                    text: 'second',
                    citation_ids: ['tool:lab_results:row-1', 'rule:diabetes:6.3a'],
                    severity: 'info',
                  },
                ],
                conflicts: [],
                confidence: 'medium',
                evidence_catalog: {},
                data_gaps: [],
                assumptions: [],
              },
            },
          ],
        })}
        {...DEFAULT_PROPS}
      />,
    );

    const chips = screen.getAllByTestId('copilot-citation-chip');
    // Per-claim chip rows: first claim (Labs + Lab Doc), second (Labs + Guideline).
    expect(chips).toHaveLength(4);
    expect(chips[0]).toHaveTextContent('Labs');
    expect(chips[1]).toHaveTextContent('Lab Doc');
    expect(chips[2]).toHaveTextContent('Labs');
    expect(chips[3]).toHaveTextContent('Guideline');
  });

  it('shows "Session expired" when the hook reports session_expired', () => {
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({
          state: 'error',
          error: {
            reason: 'session_expired',
            message: 'Session expired — please reload.',
          },
        })}
        {...DEFAULT_PROPS}
      />,
    );

    expect(screen.getByTestId('copilot-session-expired')).toHaveTextContent(
      'Session expired',
    );
  });

  it('renders markdown-bolded clinical numerics in answer summaries', () => {
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({
          state: 'done',
          history: [
            {
              id: 'turn-1',
              question: 'What is her A1c?',
              answer: {
                summary: 'Latest **HbA1c 7.4%** above ADA target.',
                claims: [],
                conflicts: [],
                confidence: 'high',
                evidence_catalog: {},
                data_gaps: [],
                assumptions: [],
              },
            },
          ],
        })}
        {...DEFAULT_PROPS}
      />,
    );

    const bubble = screen.getByTestId('copilot-answer-bubble');
    // The bolded numeric renders inside a <strong> tag.
    const strong = bubble.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('HbA1c 7.4%');
    // The surrounding text is intact and the markdown markers are gone.
    expect(bubble.textContent).toBe('Latest HbA1c 7.4% above ADA target.');
    expect(bubble.textContent).not.toContain('**');
  });

  it('shows the error message for a non-auth error', () => {
    render(
      <CoPilotDock
        isOpen={true}
        onClose={() => {}}
        useChatStreamImpl={stubChatStream({
          state: 'error',
          error: {
            reason: 'network',
            message: 'The Clinical Co-Pilot stream was interrupted.',
          },
        })}
        {...DEFAULT_PROPS}
      />,
    );

    expect(screen.getByTestId('copilot-error-notice')).toHaveTextContent(
      'interrupted',
    );
  });
});
