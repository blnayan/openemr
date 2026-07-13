import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Card } from '../../src/components/Card';
import { buildCardCollapseKey } from '../../src/hooks/useCardCollapseState';

const USER = 'user-42';
const PID = 'patient-7';

beforeEach(() => {
  window.localStorage.clear();
});

describe('<Card> collapse + edit', () => {
  it('defaults to open and renders children when no localStorage entry exists', () => {
    render(
      <Card title="Allergies" cardId="allergies" userId={USER} pid={PID}>
        <p>Body text</p>
      </Card>,
    );
    expect(screen.getByText('Body text')).toBeVisible();
    const toggle = screen.getByTestId('allergies-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles the body when the title bar is clicked', () => {
    render(
      <Card title="Allergies" cardId="allergies" userId={USER} pid={PID}>
        <p>Body text</p>
      </Card>,
    );

    const toggle = screen.getByTestId('allergies-toggle');
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // hidden attribute hides the body from assistive tech and visually.
    const body = document.getElementById('card-body-allergies');
    expect(body).not.toBeNull();
    expect(body).toHaveAttribute('hidden');
  });

  it('persists collapse state to localStorage with the userId+pid+cardId key', () => {
    render(
      <Card title="Allergies" cardId="allergies" userId={USER} pid={PID}>
        <p>Body text</p>
      </Card>,
    );

    fireEvent.click(screen.getByTestId('allergies-toggle'));

    const key = buildCardCollapseKey(USER, PID, 'allergies');
    expect(window.localStorage.getItem(key)).toBe('closed');
  });

  it('re-hydrates a previously collapsed state from localStorage on mount', () => {
    const key = buildCardCollapseKey(USER, PID, 'allergies');
    window.localStorage.setItem(key, 'closed');

    render(
      <Card title="Allergies" cardId="allergies" userId={USER} pid={PID}>
        <p>Body text</p>
      </Card>,
    );

    const toggle = screen.getByTestId('allergies-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders the pencil as a button when onEdit is provided', () => {
    const onEdit = vi.fn();
    render(
      <Card
        title="Allergies"
        cardId="allergies"
        userId={USER}
        pid={PID}
        onEdit={onEdit}
      >
        <p>Body</p>
      </Card>,
    );

    const pencil = screen.getByRole('button', { name: 'Edit Allergies' });
    expect(pencil).toBeInTheDocument();
  });

  it('renders the pencil as a non-interactive glyph when onEdit is omitted', () => {
    render(
      <Card title="Allergies" cardId="allergies" userId={USER} pid={PID}>
        <p>Body</p>
      </Card>,
    );

    expect(
      screen.queryByRole('button', { name: 'Edit Allergies' }),
    ).not.toBeInTheDocument();
    // The glyph itself is still present.
    expect(document.querySelector('.lucide-pencil')).toBeInTheDocument();
  });

  it('calls onEdit when the pencil is clicked', () => {
    const onEdit = vi.fn();
    render(
      <Card
        title="Allergies"
        cardId="allergies"
        userId={USER}
        pid={PID}
        onEdit={onEdit}
      >
        <p>Body</p>
      </Card>,
    );

    fireEvent.click(screen.getByTestId('allergies-edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('pencil click does NOT toggle the card collapse state', () => {
    const onEdit = vi.fn();
    render(
      <Card
        title="Allergies"
        cardId="allergies"
        userId={USER}
        pid={PID}
        onEdit={onEdit}
      >
        <p>Body</p>
      </Card>,
    );

    const toggle = screen.getByTestId('allergies-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByTestId('allergies-edit'));

    // Pencil click invokes onEdit but stopPropagation prevents the
    // surrounding role=button from receiving the click.
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // localStorage should be untouched — no toggle, no write.
    const key = buildCardCollapseKey(USER, PID, 'allergies');
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('exposes aria-controls pointing at the body element', () => {
    render(
      <Card title="Allergies" cardId="allergies" userId={USER} pid={PID}>
        <p>Body</p>
      </Card>,
    );

    const toggle = screen.getByTestId('allergies-toggle');
    expect(toggle).toHaveAttribute('aria-controls', 'card-body-allergies');
    expect(document.getElementById('card-body-allergies')).not.toBeNull();
  });

  it('toggles via Enter key on the title bar', () => {
    render(
      <Card title="Allergies" cardId="allergies" userId={USER} pid={PID}>
        <p>Body</p>
      </Card>,
    );

    const toggle = screen.getByTestId('allergies-toggle');
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles via Space key on the title bar', () => {
    render(
      <Card title="Allergies" cardId="allergies" userId={USER} pid={PID}>
        <p>Body</p>
      </Card>,
    );

    const toggle = screen.getByTestId('allergies-toggle');
    fireEvent.keyDown(toggle, { key: ' ' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
