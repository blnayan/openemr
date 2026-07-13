import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CoPilotLauncher } from '../../src/components/CoPilotLauncher';

describe('CoPilotLauncher', () => {
  it('renders a pill with "Clinical Co-Pilot" label and the online dot', () => {
    render(<CoPilotLauncher isOpen={false} onOpen={() => {}} />);

    const launcher = screen.getByTestId('copilot-launcher');
    expect(launcher).toBeInTheDocument();
    expect(launcher).toHaveTextContent('Clinical Co-Pilot');
    // The online dot is an aria-hidden span — assert it exists structurally.
    expect(launcher.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('exposes an accessible label for the button', () => {
    render(<CoPilotLauncher isOpen={false} onOpen={() => {}} />);
    expect(
      screen.getByRole('button', { name: /open clinical co-pilot/i }),
    ).toBeInTheDocument();
  });

  it('invokes onOpen when clicked', () => {
    const onOpen = vi.fn();
    render(<CoPilotLauncher isOpen={false} onOpen={onOpen} />);

    fireEvent.click(screen.getByTestId('copilot-launcher'));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while the dock is open', () => {
    const { container } = render(
      <CoPilotLauncher isOpen={true} onOpen={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('copilot-launcher')).not.toBeInTheDocument();
  });
});
