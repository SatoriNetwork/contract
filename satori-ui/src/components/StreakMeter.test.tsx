import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StreakMeter } from './StreakMeter';

// The meter's colour is the only place the dapp answers "is this prediction going to earn
// the real band?" before the user commits, and it does it WITHOUT WORDS — no tooltip, no
// copy. So these tests are the only guard on that signal being right. It is keyed to the
// BAR (`max(dustFloor, gameStreakState[gameId].threshold)`), not to the streak's magnitude —
// the old six-step heat ramp went green at streak 3 while the bar sat at 4, telling a
// player they were hot right before they earned a rounding error.
//
// These pin the three states and, more importantly, the two ways of being wrong:
// green must never appear below the bar, and must never appear on an unknown bar.
const GREY = '#6b7280';
const BLUE = '#3b82f6';
const GREEN = '#22c55e';

const colorOf = () => screen.getByTestId('streak-label').style.color;
// getComputedStyle normalises hex to rgb(), so compare on that.
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

describe('StreakMeter colour', () => {
  it('is grey with no streak, whatever the bar is', () => {
    render(<StreakMeter streak={0} bar={4} />);
    expect(colorOf()).toBe(rgb(GREY));
    expect(screen.getByTestId('streak-label').dataset.earning).toBe('false');
  });

  it('is blue with a streak that has not reached the bar', () => {
    render(<StreakMeter streak={3} bar={4} />);
    expect(colorOf()).toBe(rgb(BLUE));
    expect(screen.getByTestId('streak-label').dataset.earning).toBe('false');
  });

  it('is green exactly AT the bar — the engine uses >=, not >', () => {
    render(<StreakMeter streak={4} bar={4} />);
    expect(colorOf()).toBe(rgb(GREEN));
    expect(screen.getByTestId('streak-label').dataset.earning).toBe('true');
  });

  it('stays green above the bar', () => {
    render(<StreakMeter streak={40} bar={4} />);
    expect(colorOf()).toBe(rgb(GREEN));
  });

  it('never goes green on a long streak that is below a high bar', () => {
    // The whole point of keying to the bar: a streak of 12 is "hot" by any ramp, but on
    // a skilled field whose bar has climbed to 20 it still earns nothing meaningful.
    render(<StreakMeter streak={12} bar={20} />);
    expect(colorOf()).toBe(rgb(BLUE));
  });

  it('never claims "earning" while the bar is unknown', () => {
    // Undefined bar means the read has not landed. Green here would be a promise the
    // chain has not made, so it falls back to the have-a-streak colour.
    render(<StreakMeter streak={99} />);
    expect(colorOf()).toBe(rgb(BLUE));
    expect(screen.getByTestId('streak-label').dataset.earning).toBe('false');
  });
});

describe('StreakMeter bar marker', () => {
  it('marks where the bar sits while it is still ahead of you', () => {
    render(<StreakMeter streak={1} bar={4} />);
    expect(screen.getByTestId('streak-bar-marker')).toBeInTheDocument();
  });

  // Owner, 2026-08-14: it used to disappear once cleared, on the theory that a
  // cleared bar is an answered question. It is not. The bar is ADAPTIVE — it
  // tracks the field and moves on its own — so "how far above it am I" is live
  // information about how much slack there is before a single loss drops the
  // streak back under. Hiding the tick threw that away exactly when it started
  // being worth knowing, and we already have the number.
  it('keeps the marker once cleared — headroom above an adaptive bar still matters', () => {
    render(<StreakMeter streak={5} bar={4} />);
    expect(screen.getByTestId('streak-bar-marker')).toBeInTheDocument();
  });

  it('darkens the marker when it sits behind the fill, so it stays readable', () => {
    // Below the bar the tick is on bare track and reads light; above, it is on
    // top of the green fill and would vanish at the same colour.
    render(<StreakMeter streak={1} bar={4} />);
    const ahead = screen.getByTestId('streak-bar-marker').style.backgroundColor;
    cleanup();
    render(<StreakMeter streak={9} bar={4} />);
    const behind = screen.getByTestId('streak-bar-marker').style.backgroundColor;
    expect(behind).not.toBe(ahead);
  });

  it('has no marker when the bar is unknown', () => {
    render(<StreakMeter streak={2} />);
    expect(screen.queryByTestId('streak-bar-marker')).toBeNull();
  });
});

// The tick says WHERE the bar is. It cannot say WHAT it is, and the number is the
// thing a player actually wants when deciding whether this prediction is worth
// making (owner, 2026-08-14).
//
// The meter stays wordless AT REST — that part of the original design holds. The
// objection recorded against a tooltip was that "a hover explanation is invisible
// on touch, which is where most of this is played", and that objection is answered
// rather than overruled: InfoTip opens on tap as well as hover, which is the same
// affordance as the "?" icons everywhere else in the dapp.
describe('StreakMeter bar reveal', () => {
  // The real thing a tap emits on a hover-enabled element — see InfoTip.test.tsx.
  const openTip = () => {
    const el = screen.getByTestId('streak-bar-trigger');
    fireEvent.mouseEnter(el);
    fireEvent.click(el);
  };

  it('names the actual bar, not just its position', async () => {
    render(<StreakMeter streak={7} bar={4} />);
    openTip();
    expect((await screen.findByTestId('streak-bar-value')).textContent).toBe('4');
  });

  it('does not restate where the streak stands', async () => {
    // The tick's distance from the fill already shows it, and the streak's own
    // number sits beside the track. Saying it a third time in words earned its
    // space back.
    render(<StreakMeter streak={7} bar={4} />);
    openTip();
    await screen.findByTestId('streak-bar-value');
    expect(screen.queryByTestId('streak-bar-standing')).toBeNull();
    expect(screen.getByRole('tooltip').textContent).not.toMatch(/clear of it|more to clear/);
  });

  it('offers nothing to open while the bar is unknown', () => {
    // Same rule as the colour: an unloaded bar must not be reported as a number.
    render(<StreakMeter streak={9} />);
    expect(screen.queryByTestId('streak-bar-trigger')).toBeNull();
  });

  it('does not fire the surrounding UI when tapped', () => {
    // It sits directly above the UP/DOWN buttons. A tap that bubbled into a
    // prediction would be the worst possible bug on this screen.
    const onClick = jest.fn();
    render(<div onClick={onClick}><StreakMeter streak={7} bar={4} /></div>);
    openTip();
    expect(onClick).not.toHaveBeenCalled();
  });
});
