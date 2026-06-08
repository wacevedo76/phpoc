import React, { useState } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';

/**
 * Configuration — all user-configurable aspects from the CLI reference.
 *
 * Sections map directly to ConfigManager.DEFAULTS in security/config_manager.py:
 *
 *   1. Storage    — config_dir, data_dir, ledger/staging/index/identity/config filenames
 *   2. Remote     — transport (git/http), staging_path, ledger_path, git_remote_url
 *   3. HTTP       — provider (cloudflare/generic), base_url, api_key
 *   4. Auth       — cache_timeout_minutes, passphrase_required
 *   5. Device     — device_id, device_label
 *   6. Timeouts   — remote_check_ms, push_timeout_ms
 *   7. Cookie     — ttl_minutes, enabled, renewal_threshold
 *   8. Debug      — trace_enabled
 *   9. Staging    — blob_size_tier
 *
 * Not wired to the actual config store yet — this is a visual prototype.
 * Each field shows its default value from the CLI.
 *
 * Props:
 *   @param {function} onBack — () => void, navigate back to UserProfile
 */
export default function Configuration({ onBack }) {
  const { isDev } = useApp();

  // Track which section accordions are open
  const [openSections, setOpenSections] = useState({
    storage: false,
    remote: false,
    http: false,
    auth: true,   // open by default
    device: false,
    timeouts: false,
    cookie: false,
    debug: false,
    staging: false,
  });

  // Form state — pre-filled with CLI defaults
  const [form, setForm] = useState({
    // Storage
    configDir: '~/.config/phpoc',
    dataDir: '~/.local/share/phpoc',
    ledgerFile: 'ledger.json',
    stagingFile: 'staging.json',
    indexFile: 'index.json',
    identityFile: 'identity.json',
    configFile: 'config.json',
    // Remote
    transport: 'http',
    gitRemoteUrl: '',
    stagingPath: '',
    ledgerPath: '',
    // HTTP
    httpProvider: 'cloudflare',
    baseUrl: '',
    apiKey: '',
    // Auth
    cacheTimeoutMinutes: 30,
    passphraseRequired: true,
    // Device
    deviceId: '',
    deviceLabel: '',
    // Timeouts
    remoteCheckMs: 500,
    pushTimeoutMs: 5000,
    // Cookie
    cookieTtlMinutes: 30,
    cookieEnabled: true,
    cookieRenewalThreshold: 0.9,
    // Debug
    traceEnabled: false,
    // Staging
    blobSizeTier: '64K',
  });

  const toggleSection = (key) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleChange = (field) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  // -------------------------------------------------------------------
  // Section helper
  // -------------------------------------------------------------------
  const Section = ({ id, title, icon, children }) => (
    <section className="config-section">
      <button
        className="config-section-header"
        onClick={() => toggleSection(id)}
        aria-expanded={openSections[id]}
      >
        <span className="config-section-title">
          <span className="config-section-icon">{icon}</span>
          {title}
        </span>
        <span className={`config-chevron ${openSections[id] ? 'config-chevron-open' : ''}`}>
          ▶
        </span>
      </button>
      {openSections[id] && (
        <div className="config-section-body">
          {children}
        </div>
      )}
    </section>
  );

  const Field = ({ label, hint, children }) => (
    <div className="config-field">
      <div className="config-field-header">
        <label className="config-field-label">{label}</label>
        {hint && <span className="config-field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );

  const TextInput = ({ field, placeholder, mono }) => (
    <input
      type="text"
      className={`config-input ${mono ? 'config-input-mono' : ''}`}
      placeholder={placeholder}
      value={form[field]}
      onChange={handleChange(field)}
    />
  );

  const SelectInput = ({ field, options }) => (
    <select
      className="config-select"
      value={form[field]}
      onChange={handleChange(field)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );

  const Toggle = ({ field, label }) => (
    <label className="config-toggle">
      <input
        type="checkbox"
        checked={form[field]}
        onChange={handleChange(field)}
      />
      <span className="config-toggle-track">
        <span className="config-toggle-thumb" />
      </span>
      <span className="config-toggle-label">{label}</span>
    </label>
  );

  const RangeInput = ({ field, min, max, step, unit }) => (
    <div className="config-range">
      <input
        type="range"
        className="config-range-input"
        min={min}
        max={max}
        step={step}
        value={form[field]}
        onChange={handleChange(field)}
      />
      <span className="config-range-value">
        {form[field]}{unit}
      </span>
    </div>
  );

  return (
    <div className="screen">
      <div className="screen-header">
        <button className="btn btn-ghost config-back-btn" onClick={onBack}>
          ← Back
        </button>
        <h2 className="screen-title">Configuration</h2>
        <div style={{ width: '60px' }} /> {/* spacer */}
      </div>

      <div className="config-scroll">
        <p className="config-intro">
          All user-configurable settings from the CLI reference implementation.
          Changes are not yet persisted — this is a visual prototype.
        </p>

        {/* ── 1. Storage ── */}
        <Section id="storage" title="Storage" icon="💾">
          <Field label="Config Directory" hint="Where config.json lives">
            <TextInput field="configDir" placeholder="~/.config/phpoc" mono />
          </Field>
          <Field label="Data Directory" hint="Where ledger + staging live">
            <TextInput field="dataDir" placeholder="~/.local/share/phpoc" mono />
          </Field>
          <Field label="Ledger File">
            <TextInput field="ledgerFile" placeholder="ledger.json" mono />
          </Field>
          <Field label="Staging File">
            <TextInput field="stagingFile" placeholder="staging.json" mono />
          </Field>
          <Field label="Index File">
            <TextInput field="indexFile" placeholder="index.json" mono />
          </Field>
          <Field label="Identity File">
            <TextInput field="identityFile" placeholder="identity.json" mono />
          </Field>
          <Field label="Config File">
            <TextInput field="configFile" placeholder="config.json" mono />
          </Field>
        </Section>

        {/* ── 2. Remote ── */}
        <Section id="remote" title="Remote" icon="☁️">
          <Field label="Transport" hint="Protocol to reach the remote store">
            <SelectInput
              field="transport"
              options={[
                { value: 'http', label: 'HTTP (Cloudflare Worker)' },
                { value: 'git',  label: 'Git (GitHub remote)' },
              ]}
            />
          </Field>
          <Field label="Git Remote URL" hint="Only used when transport is 'git'">
            <TextInput field="gitRemoteUrl" placeholder="git@github.com:user/repo.git" mono />
          </Field>
          <Field label="Staging Path" hint="Override remote staging path">
            <TextInput field="stagingPath" placeholder="Auto (leave empty)" />
          </Field>
          <Field label="Ledger Path" hint="Override remote ledger path">
            <TextInput field="ledgerPath" placeholder="Auto (leave empty)" />
          </Field>
        </Section>

        {/* ── 3. HTTP ── */}
        <Section id="http" title="HTTP / Worker" icon="🌐">
          <Field label="Provider" hint="Worker backend type">
            <SelectInput
              field="httpProvider"
              options={[
                { value: 'cloudflare', label: 'Cloudflare Worker' },
                { value: 'generic',    label: 'Generic HTTP endpoint' },
              ]}
            />
          </Field>
          <Field label="Base URL" hint="Full Worker URL (e.g. https://worker.workers.dev)">
            <TextInput field="baseUrl" placeholder="https://your-worker.workers.dev" mono />
          </Field>
          <Field label="API Key" hint="Shared secret sent as X-Api-Key header">
            <input
              type="password"
              className="config-input config-input-mono"
              placeholder="Your API key"
              value={form.apiKey}
              onChange={handleChange('apiKey')}
            />
          </Field>
        </Section>

        {/* ── 4. Auth ── */}
        <Section id="auth" title="Authentication" icon="🔐">
          <Field label="Session Cache Timeout" hint="Minutes before re-prompting for passphrase">
            <RangeInput field="cacheTimeoutMinutes" min={1} max={240} step={1} unit=" min" />
          </Field>
          <Field>
            <Toggle field="passphraseRequired" label="Passphrase required on every launch" />
          </Field>
        </Section>

        {/* ── 5. Device ── */}
        <Section id="device" title="Device Identity" icon="📱">
          <Field label="Device Label" hint="Friendly name for this device">
            <TextInput field="deviceLabel" placeholder="e.g. My Phone, Work Laptop" />
          </Field>
          <Field label="Device ID" hint="Unique identifier (auto-generated, read-only)">
            <input
              type="text"
              className="config-input config-input-mono config-input-readonly"
              placeholder="Auto-generated on first run"
              value={form.deviceId || 'Not yet generated'}
              readOnly
            />
          </Field>
        </Section>

        {/* ── 6. Timeouts ── */}
        <Section id="timeouts" title="Timeouts" icon="⏱️">
          <Field label="Remote Check" hint="How long to wait for cookie/connectivity check">
            <RangeInput field="remoteCheckMs" min={100} max={5000} step={100} unit="ms" />
          </Field>
          <Field label="Push Timeout" hint="Max time to wait for a blob/block push">
            <RangeInput field="pushTimeoutMs" min={500} max={30000} step={500} unit="ms" />
          </Field>
        </Section>

        {/* ── 7. Cookie ── */}
        <Section id="cookie" title="Device Cookie" icon="🍪">
          <Field label="TTL" hint="Minutes until cookie expires, forcing re-auth">
            <RangeInput field="cookieTtlMinutes" min={1} max={1440} step={5} unit=" min" />
          </Field>
          <Field label="Renewal Threshold" hint="Fraction of TTL at which cookie auto-renews (0.0–1.0)">
            <RangeInput field="cookieRenewalThreshold" min={0} max={100} step={5} unit="%" />
          </Field>
          <Field>
            <Toggle field="cookieEnabled" label="Device cookie enabled" />
          </Field>
        </Section>

        {/* ── 8. Debug ── */}
        <Section id="debug" title="Debug" icon="🐛">
          <Field>
            <Toggle field="traceEnabled" label="Trace logging enabled" />
          </Field>
        </Section>

        {/* ── 9. Staging ── */}
        <Section id="staging" title="Staging Blob" icon="📦">
          <Field label="Blob Size Tier" hint="Target size for the remote staging blob">
            <SelectInput
              field="blobSizeTier"
              options={[
                { value: '16K', label: '16K (minimal)' },
                { value: '64K', label: '64K (default)' },
                { value: '256K', label: '256K (high volume)' },
                { value: '1M',  label: '1M (max)' },
              ]}
            />
          </Field>
        </Section>

        {/* ── Save bar ── */}
        <div className="config-save-bar">
          <p className="config-save-hint">
            ⚠ Configuration is not yet wired to the storage layer.
            These controls demonstrate the available settings from the CLI.
          </p>
          <button className="btn btn-primary" disabled>
            💾 Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
}
