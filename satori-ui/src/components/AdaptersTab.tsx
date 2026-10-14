import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useAdapters } from '../hooks/useAdapters';
import { useGameAdapters } from '../hooks/useGameAdapters';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { explainError } from '../utils/errors';
import { afterTx } from '../lib/afterTx';

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

type FormState = { kind: 'success' | 'error'; msg: string } | null;

// Shared admin read — the role lives on SatoriRewards (the hub's owner() is
// address(0)), so admin equality decides whether the free official-register
// forms show. Mirrors OwnerTab.
function useIsAdmin(): boolean {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [admin, setAdmin] = useState<string | null>(null);
  useEffect(() => {
    if (!contracts) return;
    let cancelled = false;
    contracts.cached.round.rewards.admin()
      .then((a: string) => { if (!cancelled) setAdmin(a); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [contracts]);
  return !!(admin && address && admin.toLowerCase() === address.toLowerCase());
}

function ActionBanner({ action }: { action: FormState }) {
  if (!action) return null;
  return (
    <div className={action.kind === 'error'
      ? 'p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300'
      : 'p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-xs text-green-800 dark:text-green-300'}>
      {action.msg}
    </div>
  );
}

// ============================ STREAM ADAPTERS ============================
// Public panel — anyone can see registered STREAM adapters and register a
// community adapter (permissionless, costs the spam fee). The official-register
// form is admin-gated.
export function StreamAdaptersPanel() {
  const { adapters, loading, error, refetch, registerCommunityAdapter, spamFee } = useAdapters();
  const { contracts } = useContracts();
  const isAdmin = useIsAdmin();

  const [implInput, setImplInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [communityAction, setCommunityAction] = useState<FormState>(null);

  const [officialImpl, setOfficialImpl] = useState('');
  const [officialName, setOfficialName] = useState('');
  const [officialSubmitting, setOfficialSubmitting] = useState(false);
  const [officialAction, setOfficialAction] = useState<FormState>(null);

  const implValid = ethers.isAddress(implInput.trim());
  const canSubmitCommunity = implValid && !!nameInput.trim() && !submitting;

  const handleRegisterCommunity = useCallback(async () => {
    const impl = implInput.trim();
    const name = nameInput.trim();
    if (!ethers.isAddress(impl) || !name) return;
    setSubmitting(true);
    setCommunityAction(null);
    try {
      const newId = await registerCommunityAdapter(impl, name);
      setCommunityAction({ kind: 'success', msg: `Registered as community adapter #${newId}.` });
      setImplInput('');
      setNameInput('');
    } catch (e: any) {
      setCommunityAction({ kind: 'error', msg: e?.message ?? explainError(e) });
    } finally {
      setSubmitting(false);
    }
  }, [implInput, nameInput, registerCommunityAdapter]);

  const officialImplValid = ethers.isAddress(officialImpl.trim());
  const canSubmitOfficial = officialImplValid && !!officialName.trim() && !officialSubmitting;

  const handleRegisterOfficial = useCallback(async () => {
    if (!contracts) return;
    const impl = officialImpl.trim();
    const name = officialName.trim();
    if (!ethers.isAddress(impl) || !name) return;
    setOfficialSubmitting(true);
    setOfficialAction(null);
    try {
      const tx = await contracts.satori.registerAdapter(impl, name);
      const receipt = await afterTx(tx);
      let newId: number | null = null;
      const interfaces = [contracts.registry.interface, contracts.satori.interface];
      for (const log of receipt.logs ?? []) {
        for (const iface of interfaces) {
          let parsed: ethers.LogDescription | null = null;
          try {
            parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          } catch {
            parsed = null;
          }
          if (parsed && parsed.name === 'AdapterRegistered') {
            newId = Number(parsed.args.adapterId);
            break;
          }
        }
        if (newId !== null) break;
      }
      await refetch();
      setOfficialAction({
        kind: 'success',
        msg: newId !== null
          ? `Registered as official adapter #${newId}.`
          : 'Official adapter registered.',
      });
      setOfficialImpl('');
      setOfficialName('');
    } catch (e: any) {
      setOfficialAction({ kind: 'error', msg: explainError(e) });
    } finally {
      setOfficialSubmitting(false);
    }
  }, [contracts, officialImpl, officialName, refetch]);

  return (
    <div className="space-y-4" data-testid="stream-adapters-panel">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Stream adapters are the on-chain price/value sources a stream can read from. Anyone can
        register a community adapter (it costs the spam fee); official adapters are registered by
        the protocol admin.
      </p>

      {/* Registered adapters list */}
      <div className="space-y-1.5" data-testid="adapters-list">
        {loading ? (
          <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading adapters…</div>
        ) : error ? (
          <div className="card-themed p-4 text-sm text-red-600 dark:text-red-300">{error}</div>
        ) : adapters.length === 0 ? (
          <div className="card-themed p-6 text-center text-gray-500 text-sm" data-testid="adapters-empty">
            No adapters registered yet.
          </div>
        ) : (
          adapters.map((a) => (
            <div key={a.id} className="card-themed !p-0 overflow-hidden" data-testid={`adapter-row-${a.id}`}>
              <div className="px-3 py-2 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{a.name || `Adapter #${a.id}`}</span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${a.isCommunity ? 'text-orange-400 bg-orange-900/30' : 'text-cyan-400 bg-cyan-900/30'}`}
                      title={a.isCommunity ? 'Community-registered adapter (permissionless path).' : 'Official adapter (registered by the protocol admin).'}
                    >
                      {a.isCommunity ? 'community' : 'official'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate">#{a.id} · {shortAddress(a.impl)}</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Register a community adapter (permissionless) */}
      <div className="card-themed p-4 space-y-3" data-testid="register-community-form">
        <div>
          <h4 className="font-medium">Register a community adapter</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Permissionless. Costs {ethers.formatEther(spamFee)} SATORI (spam fee, pulled from your
            balance, and requires a one-time SATORI approval of the hub). The implementation must be a deployed adapter contract.
          </p>
        </div>
        <ActionBanner action={communityAction} />
        <input
          type="text" value={implInput} onChange={(e) => setImplInput(e.target.value)}
          placeholder="Adapter implementation address (0x…)"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
          disabled={submitting} data-testid="input-adapter-impl"
        />
        {implInput.trim() && !implValid && (<p className="text-[11px] text-red-600 dark:text-red-400">Enter a valid 0x address.</p>)}
        <input
          type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)}
          placeholder="Adapter name (e.g. Pyth ETH/USD)"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
          disabled={submitting} data-testid="input-adapter-name"
        />
        <button
          onClick={handleRegisterCommunity} disabled={!canSubmitCommunity}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
          data-testid="btn-register-adapter"
        >
          {submitting ? 'Registering…' : 'Register Community Adapter'}
        </button>
      </div>

      {/* Official path — admin only, free. */}
      {isAdmin && (
        <div className="card-themed p-4 space-y-3 border-2 border-cyan-300 dark:border-cyan-800" data-testid="register-official-form">
          <div>
            <h4 className="font-medium">Register official adapter</h4>
            <p className="text-xs text-cyan-700 dark:text-cyan-300">
              <strong>Admin only.</strong> Free: registers an official adapter directly on the core
              with no spam fee. Use only for adapters vetted by the protocol.
            </p>
          </div>
          <ActionBanner action={officialAction} />
          <input
            type="text" value={officialImpl} onChange={(e) => setOfficialImpl(e.target.value)}
            placeholder="Adapter implementation address (0x…)"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
            disabled={officialSubmitting} data-testid="input-official-adapter-impl"
          />
          {officialImpl.trim() && !officialImplValid && (<p className="text-[11px] text-red-600 dark:text-red-400">Enter a valid 0x address.</p>)}
          <input
            type="text" value={officialName} onChange={(e) => setOfficialName(e.target.value)}
            placeholder="Adapter name (e.g. Chainlink ETH/USD)"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
            disabled={officialSubmitting} data-testid="input-official-adapter-name"
          />
          <button
            onClick={handleRegisterOfficial} disabled={!canSubmitOfficial}
            className="w-full py-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
            data-testid="btn-register-official-adapter"
          >
            {officialSubmitting ? 'Registering…' : 'Register Official Adapter (free)'}
          </button>
        </div>
      )}
    </div>
  );
}

// ============================= GAME ADAPTERS =============================
export function GameAdaptersPanel() {
  const {
    gameAdapters, loading: gameLoading, error: gameError,
    registerCommunityGameAdapter, registerGameAdapter, spamFee: gameSpamFee,
  } = useGameAdapters();
  const isAdmin = useIsAdmin();

  const [gameImplInput, setGameImplInput] = useState('');
  const [gameNameInput, setGameNameInput] = useState('');
  const [gameSubmitting, setGameSubmitting] = useState(false);
  const [gameCommunityAction, setGameCommunityAction] = useState<FormState>(null);

  const gameImplValid = ethers.isAddress(gameImplInput.trim());
  const canSubmitGameCommunity = gameImplValid && !!gameNameInput.trim() && !gameSubmitting;

  const handleRegisterGameCommunity = useCallback(async () => {
    const impl = gameImplInput.trim();
    const name = gameNameInput.trim();
    if (!ethers.isAddress(impl) || !name) return;
    setGameSubmitting(true);
    setGameCommunityAction(null);
    try {
      const newId = await registerCommunityGameAdapter(impl, name);
      setGameCommunityAction({ kind: 'success', msg: `Registered as community game adapter #${newId}.` });
      setGameImplInput('');
      setGameNameInput('');
    } catch (e: any) {
      setGameCommunityAction({ kind: 'error', msg: e?.message ?? explainError(e) });
    } finally {
      setGameSubmitting(false);
    }
  }, [gameImplInput, gameNameInput, registerCommunityGameAdapter]);

  const [officialGameImpl, setOfficialGameImpl] = useState('');
  const [officialGameName, setOfficialGameName] = useState('');
  const [officialGameSubmitting, setOfficialGameSubmitting] = useState(false);
  const [officialGameAction, setOfficialGameAction] = useState<FormState>(null);

  const officialGameImplValid = ethers.isAddress(officialGameImpl.trim());
  const canSubmitOfficialGame = officialGameImplValid && !!officialGameName.trim() && !officialGameSubmitting;

  const handleRegisterGameOfficial = useCallback(async () => {
    const impl = officialGameImpl.trim();
    const name = officialGameName.trim();
    if (!ethers.isAddress(impl) || !name) return;
    setOfficialGameSubmitting(true);
    setOfficialGameAction(null);
    try {
      const newId = await registerGameAdapter(impl, name);
      setOfficialGameAction({ kind: 'success', msg: `Registered as official game adapter #${newId}.` });
      setOfficialGameImpl('');
      setOfficialGameName('');
    } catch (e: any) {
      setOfficialGameAction({ kind: 'error', msg: e?.message ?? explainError(e) });
    } finally {
      setOfficialGameSubmitting(false);
    }
  }, [officialGameImpl, officialGameName, registerGameAdapter]);

  return (
    <div className="space-y-4" data-testid="game-adapters-panel">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Game adapters are the on-chain game types a stream can host (beyond the built-in binary
        game). Anyone can register a community game adapter (it costs the spam fee); official game
        adapters are registered by the protocol admin.
      </p>

      {/* Registered game adapters list */}
      <div className="space-y-1.5" data-testid="game-adapters-list">
        {gameLoading ? (
          <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading game adapters…</div>
        ) : gameError ? (
          <div className="card-themed p-4 text-sm text-red-600 dark:text-red-300">{gameError}</div>
        ) : gameAdapters.length === 0 ? (
          <div className="card-themed p-6 text-center text-gray-500 text-sm" data-testid="game-adapters-empty">
            No game adapters registered yet.
          </div>
        ) : (
          gameAdapters.map((g) => (
            <div key={g.id} className="card-themed !p-0 overflow-hidden" data-testid={`game-adapter-row-${g.id}`}>
              <div className="px-3 py-2 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{g.name || `Game adapter #${g.id}`}</span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${g.isCommunity ? 'text-orange-400 bg-orange-900/30' : 'text-cyan-400 bg-cyan-900/30'}`}
                      title={g.isCommunity ? 'Community-registered game adapter (permissionless path).' : 'Official game adapter (registered by the protocol admin).'}
                    >
                      {g.isCommunity ? 'community' : 'official'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate">#{g.id} · {shortAddress(g.impl)}</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Register a community game adapter (permissionless) */}
      <div className="card-themed p-4 space-y-3" data-testid="register-community-gameadapter-form">
        <div>
          <h4 className="font-medium">Register a community game adapter</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Permissionless. Costs {ethers.formatEther(gameSpamFee)} SATORI (spam fee, pulled from
            your balance, and requires a one-time SATORI approval of the hub). The implementation must be a deployed game adapter contract.
          </p>
        </div>
        <ActionBanner action={gameCommunityAction} />
        <input
          type="text" value={gameImplInput} onChange={(e) => setGameImplInput(e.target.value)}
          placeholder="Game adapter implementation address (0x…)"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
          disabled={gameSubmitting} data-testid="input-gameadapter-impl"
        />
        {gameImplInput.trim() && !gameImplValid && (<p className="text-[11px] text-red-600 dark:text-red-400">Enter a valid 0x address.</p>)}
        <input
          type="text" value={gameNameInput} onChange={(e) => setGameNameInput(e.target.value)}
          placeholder="Game adapter name (e.g. YesNo Threshold)"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
          disabled={gameSubmitting} data-testid="input-gameadapter-name"
        />
        <button
          onClick={handleRegisterGameCommunity} disabled={!canSubmitGameCommunity}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
          data-testid="btn-register-gameadapter"
        >
          {gameSubmitting ? 'Registering…' : 'Register Community Game Adapter'}
        </button>
      </div>

      {/* Official game-adapter path — admin only, free. */}
      {isAdmin && (
        <div className="card-themed p-4 space-y-3 border-2 border-cyan-300 dark:border-cyan-800" data-testid="register-official-gameadapter-form">
          <div>
            <h4 className="font-medium">Register official game adapter</h4>
            <p className="text-xs text-cyan-700 dark:text-cyan-300">
              <strong>Admin only.</strong> Free: registers an official game adapter directly on the
              core with no spam fee. Use only for game adapters vetted by the protocol.
            </p>
          </div>
          <ActionBanner action={officialGameAction} />
          <input
            type="text" value={officialGameImpl} onChange={(e) => setOfficialGameImpl(e.target.value)}
            placeholder="Game adapter implementation address (0x…)"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
            disabled={officialGameSubmitting} data-testid="input-official-gameadapter-impl"
          />
          {officialGameImpl.trim() && !officialGameImplValid && (<p className="text-[11px] text-red-600 dark:text-red-400">Enter a valid 0x address.</p>)}
          <input
            type="text" value={officialGameName} onChange={(e) => setOfficialGameName(e.target.value)}
            placeholder="Game adapter name (e.g. YesNo Threshold)"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
            disabled={officialGameSubmitting} data-testid="input-official-gameadapter-name"
          />
          <button
            onClick={handleRegisterGameOfficial} disabled={!canSubmitOfficialGame}
            className="w-full py-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
            data-testid="btn-register-official-gameadapter"
          >
            {officialGameSubmitting ? 'Registering…' : 'Register Official Game Adapter (free)'}
          </button>
        </div>
      )}
    </div>
  );
}
