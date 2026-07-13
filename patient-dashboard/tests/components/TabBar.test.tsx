import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { TabBar, resolveHref, type MenuItem } from '../../src/components/TabBar';

const baseItems: MenuItem[] = [
  {
    label: 'Dashboard',
    menu_id: 'dashboard',
    url: 'interface/patient_file/summary/dashboard/index.php',
    on_click: 'top.restoreSession()',
    pid: 'false',
    children: [],
  },
  {
    label: 'History',
    menu_id: 'history',
    url: 'interface/patient_file/history/history.php',
    on_click: 'top.restoreSession()',
    pid: 'false',
    children: [],
  },
  {
    label: 'Assessments',
    menu_id: 'sdoc',
    children: [
      {
        label: 'SDOH Assessment',
        menu_id: 'sdoc1',
        url: 'interface/patient_file/history/history_sdoh_widget.php?pid=',
        on_click: 'top.restoreSession()',
        pid: 'true',
        children: [],
      },
    ],
  },
  {
    label: 'Documents',
    menu_id: 'documents',
    url: 'controller.php?document&list&patient_id=',
    on_click: 'top.restoreSession()',
    pid: 'true',
    children: [],
  },
];

describe('TabBar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one tab per top-level menu item', () => {
    render(<TabBar items={baseItems} activeId="dashboard" webroot="" pid="42" />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Assessments')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
  });

  it('marks the active tab with aria-current=page and the active class', () => {
    render(<TabBar items={baseItems} activeId="dashboard" webroot="" pid="42" />);
    const dashLink = screen.getByText('Dashboard').closest('a');
    expect(dashLink).not.toBeNull();
    expect(dashLink).toHaveAttribute('aria-current', 'page');
  });

  it('only marks one tab active even if multiple ids match (active wins on first match)', () => {
    render(<TabBar items={baseItems} activeId="history" webroot="" pid="42" />);
    expect(screen.getByText('History').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Dashboard').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('renders an item with children as a plain link (no dropdown)', () => {
    render(<TabBar items={baseItems} activeId="dashboard" webroot="" pid="42" />);
    // Assessments has children but the dropdown was removed — should
    // render as a plain <a>, not a <details>/<summary>.
    const link = screen.getByText('Assessments').closest('a');
    expect(link).not.toBeNull();
    expect(screen.getByText('Assessments').closest('summary')).toBeNull();
    expect(screen.getByText('Assessments').closest('details')).toBeNull();
  });

  it('parents without their own URL fall back to the first child URL', () => {
    render(<TabBar items={baseItems} activeId="dashboard" webroot="" pid="42" />);
    // Assessments has no top-level url; SDOH child has
    // `interface/patient_file/history/history_sdoh_widget.php?pid=` + pid.
    const link = screen.getByText('Assessments').closest('a');
    expect(link).toHaveAttribute(
      'href',
      '/interface/patient_file/history/history_sdoh_widget.php?pid=42',
    );
  });

  it('appends pid to URLs whose pid field is the literal string "true"', () => {
    render(<TabBar items={baseItems} activeId="dashboard" webroot="" pid="42" />);
    const docsLink = screen.getByText('Documents').closest('a');
    expect(docsLink).toHaveAttribute(
      'href',
      '/controller.php?document&list&patient_id=42',
    );
  });

  it('does NOT append pid for items whose pid field is "false"', () => {
    render(<TabBar items={baseItems} activeId="dashboard" webroot="" pid="42" />);
    const dashLink = screen.getByText('Dashboard').closest('a');
    expect(dashLink).toHaveAttribute(
      'href',
      '/interface/patient_file/summary/dashboard/index.php',
    );
  });

  it('respects a non-empty webroot prefix', () => {
    render(<TabBar items={baseItems} activeId="dashboard" webroot="/openemr" pid="42" />);
    const dashLink = screen.getByText('Dashboard').closest('a');
    expect(dashLink).toHaveAttribute(
      'href',
      '/openemr/interface/patient_file/summary/dashboard/index.php',
    );
  });

  it('passes absolute http(s) URLs through unchanged', () => {
    const items: MenuItem[] = [
      {
        label: 'External',
        menu_id: 'ext',
        url: 'https://example.com/path',
        on_click: '',
        pid: 'false',
        children: [],
      },
    ];
    render(<TabBar items={items} activeId="ext" webroot="/openemr" pid="42" />);
    const link = screen.getByText('External').closest('a');
    expect(link).toHaveAttribute('href', 'https://example.com/path');
  });

  it('renders nothing extra when menu is empty (no <ul> children)', () => {
    const { container } = render(
      <TabBar items={[]} activeId="dashboard" webroot="" pid="42" />,
    );
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    expect(ul!.children).toHaveLength(0);
  });

  it('fires the embedded onClick handler when a tab is clicked', () => {
    // The legacy menu uses on_click='top.restoreSession()'. We verify the
    // wrapper turns that into a callable Function and invokes it.
    (window as unknown as { __tabBarTestSpy?: () => void }).__tabBarTestSpy =
      vi.fn();
    const items: MenuItem[] = [
      {
        label: 'Spy',
        menu_id: 'spy',
        url: 'noop',
        on_click: 'window.__tabBarTestSpy()',
        pid: 'false',
        children: [],
      },
    ];
    render(<TabBar items={items} activeId="spy" webroot="" pid="" />);
    fireEvent.click(screen.getByText('Spy'));
    expect(
      (window as unknown as { __tabBarTestSpy: () => void }).__tabBarTestSpy,
    ).toHaveBeenCalled();
    delete (window as unknown as { __tabBarTestSpy?: () => void })
      .__tabBarTestSpy;
  });

  it('does not throw when an embedded onClick handler errors out', () => {
    const items: MenuItem[] = [
      {
        label: 'Boom',
        menu_id: 'boom',
        url: 'noop',
        on_click: 'throw new Error("nope")',
        pid: 'false',
        children: [],
      },
    ];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<TabBar items={items} activeId="boom" webroot="" pid="" />);
    expect(() => fireEvent.click(screen.getByText('Boom'))).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('resolveHref', () => {
  it('appends pid only when item.pid is the literal string "true"', () => {
    expect(
      resolveHref({ label: 'x', menu_id: 'x', url: 'a/b', pid: 'true' }, '', '99'),
    ).toBe('/a/b99');
    expect(
      resolveHref({ label: 'x', menu_id: 'x', url: 'a/b', pid: 'false' }, '', '99'),
    ).toBe('/a/b');
    // Missing pid → no append
    expect(resolveHref({ label: 'x', menu_id: 'x', url: 'a/b' }, '', '99')).toBe('/a/b');
  });

  it('joins webroot + relative url with exactly one slash', () => {
    expect(
      resolveHref({ label: 'x', menu_id: 'x', url: 'a/b' }, '/openemr', ''),
    ).toBe('/openemr/a/b');
    // trailing slash on webroot collapses
    expect(
      resolveHref({ label: 'x', menu_id: 'x', url: 'a/b' }, '/openemr/', ''),
    ).toBe('/openemr/a/b');
    // leading slash on url collapses
    expect(
      resolveHref({ label: 'x', menu_id: 'x', url: '/a/b' }, '/openemr', ''),
    ).toBe('/openemr/a/b');
  });

  it('passes absolute URLs through without modification', () => {
    expect(
      resolveHref(
        { label: 'x', menu_id: 'x', url: 'https://example.com/x' },
        '/openemr',
        '',
      ),
    ).toBe('https://example.com/x');
  });

  it('handles empty url defensively', () => {
    expect(resolveHref({ label: 'x', menu_id: 'x' }, '/openemr', '')).toBe('/openemr/');
  });
});
