/**
 * plugin_factory — deployment-aware factory functions.
 *
 * Two exports:
 *   createStoragePlugin()  — local storage backend (IndexedDB / HttpBackend / Mock / Memory)
 *   createRemoteTransport() — remote transport for SyncService (HttpTransport | null)
 *
 * These are separate concerns:
 *   - Storage handles local persistence (get/set/remove/list/clear).
 *   - Transport handles the wire protocol (GET/PUT/DELETE/LIST over HTTP).
 *
 * Both are constructed from the same deployment config, but independently —
 * a SaaS deployment gets IndexedDB (local) + HttpTransport (remote), not an
 * HttpBackend that replaces local storage.
 *
 * Deployment decision tree (from config or auto-detection):
 *
 *   deployment        → StorageBackend         Transport
 *   "standalone"      → IndexedDBBackend       null
 *   "lan"             → HttpBackend *          HttpTransport (if baseUrl)
 *   "saas"            → HttpBackend *          HttpTransport (if baseUrl)
 *   "mock"            → MockRemoteBackend      null
 *   "memory"          → MemoryBackend          null
 *
 *   * createStoragePlugin currently returns HttpBackend for lan/saas.
 *     The target architecture is IndexedDBBackend + HttpTransport — see
 *     SESSION_HANDOFF.md §Remote Sync Wiring.
 *
 * The deployment is determined by (in priority order):
 *   1. Explicit config key in localStorage:  phpoc_deployment
 *   2. URL parameter:                        ?deployment=saas
 *   3. Presence of phpoc_worker_url config:  → "saas"
 *   4. Default:                              → "standalone"
 *
 * Usage:
 *   import { createStoragePlugin, createRemoteTransport } from '@sync/plugin_factory.js';
 *   const { deployment, config } = detectDeployment();
 *   const storage = await createStoragePlugin({ deployment, config });
 *   const transport = createRemoteTransport({ deployment, config });
 *   const sync = new SyncService(storage, crypto, transport);
 */

import { MemoryBackend } from './storage.js';
import { IndexedDBBackend } from './indexeddb_storage.js';
import { HttpBackend } from './http_backend.js';
import { HttpTransport } from './transport.js';
import { MockRemoteBackend } from './mock_remote_backend.js';

/**
 * @typedef {'standalone'|'lan'|'saas'|'mock'|'memory'} DeploymentType
 */

/**
 * Determine which deployment to use from config/env.
 *
 * @returns {{ deployment: DeploymentType, config: object }}
 */
export function detectDeployment() {
  // 1. URL parameter ?deployment=...
  const urlParams = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const urlDeploy = urlParams.get('deployment');
  if (urlDeploy) {
    return { deployment: validateDeployment(urlDeploy), config: {} };
  }

  // 2. localStorage key
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('phpoc_deployment');
    if (stored) {
      return { deployment: validateDeployment(stored), config: {} };
    }
  }

  // 3. If a worker URL is configured, use SaaS
  if (typeof localStorage !== 'undefined') {
    const workerUrl = localStorage.getItem('phpoc_worker_url');
    if (workerUrl) {
      return {
        deployment: 'saas',
        config: {
          baseUrl: workerUrl,
          apiKey: localStorage.getItem('phpoc_api_key') || '',
        },
      };
    }
  }

  // 4. Default: standalone PWA with IndexedDB
  return { deployment: 'standalone', config: {} };
}

/**
 * Validate a deployment string, falling back to 'standalone'.
 *
 * @param {string} deploy
 * @returns {DeploymentType}
 */
function validateDeployment(deploy) {
  const valid = ['standalone', 'lan', 'saas', 'mock', 'memory'];
  return valid.includes(deploy) ? deploy : 'standalone';
}

/**
 * Create a StoragePlugin based on the detected deployment.
 *
 * @param {object} [override]
 * @param {DeploymentType} [override.deployment] — Force a specific deployment.
 * @param {object} [override.config] — Override config for the selected backend.
 * @returns {Promise<import('./storage_plugin.js').StoragePlugin>}
 */
export async function createStoragePlugin(override = {}) {
  const { deployment, config: detectedConfig } = override.deployment
    ? { deployment: validateDeployment(override.deployment), config: override.config || {} }
    : detectDeployment();

  const config = { ...detectedConfig, ...(override.config || {}) };

  switch (deployment) {
    case 'memory':
      return new MemoryBackend();

    case 'standalone':
      return new IndexedDBBackend();

    case 'mock':
      return new MockRemoteBackend({
        latencyMs: config.latencyMs || 50,
        errorRate: config.errorRate || 0,
      });

    case 'lan':
    case 'saas': {
      const ls = typeof localStorage !== 'undefined' ? localStorage : null;
      const baseUrl = config.baseUrl || (ls ? ls.getItem('phpoc_worker_url') : '') || '';
      const apiKey = config.apiKey || (ls ? ls.getItem('phpoc_api_key') : '') || '';
      if (!baseUrl) {
        console.warn(
          `createStoragePlugin: deployment "${deployment}" requires a baseUrl. ` +
          'Falling back to standalone IndexedDB.'
        );
        return new IndexedDBBackend();
      }
      return new HttpBackend({ baseUrl, apiKey });
    }

    default:
      return new IndexedDBBackend();
  }
}

/**
 * Create a remote transport based on deployment config.
 *
 * Only creates an HttpTransport for remote-enabled deployments (saas, lan)
 * when a baseUrl is provided. Returns null for local-only deployments
 * (standalone, mock, memory) or when baseUrl is missing.
 *
 * This is a separate concern from createStoragePlugin() — transport handles
 * the wire protocol (GET/PUT/DELETE/LIST) while storage handles local
 * persistence (IndexedDB, Memory, HttpBackend).
 *
 * @param {object} [options]
 * @param {string} [options.deployment] - Deployment type
 * @param {object} [options.config] - Configuration
 * @param {string} [options.config.baseUrl] - Remote server URL
 * @param {string} [options.config.apiKey] - API key for auth
 * @returns {HttpTransport|null}
 */
export function createRemoteTransport({ deployment, config = {} } = {}) {
  // Only saas and lan use remote transport
  if (deployment !== 'saas' && deployment !== 'lan') {
    return null;
  }

  const baseUrl = config.baseUrl || '';

  // No baseUrl → no remote transport
  if (!baseUrl) {
    return null;
  }

  return new HttpTransport({
    baseUrl,
    apiKey: config.apiKey || null,
  });
}
