import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import {
  buildCardCollapseKey,
  useCardCollapseState,
} from '../../src/hooks/useCardCollapseState';

const USER = 'user-42';
const PID = 'patient-7';
const CARD = 'allergies';

beforeEach(() => {
  window.localStorage.clear();
});

describe('buildCardCollapseKey', () => {
  it('joins userId, pid, and cardId under the dashboard:cardCollapse prefix', () => {
    expect(buildCardCollapseKey('u1', 'p1', 'allergies')).toBe(
      'dashboard:cardCollapse:u1:p1:allergies',
    );
  });

  it('falls back to "anon" segments when userId or pid is null', () => {
    expect(buildCardCollapseKey(null, 'p1', 'allergies')).toBe(
      'dashboard:cardCollapse:anon:p1:allergies',
    );
    expect(buildCardCollapseKey('u1', null, 'allergies')).toBe(
      'dashboard:cardCollapse:u1:anon:allergies',
    );
    expect(buildCardCollapseKey(null, null, 'allergies')).toBe(
      'dashboard:cardCollapse:anon:anon:allergies',
    );
  });

  it('treats empty strings the same as null', () => {
    expect(buildCardCollapseKey('', '', 'allergies')).toBe(
      'dashboard:cardCollapse:anon:anon:allergies',
    );
  });
});

describe('useCardCollapseState', () => {
  it('defaults to open when no entry exists in localStorage', () => {
    const { result } = renderHook(() =>
      useCardCollapseState(CARD, USER, PID),
    );
    expect(result.current[0]).toBe(true);
  });

  it('persists a closed state to localStorage on toggle', () => {
    const { result } = renderHook(() =>
      useCardCollapseState(CARD, USER, PID),
    );
    expect(result.current[0]).toBe(true);

    act(() => {
      result.current[1]();
    });

    expect(result.current[0]).toBe(false);
    const key = buildCardCollapseKey(USER, PID, CARD);
    expect(window.localStorage.getItem(key)).toBe('closed');
  });

  it('persists an open state to localStorage on a second toggle', () => {
    const { result } = renderHook(() =>
      useCardCollapseState(CARD, USER, PID),
    );

    act(() => {
      result.current[1]();
    });
    act(() => {
      result.current[1]();
    });

    expect(result.current[0]).toBe(true);
    const key = buildCardCollapseKey(USER, PID, CARD);
    expect(window.localStorage.getItem(key)).toBe('open');
  });

  it('re-hydrates the persisted closed state on mount', () => {
    const key = buildCardCollapseKey(USER, PID, CARD);
    window.localStorage.setItem(key, 'closed');

    const { result } = renderHook(() =>
      useCardCollapseState(CARD, USER, PID),
    );

    expect(result.current[0]).toBe(false);
  });

  it('re-hydrates the persisted open state on mount', () => {
    const key = buildCardCollapseKey(USER, PID, CARD);
    window.localStorage.setItem(key, 'open');

    const { result } = renderHook(() =>
      useCardCollapseState(CARD, USER, PID),
    );

    expect(result.current[0]).toBe(true);
  });

  it('falls back to open when the stored value is unrecognized', () => {
    const key = buildCardCollapseKey(USER, PID, CARD);
    window.localStorage.setItem(key, 'corrupted');

    const { result } = renderHook(() =>
      useCardCollapseState(CARD, USER, PID),
    );

    expect(result.current[0]).toBe(true);
  });

  it('scopes state by userId+pid+cardId — different keys do not bleed', () => {
    // Mark Margaret's allergies card collapsed for user-A.
    const keyA = buildCardCollapseKey('user-A', 'margaret', 'allergies');
    window.localStorage.setItem(keyA, 'closed');

    // user-B on the same patient: should still default to open.
    const { result: resultB } = renderHook(() =>
      useCardCollapseState('allergies', 'user-B', 'margaret'),
    );
    expect(resultB.current[0]).toBe(true);

    // user-A on a different patient: also defaults to open.
    const { result: resultOtherPid } = renderHook(() =>
      useCardCollapseState('allergies', 'user-A', 'bob'),
    );
    expect(resultOtherPid.current[0]).toBe(true);

    // user-A / margaret / problems: defaults to open even though
    // user-A / margaret / allergies is closed.
    const { result: resultOtherCard } = renderHook(() =>
      useCardCollapseState('problems', 'user-A', 'margaret'),
    );
    expect(resultOtherCard.current[0]).toBe(true);

    // Sanity: user-A / margaret / allergies still reads as closed.
    const { result: resultOriginal } = renderHook(() =>
      useCardCollapseState('allergies', 'user-A', 'margaret'),
    );
    expect(resultOriginal.current[0]).toBe(false);
  });

  it('re-keys when the userId changes between renders', () => {
    // Hook starts with userId=null (not yet resolved); user collapses
    // the card so the "anon" key is set to closed.
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) =>
        useCardCollapseState(CARD, uid, PID),
      { initialProps: { uid: null as string | null } },
    );
    act(() => {
      result.current[1]();
    });
    expect(result.current[0]).toBe(false);
    expect(
      window.localStorage.getItem(buildCardCollapseKey(null, PID, CARD)),
    ).toBe('closed');

    // userId resolves to a real value — the new key has no entry yet,
    // so the hook should default back to open.
    rerender({ uid: USER });
    expect(result.current[0]).toBe(true);
    expect(
      window.localStorage.getItem(buildCardCollapseKey(USER, PID, CARD)),
    ).toBe(null);
  });
});
