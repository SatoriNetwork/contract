import { render, screen, fireEvent } from '@testing-library/react';
import { InfoTip } from './InfoTip';

// A tap on a hover-enabled element does NOT emit only a click. Browsers emulate
// the mouse for compatibility, so a single tap fires, in order:
//
//   touchstart, touchend, mouseover, MOUSEENTER, mousedown, mouseup, CLICK
//
// which means "open on mouseenter, toggle on click" resolves to open-then-close:
// the popover flashes and vanishes, and the element reads as broken on exactly
// the devices this dapp is mostly played on.
//
// So hover PEEKS and click PINS. The two cannot both be toggles.
const tap = (el: HTMLElement) => { fireEvent.mouseEnter(el); fireEvent.click(el); };

describe('InfoTip with a hoverable trigger', () => {
  const setup = () => {
    render(<InfoTip trigger={<span>bar</span>} label="details">the detail</InfoTip>);
    return screen.getByRole('button', { name: 'details' });
  };

  it('stays open after a tap, which arrives as hover-then-click', () => {
    const btn = setup();
    tap(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('closes on a second tap', () => {
    const btn = setup();
    tap(btn);
    tap(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('peeks on hover alone and closes when the pointer leaves', () => {
    const btn = setup();
    fireEvent.mouseEnter(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('survives the pointer leaving once it has been pinned by a click', () => {
    const btn = setup();
    tap(btn);
    fireEvent.mouseLeave(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('a pinned popover still closes on an outside tap', () => {
    const btn = setup();
    tap(btn);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // ...and having been dismissed, hover peeks again rather than staying stuck.
    fireEvent.mouseEnter(btn);
    fireEvent.mouseLeave(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on Escape', () => {
    const btn = setup();
    tap(btn);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('InfoTip as the plain "?" icon', () => {
  // No custom trigger: no hover at all, and click stays a straight toggle.
  const setup = () => {
    render(<InfoTip>the detail</InfoTip>);
    return screen.getByRole('button', { name: 'More info' });
  };

  it('toggles on click', () => {
    const btn = setup();
    fireEvent.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('ignores hover', () => {
    const btn = setup();
    fireEvent.mouseEnter(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
