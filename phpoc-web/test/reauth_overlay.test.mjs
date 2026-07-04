/**
 * reauth_overlay.test.mjs — ReauthOverlay component tests.
 *
 * Tests the ReauthOverlay component rendering, passphrase input,
 * submit flow, error display, and cancel behavior.
 *
 * Note: Uses React.createElement() — .mjs files can't use JSX syntax
 * in this Vite 7 / Rolldown setup.
 *
 * Usage:
 *   npx vitest run test/reauth_overlay.test.mjs
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import ReauthOverlay from '../src/components/overlays/ReauthOverlay.jsx';

function renderOverlay(props = {}) {
  const defaultProps = {
    onAuthenticated: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
  };
  return render(React.createElement(ReauthOverlay, { ...defaultProps, ...props }));
}

// ══════════════════════════════════════════════════════════════════════
// Group A: Rendering
// ══════════════════════════════════════════════════════════════════════

describe('ReauthOverlay — Rendering', () => {
  it('A1. renders passphrase input field', () => {
    renderOverlay();
    const input = screen.getByLabelText(/passphrase/i);
    expect(input).toBeDefined();
    expect(input.type).toBe('password');
  });

  it('A2. renders unlock button', () => {
    renderOverlay();
    const button = screen.getByRole('button', { name: /unlock/i });
    expect(button).toBeDefined();
  });

  it('A3. renders cancel button', () => {
    renderOverlay();
    const cancelBtn = screen.getByText(/cancel/i);
    expect(cancelBtn).toBeDefined();
  });

  it('A4. renders re-auth subtitle text', () => {
    renderOverlay();
    const text = document.body.textContent;
    expect(text.toLowerCase()).toMatch(/session|re-auth|authenticate|expired/i);
  });

  it('A5. unlock button disabled when passphrase is empty', () => {
    renderOverlay();
    const button = screen.getByRole('button', { name: /unlock/i });
    expect(button.disabled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Group B: Interaction
// ══════════════════════════════════════════════════════════════════════

describe('ReauthOverlay — Interaction', () => {
  it('B1. typing enables the unlock button', () => {
    renderOverlay();
    const input = screen.getByLabelText(/passphrase/i);
    const button = screen.getByRole('button', { name: /unlock/i });
    
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'test-pass' } });
    expect(button.disabled).toBe(false);
  });

  it('B2. submitting calls onAuthenticated with passphrase', async () => {
    const onAuth = vi.fn().mockResolvedValue(undefined);
    renderOverlay({ onAuthenticated: onAuth });
    
    const input = screen.getByLabelText(/passphrase/i);
    fireEvent.change(input, { target: { value: 'my-secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    
    await waitFor(() => {
      expect(onAuth).toHaveBeenCalledWith('my-secret-pass');
    });
  });

  it('B3. shows loading state during authentication', async () => {
    let resolveAuth;
    const onAuth = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => { resolveAuth = resolve; });
    });
    renderOverlay({ onAuthenticated: onAuth });
    
    const input = screen.getByLabelText(/passphrase/i);
    fireEvent.change(input, { target: { value: 'pass' } });
    
    const button = screen.getByRole('button', { name: /unlock/i });
    fireEvent.click(button);
    
    await waitFor(() => {
      expect(button.textContent.toLowerCase()).toMatch(/unlocking|decrypting/i);
    });
    
    resolveAuth();
  });

  it('B4. shows error message on authentication failure', async () => {
    const onAuth = vi.fn().mockRejectedValue(new Error('Wrong passphrase'));
    renderOverlay({ onAuthenticated: onAuth });
    
    const input = screen.getByLabelText(/passphrase/i);
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    
    await waitFor(() => {
      expect(screen.getByText(/wrong passphrase/i)).toBeDefined();
    });
  });

  it('B5. error cleared when user starts typing again', async () => {
    const onAuth = vi.fn()
      .mockRejectedValueOnce(new Error('First attempt failed'))
      .mockResolvedValueOnce(undefined);
    
    renderOverlay({ onAuthenticated: onAuth });
    
    const input = screen.getByLabelText(/passphrase/i);
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    
    await waitFor(() => {
      expect(screen.getByText(/first attempt failed/i)).toBeDefined();
    });
    
    fireEvent.change(input, { target: { value: 'right' } });
    
    await waitFor(() => {
      expect(screen.queryByText(/first attempt failed/i)).toBeNull();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// Group C: Cancel / dismiss
// ══════════════════════════════════════════════════════════════════════

describe('ReauthOverlay — Cancel', () => {
  it('C1. cancel button calls onCancel', () => {
    const onCancel = vi.fn();
    renderOverlay({ onCancel });
    
    fireEvent.click(screen.getByText(/cancel/i));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('C2. input disabled during authentication (prevents double-submit)', async () => {
    let resolveAuth;
    const onAuth = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => { resolveAuth = resolve; });
    });
    renderOverlay({ onAuthenticated: onAuth });
    
    const input = screen.getByLabelText(/passphrase/i);
    fireEvent.change(input, { target: { value: 'pass' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    
    await waitFor(() => {
      expect(input.disabled).toBe(true);
    });
    
    resolveAuth();
  });
});

// ══════════════════════════════════════════════════════════════════════
// Group D: Accessibility
// ══════════════════════════════════════════════════════════════════════

describe('ReauthOverlay — Accessibility', () => {
  it('D1. passphrase input has proper label association', () => {
    renderOverlay();
    
    const input = screen.getByLabelText(/passphrase/i);
    expect(input.getAttribute('id')).toBeTruthy();
    const label = document.querySelector('label[for]');
    expect(label).toBeDefined();
    expect(label.getAttribute('for')).toBe(input.getAttribute('id'));
  });

  it('D2. error has role="alert" for screen readers', async () => {
    const onAuth = vi.fn().mockRejectedValue(new Error('Bad passphrase'));
    renderOverlay({ onAuthenticated: onAuth });
    
    const input = screen.getByLabelText(/passphrase/i);
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    
    await waitFor(() => {
      const error = screen.getByRole('alert');
      expect(error).toBeDefined();
      expect(error.textContent).toContain('Bad passphrase');
    });
  });
});
