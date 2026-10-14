import { Interface } from 'ethers';
import { explainError, isNullGasEstimate, sendPreflighted, EMISSION_RATIO_COPY } from './errors';
import NamedStreamAdapterAbi from '../contracts/NamedStreamAdapter.json';

// The failure these cover, concretely: tapping "Tick (pull adapter value)" twice in
// one round. The contract reverts CadenceRoundsNotElapsed, the node answers
// eth_estimateGas with null rather than an error, and ethers throws
//
//   invalid BigNumberish value (argument="%response", value=null, code=INVALID_ARGUMENT)
//
// which mentions neither a revert nor a cadence. The user is told nothing usable and
// a developer goes hunting through argument passing — four passes' worth, last time.

/// What ethers actually throws when a gas estimate comes back null.
const nullEstimate = () =>
  Object.assign(new Error('invalid BigNumberish value (argument="%response", value=null, code=INVALID_ARGUMENT, version=6.16.0)'), {
    code: 'INVALID_ARGUMENT',
    argument: '%response',
    value: null,
  });

describe('isNullGasEstimate', () => {
  it('recognises the null-estimate throw by its %response tell', () => {
    expect(isNullGasEstimate(nullEstimate())).toBe(true);
  });

  it('does NOT claim a caller-argument error is a null estimate', () => {
    // ethers uses %response only for values that came back from the NODE. A real
    // bad argument names the argument, and must not be mistaken for a revert —
    // that would hide a genuine dapp bug behind a friendly message.
    expect(isNullGasEstimate(Object.assign(new Error('bad'), {
      code: 'INVALID_ARGUMENT', argument: 'streamId', value: undefined,
    }))).toBe(false);
    expect(isNullGasEstimate(new Error('nope'))).toBe(false);
    expect(isNullGasEstimate(null)).toBe(false);
  });
});

describe('explainError on a null gas estimate', () => {
  it('says the transaction was rejected before sending, not "invalid BigNumberish"', () => {
    const msg = explainError(nullEstimate());
    expect(msg).not.toMatch(/BigNumberish|%response|INVALID_ARGUMENT/);
    expect(msg).toMatch(/rejected this transaction before sending/i);
    // Names the likely causes, because the reason genuinely is not available here.
    expect(msg).toMatch(/already done this round/i);
  });
});

describe('explainError on the cadence reverts', () => {
  // Reaching explainError as a message string is the realistic path for these:
  // many providers embed the error NAME in the text rather than returning
  // decodable revert data.
  it('explains ticking twice in a period in terms of the rule', () => {
    const msg = explainError({ message: 'execution reverted: CadenceRoundsNotElapsed()' });
    expect(msg).toMatch(/already been updated for this period/i);
    expect(msg).toMatch(/one update per period/i);
  });

  it('explains the wall-clock guard separately, in minutes', () => {
    const msg = explainError({ message: 'execution reverted: CadenceGapNotElapsed()' });
    expect(msg).toMatch(/updated too recently/i);
    expect(msg).toMatch(/minutes/i);
  });
});

describe('explainError on the gameApproved-era voting and games errors', () => {
  // Same message-string path as the cadence reverts: the NAME arrives embedded
  // in the provider's text. Unmapped names would surface raw and useless.
  it('explains a vote on an unapproved game', () => {
    const msg = explainError({ message: 'execution reverted: GameNotApproved()' });
    expect(msg).not.toMatch(/execution reverted/);
    expect(msg).toMatch(/not approved/i);
  });

  it('explains moving votes off a still-approved game', () => {
    const msg = explainError({ message: 'execution reverted: SourceStillApproved()' });
    expect(msg).toMatch(/still approved/i);
  });

  it('states the games meaning of InvalidTarget: one round, and the stream cadence, are floors', () => {
    const msg = explainError({ message: 'execution reverted: InvalidTarget()' });
    expect(msg).toMatch(/at least one round/i);
    expect(msg).toMatch(/cadence/i);
  });

  it('states the 60-minute cadence floor', () => {
    expect(explainError({ message: 'execution reverted: InvalidCadence()' }))
      .toMatch(/at least 60 minutes/i);
  });
});

describe('explainError on the named-stream create path', () => {
  // NameTaken is the registry's; StreamIdMismatch / NotWired / InvalidProvider
  // are NamedStreamAdapter's and bubble raw through the hub, so the adapter's
  // ABI has to be in the decoder for the SELECTOR path to name them at all.
  it('says the name is taken', () => {
    const msg = explainError({ message: 'execution reverted: NameTaken()' });
    expect(msg).not.toMatch(/execution reverted|Contract error/);
    expect(msg).toMatch(/already a named stream/i);
  });

  it('turns the create race into "try again"', () => {
    const msg = explainError({ message: 'execution reverted: StreamIdMismatch()' });
    expect(msg).toMatch(/another stream was created first/i);
    expect(msg).toMatch(/try again/i);
  });

  it('explains an unwired named adapter', () => {
    expect(explainError({ message: 'execution reverted: NotWired()' })).toMatch(/not .*enabled|not wired/i);
  });

  it('decodes the adapter errors from raw revert data, not only from message text', () => {
    const iface = new Interface(NamedStreamAdapterAbi.abi.filter((f: any) => f.type === 'error'));
    const data = iface.encodeErrorResult('StreamIdMismatch', []);
    expect(explainError({ data, message: 'unknown custom error' })).toMatch(/try again/i);
    const wired = iface.encodeErrorResult('NotWired', []);
    expect(explainError({ data: wired, message: 'unknown custom error' })).not.toMatch(/unknown custom error|Contract error/);
  });

  // The name is coined on Coined by the create itself, so Coined's text rules
  // revert through the registry. Their fragments ride in NamedStreamAdapter's
  // ABI (it inherits them) — that is what lets the SELECTOR path name them.
  it('explains Coined\'s name rules: empty, bad characters, mixed scripts', () => {
    expect(explainError({ message: 'execution reverted: EmptyName()' })).toMatch(/can't be empty/i);
    const bad = explainError({ message: 'execution reverted: BadName()' });
    expect(bad).toMatch(/Coined/);
    expect(bad).toMatch(/control or invisible/i);
    expect(explainError({ message: 'execution reverted: MixedScript()' })).toMatch(/one writing system/i);
  });

  it('decodes Coined\'s errors from raw revert data via the adapter ABI', () => {
    const iface = new Interface(NamedStreamAdapterAbi.abi.filter((f: any) => f.type === 'error'));
    for (const [name, re] of [['EmptyName', /empty/i], ['BadName', /allow/i], ['MixedScript', /writing system/i]] as const) {
      const data = iface.encodeErrorResult(name, []);
      expect(explainError({ data, message: 'unknown custom error' })).toMatch(re);
    }
  });
});

describe('sendPreflighted', () => {
  const revert = () => Object.assign(new Error('execution reverted'), {
    data: '0x', message: 'execution reverted: CadenceRoundsNotElapsed()',
  });

  it('simulates on the READ contract, then sends on the WRITE one', async () => {
    const order: string[] = [];
    const read = { updateValue: { staticCall: jest.fn(async () => { order.push('simulate'); }) } };
    const write = { updateValue: jest.fn(async () => { order.push('send'); return 'TX'; }) };
    const tx = await sendPreflighted(read, write, 'updateValue', [2], '0xabc');
    expect(tx).toBe('TX');
    expect(order).toEqual(['simulate', 'send']);
    // The `from` matters: a preflight run as the wrong account can pass where the
    // real send reverts (and vice versa).
    expect(read.updateValue.staticCall).toHaveBeenCalledWith(2, { from: '0xabc' });
    expect(write.updateValue).toHaveBeenCalledWith(2);
  });

  it('surfaces the revert WITHOUT costing a signature', async () => {
    // The point of the whole exercise. The send must never happen.
    const read = { updateValue: { staticCall: jest.fn(async () => { throw revert(); }) } };
    const write = { updateValue: jest.fn(async () => 'TX') };
    await expect(sendPreflighted(read, write, 'updateValue', [2], '0xabc'))
      .rejects.toThrow(/CadenceRoundsNotElapsed/);
    expect(write.updateValue).not.toHaveBeenCalled();
  });

  it('does not turn a flaky read node into a fake contract error', async () => {
    // A null response from the READ path is not evidence of a revert. Treating it
    // as one would block a perfectly valid transaction and blame the contract.
    const read = { updateValue: { staticCall: jest.fn(async () => { throw nullEstimate(); }) } };
    const write = { updateValue: jest.fn(async () => 'TX') };
    await expect(sendPreflighted(read, write, 'updateValue', [2], '0xabc')).resolves.toBe('TX');
  });

  it('skips the preflight when no account is connected', async () => {
    const read = { updateValue: { staticCall: jest.fn() } };
    const write = { updateValue: jest.fn(async () => 'TX') };
    await expect(sendPreflighted(read, write, 'updateValue', [2], null)).resolves.toBe('TX');
    expect(read.updateValue.staticCall).not.toHaveBeenCalled();
  });

  it('still sends when the read contract lacks the method', async () => {
    // Read/write ABIs drifting apart must not disable the button — the send is the
    // source of truth, the preflight is only there to explain a failure.
    const write = { updateValue: jest.fn(async () => 'TX') };
    await expect(sendPreflighted({}, write, 'updateValue', [2], '0xabc')).resolves.toBe('TX');
    expect(write.updateValue).toHaveBeenCalled();
  });
});

describe('sendPreflighted on the predict and vote paths', () => {
  // These pin the shapes that are easy to get subtly wrong, because a mistake here
  // fails as an opaque revert rather than as a type error.
  const mk = (fn: string) => {
    const read = { [fn]: { staticCall: jest.fn(async () => undefined) } };
    const write = { [fn]: jest.fn(async () => 'TX') };
    return { read, write };
  };

  it('passes a predict request ARRAY as one argument, not spread', () => {
    // predictMultipleWithPayloads takes a single array of {gameId, payload}.
    // Spreading it would send the first request as the whole call.
    const { read, write } = mk('predictMultipleWithPayloads');
    const requests = [{ gameId: 1, payload: '0x01' }, { gameId: 2, payload: '0x02' }];
    return sendPreflighted(read, write, 'predictMultipleWithPayloads', [requests], '0xme')
      .then(() => {
        expect(write.predictMultipleWithPayloads).toHaveBeenCalledWith(requests);
        expect(read.predictMultipleWithPayloads.staticCall).toHaveBeenCalledWith(requests, { from: '0xme' });
      });
  });

  it('keeps the referrer FIRST in the referral variant', () => {
    // predictMultipleWithReferral(referrer, requests). Swapping these silently
    // credits the wrong address, or reverts with nothing useful.
    const { read, write } = mk('predictMultipleWithReferral');
    const requests = [{ gameId: 1, payload: '0x01' }];
    return sendPreflighted(read, write, 'predictMultipleWithReferral', ['0xref', requests], '0xme')
      .then(() => {
        expect(write.predictMultipleWithReferral).toHaveBeenCalledWith('0xref', requests);
      });
  });

  it('sends clearVote with no arguments at all', () => {
    // An empty args array must produce a bare call, not a call with undefined.
    const { read, write } = mk('clearVote');
    return sendPreflighted(read, write, 'clearVote', [], '0xme').then(() => {
      expect(write.clearVote).toHaveBeenCalledWith();
      expect(read.clearVote.staticCall).toHaveBeenCalledWith({ from: '0xme' });
    });
  });

  it('never signs a prediction that would revert', () => {
    // The one that costs the user something. A whole queue of streams walked, then
    // a wasted signature and an opaque error, is the failure this prevents.
    const read = {
      predictMultipleWithPayloads: {
        staticCall: jest.fn(async () => { throw new Error('execution reverted: DuplicatePrediction()'); }),
      },
    };
    const write = { predictMultipleWithPayloads: jest.fn(async () => 'TX') };
    return expect(
      sendPreflighted(read, write, 'predictMultipleWithPayloads', [[]], '0xme'),
    ).rejects.toThrow(/DuplicatePrediction/).then(() => {
      expect(write.predictMultipleWithPayloads).not.toHaveBeenCalled();
    });
  });

  it('explains DuplicatePrediction rather than leaving it raw', () => {
    expect(explainError({ message: 'execution reverted: DuplicatePrediction()' }))
      .not.toMatch(/execution reverted/);
  });
});

describe('explainError with per-setter copy', () => {
  it('names the multiplier bound for setEmissionRatio\'s BadInput, and only there', () => {
    const e = new Error('execution reverted: BadInput()');
    expect(explainError(e, EMISSION_RATIO_COPY)).toMatch(/multiplier must be between 0 and 18\.44/);
    expect(explainError(e)).toBe('Invalid input.');
  });
});
