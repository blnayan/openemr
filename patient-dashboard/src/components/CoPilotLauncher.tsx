/**
 * Floating launcher button for the Clinical Co-Pilot dock.
 *
 * Renders a pill-shaped button in the bottom-right of the viewport. Click
 * dispatches `onOpen`; the orchestrator (App.tsx) then flips `isOpen` and
 * renders <CoPilotDock> in this component's place.
 *
 * The launcher hides itself while `isOpen` so the dock sits in the same
 * 22px-from-edge anchor without the launcher peeking out behind it. The
 * dock anchors at 16px to leave the launcher's 22px tail visible during
 * close transitions in future polish, but for this slice the launcher is
 * simply unmounted while the dock is open.
 */

import React from 'react';

interface CoPilotLauncherProps {
  /**
   * Whether the dock is currently open. When `true`, the launcher
   * renders nothing — the dock has taken its place.
   */
  isOpen: boolean;
  /** Click handler — flips the orchestrator's `isOpen` flag. */
  onOpen: () => void;
}

export function CoPilotLauncher({
  isOpen,
  onOpen,
}: CoPilotLauncherProps): React.JSX.Element | null {
  if (isOpen) {
    return null;
  }

  return (
    <button
      type="button"
      className="fixed bottom-5.5 right-5.5 z-1000 inline-flex items-center gap-2 py-2.5 px-4 border-0 rounded-full bg-blue text-white font-sans text-base font-semibold leading-none cursor-pointer shadow-launcher hover:brightness-105 focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2"
      onClick={onOpen}
      aria-label="Open Clinical Co-Pilot"
      data-testid="copilot-launcher"
    >
      <span
        className="inline-block w-2 h-2 rounded-full bg-ok-dot flex-none"
        aria-hidden="true"
      />
      Clinical Co-Pilot
    </button>
  );
}
