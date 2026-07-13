/**
 * Right-aligned user question bubble.
 *
 * Spec (W2 PRD §"Co-Pilot dock"):
 *   bg: #e8f0fb  (--blue-soft)
 *   color: #0d63c4  (--blue)
 *   max-width: 82%
 *   border-radius: 4px
 */

import React from 'react';

interface QuestionBubbleProps {
  readonly text: string;
}

export function QuestionBubble({
  text,
}: QuestionBubbleProps): React.JSX.Element {
  return (
    <div className="flex justify-end" data-testid="copilot-question-row">
      <div
        className="max-w-[82%] bg-blue-soft text-blue py-1.75 px-2.75 rounded-4 text-xs break-words [overflow-wrap:anywhere]"
        data-testid="copilot-question-bubble"
      >
        {text}
      </div>
    </div>
  );
}
