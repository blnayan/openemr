/**
 * Shared card shell — white bg, 1px border, 4px radius, 11px × 13px padding,
 * title in OpenEMR blue (`var(--blue)`) at 13px / 600 weight, pencil
 * affordance in the top-right.
 *
 * Why a shared shell? Every clinical card on the dashboard repeats the same
 * chrome (Allergies, Problems, Medications, Prescriptions, Care Team, Labs).
 * Extracting it now keeps each subsequent card slice (#26+) focused on the
 * card's *body* — the part that actually differs.
 *
 * #31 wires the chrome up:
 *
 *   1. The whole title bar is a clickable region that toggles the card
 *      body open/closed. State persists per-user, per-patient via
 *      `useCardCollapseState` (see that hook for the storage layout).
 *      A Lucide Maximize/Minimize icon next to the title telegraphs the
 *      affordance, mirroring the legacy `card_base.html.twig`'s
 *      fa-expand/fa-compress.
 *   2. The pencil glyph in the top-right is now a real button that opens
 *      the legacy edit URL (when `onEdit` is provided). Pencil clicks
 *      MUST `stopPropagation` so they never accidentally toggle the card
 *      collapse state.
 */

import React, { useCallback } from 'react';
import { Maximize, Minimize, Pencil } from 'lucide-react';

import { useCardCollapseState } from '../hooks/useCardCollapseState';

interface CardProps {
    /** Card heading, e.g. "Allergies". Rendered in OpenEMR blue. */
    title: string;
    /**
     * Stable identifier for the card — used as the localStorage key suffix
     * for collapse persistence. MUST be unique across cards on the
     * dashboard; renaming an id silently resets the user's saved state.
     */
    cardId: string;
    /**
     * Logged-in OpenEMR user id (id_token `sub`). Threaded down from the
     * SPA shell. Pass `null` until it resolves — collapse keys then fall
     * back to the `"anon"` segment and re-key once the real value arrives.
     */
    userId?: string | null;
    /** Patient context (the SMART `patient` claim). */
    pid?: string | null;
    /**
     * Click handler for the pencil affordance. When provided, the pencil
     * is rendered as a `<button>` and the click is stopped from bubbling
     * up to the title-bar toggle. Omit to render the pencil as a purely
     * visual glyph (the original behavior).
     */
    onEdit?: () => void;
    children: React.ReactNode;
    /** Optional test id for assertions. */
    'data-testid'?: string;
}

export function Card({
    title,
    cardId,
    userId = null,
    pid = null,
    onEdit,
    children,
    'data-testid': testId,
}: CardProps): React.JSX.Element {
    const [isOpen, toggle] = useCardCollapseState(cardId, userId, pid);

    const bodyId = `card-body-${cardId}`;

    const onEditClick = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            // CRITICAL: keep the pencil click from bubbling up to the title
            // bar's toggle handler. Without stopPropagation a click on the
            // pencil would simultaneously open the legacy editor *and* toggle
            // the card open/closed — confusing, and on a closed card it would
            // briefly flash the body open before the new tab takes focus.
            event.stopPropagation();
            onEdit?.();
        },
        [onEdit],
    );

    // Keyboard support for the title bar: Space + Enter toggle. We don't
    // use a native <button> here because the pencil itself is a button,
    // and HTML disallows nesting interactive controls. role="button" on
    // a div with the proper keyboard handlers is the standard a11y
    // workaround.
    const onHeadKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        },
        [toggle],
    );

    const headClass =
        `appearance-none bg-transparent border-0 p-0 m-0 w-full text-inherit cursor-pointer select-none flex items-center justify-between focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-1`;
    const editClass =
        'appearance-none bg-transparent border-0 p-0 m-0 text-ink-ghost text-base cursor-pointer select-none transition-colors duration-100 hover:text-blue focus-visible:text-blue focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-1';
    return (
        <section
            className="bg-bg-card border border-border rounded-4 p-3 flex flex-col"
            data-testid={testId}
        >
            <div
                role="button"
                tabIndex={0}
                className={headClass}
                onClick={toggle}
                onKeyDown={onHeadKeyDown}
                aria-expanded={isOpen}
                aria-controls={bodyId}
                data-testid={`${cardId}-toggle`}
            >
                <span className="inline-flex items-center gap-1.5">
                    <h3 className="text-base font-semibold text-blue m-0 leading-[1.2]">
                        {title}
                    </h3>
                    <CollapseIcon isOpen={isOpen} />
                </span>
                {onEdit !== undefined ? (
                    <button
                        type="button"
                        className={editClass}
                        onClick={onEditClick}
                        aria-label={`Edit ${title}`}
                        data-testid={`${cardId}-edit`}
                    >
                        <Pencil className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
                    </button>
                ) : (
                    <span className={editClass} aria-hidden="true">
                        <Pencil className="w-4 h-4" strokeWidth={2} />
                    </span>
                )}
            </div>
            <div
                id={bodyId}
                className={isOpen ? 'flex flex-col pt-2' : 'hidden'}
                hidden={!isOpen}
            >
                {children}
            </div>
        </section>
    );
}

/**
 * Collapse / expand affordance — Maximize when collapsed, Minimize when
 * open. Same fa-expand / fa-compress semantics the legacy
 * `templates/patient/card/card_base.html.twig` uses.
 */
function CollapseIcon({ isOpen }: { isOpen: boolean }): React.JSX.Element {
    const Icon = isOpen ? Minimize : Maximize;
    return (
        <Icon
            className="w-4 h-4 text-ink-faint shrink-0"
            strokeWidth={2}
            aria-hidden="true"
        />
    );
}
