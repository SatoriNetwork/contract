import React from 'react';
import { ethers } from 'ethers';

// Shared building blocks for the privileged panels (GovernorTab / AdminTab).

export type ActionState = { kind: 'success' | 'error'; msg: string } | null;

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Compact SATORI (wei → human) for dial/lane read-outs.
export function fmtSatori(wei: bigint): string {
  return Number(ethers.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function bpsToPercentStr(bps: number): string {
  return (bps / 100).toFixed(2);
}

interface RowProps {
  title: string;
  subtitle: React.ReactNode;
  summary: React.ReactNode;
  input: React.ReactNode | null;
  action: ActionState;
  onSave: () => void;
  saving: boolean;
  disabled: boolean;
  saveLabel?: string;
  saveTestId?: string;
  // Read-only rows render the summary only (no input / save button).
  readOnly?: boolean;
  // Danger-styled save button (e.g. irreversible role transfer).
  danger?: boolean;
}

export function Row({
  title, subtitle, summary, input, action, onSave, saving, disabled, saveLabel,
  saveTestId, readOnly, danger,
}: RowProps) {
  return (
    <div className="card-themed !p-0 overflow-hidden">
      <div className="px-3 py-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-medium">{title}</div>
            <div className="text-xs text-gray-500">{subtitle}</div>
          </div>
          <div className="text-right whitespace-nowrap text-sm">
            {summary}
          </div>
        </div>

        {action && (
          <div className={action.kind === 'error'
            ? 'p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300'
            : 'p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-xs text-green-800 dark:text-green-300'}>
            {action.msg}
          </div>
        )}

        {!readOnly && (
          <>
            {input}
            <button
              onClick={onSave}
              data-testid={saveTestId}
              disabled={disabled || saving}
              className={`w-full py-2 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors ${
                danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {saving ? 'Saving…' : (saveLabel ?? 'Save')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// A small themed number-input for the curve dials.
export function DialInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      data-testid={props.testId}
      className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
      disabled={props.disabled}
    />
  );
}
