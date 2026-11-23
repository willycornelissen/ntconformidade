import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GITEA_PAT_SECRET_KEY } from '@ntc/core';
import { MAX_SECRET_VALUE_BYTES, SafeStorageSecretStore, type SafeStorageBackend } from '../src/secret-store.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ntc-secret-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeMockSafeStorage(available = true, selectedBackend?: string): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => available,
    ...(selectedBackend !== undefined ? { getSelectedStorageBackend: () => selectedBackend } : {}),
    encryptString: (plainText: string) =>
      Buffer.from(`ENC:${Buffer.from(plainText, 'utf8').toString('hex')}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('ENC:')) {
        throw new Error('ciphertext inválida');
      }
      return Buffer.from(text.slice(4), 'hex').toString('utf8');
    },
  };
}

describe('SafeStorageSecretStore', () => {
  it('SS-01: encrypts secrets via safeStorage without ever storing plaintext on disk', async () => {
    const dir = createTempDir();
    const vaultPath = path.join(dir, 'secrets.enc.json');
    const store = new SafeStorageSecretStore({ vaultFilePath: vaultPath, backend: makeMockSafeStorage(true) });

    await store.setSecret(GITEA_PAT_SECRET_KEY, 'pat-super-secret-value-999');

    const rawDisk = readFileSync(vaultPath, 'utf8');
    expect(rawDisk).not.toContain('pat-super-secret-value-999');

    const status = await store.getSecretStatus(GITEA_PAT_SECRET_KEY);
    expect(status).toEqual({ configured: true });

    const decrypted = await store.getSecret(GITEA_PAT_SECRET_KEY);
    expect(decrypted).toBe('pat-super-secret-value-999');
  });

  it('SS-02: fails closed when OS safeStorage encryption is unavailable', async () => {
    const dir = createTempDir();
    const vaultPath = path.join(dir, 'secrets.enc.json');
    const store = new SafeStorageSecretStore({ vaultFilePath: vaultPath, backend: makeMockSafeStorage(false) });

    await expect(store.setSecret(GITEA_PAT_SECRET_KEY, 'secret')).rejects.toThrow(/safeStorage|indisponível/i);
    await expect(store.getSecret(GITEA_PAT_SECRET_KEY)).resolves.toBeNull();
  });

  it('SS-03: deleteSecret removes key and updates getSecretStatus cleanly', async () => {
    const dir = createTempDir();
    const vaultPath = path.join(dir, 'secrets.enc.json');
    const store = new SafeStorageSecretStore({ vaultFilePath: vaultPath, backend: makeMockSafeStorage(true) });

    await store.setSecret('ntc:llm:gemini', 'AIzaTestSecret12345');
    expect(await store.getSecretStatus('ntc:llm:gemini')).toEqual({ configured: true });

    await store.deleteSecret('ntc:llm:gemini');
    expect(await store.getSecretStatus('ntc:llm:gemini')).toEqual({ configured: false });
    expect(await store.getSecret('ntc:llm:gemini')).toBeNull();
  });

  it('SS-04: rejects empty secrets, oversized values, prototype keys, and invalid vault JSON cleanly', async () => {
    const dir = createTempDir();
    const vaultPath = path.join(dir, 'secrets.enc.json');
    const store = new SafeStorageSecretStore({ vaultFilePath: vaultPath, backend: makeMockSafeStorage(true) });

    await expect(store.setSecret('ntc:llm:gemini', '   ')).rejects.toThrow(/vazio/i);
    await expect(store.setSecret('ntc:llm:gemini', 'a'.repeat(MAX_SECRET_VALUE_BYTES + 1))).rejects.toThrow(/64 KB/i);
    await expect(store.setSecret('__proto__', 'evil')).rejects.toThrow(/inválido/i);
    await expect(store.getSecret('toString')).resolves.toBeNull();

    writeFileSync(vaultPath, '{invalid-json', { encoding: 'utf8', mode: 0o600 });
    chmodSync(vaultPath, 0o600);
    await expect(store.getSecret('ntc:llm:gemini')).rejects.toThrow(/corrompido/i);
  });

  it('SS-05: rejects decrypting existing ciphertext when OS encryption becomes unavailable', async () => {
    const dir = createTempDir();
    const vaultPath = path.join(dir, 'secrets.enc.json');
    const onlineStore = new SafeStorageSecretStore({ vaultFilePath: vaultPath, backend: makeMockSafeStorage(true) });
    await onlineStore.setSecret('ntc:llm:gemini', 'AIzaSecretABC');

    const offlineStore = new SafeStorageSecretStore({ vaultFilePath: vaultPath, backend: makeMockSafeStorage(false) });
    await expect(offlineStore.getSecret('ntc:llm:gemini')).rejects.toThrow(/safeStorage|indisponível/i);
  });

  it('SS-06: rejects insecure Linux basic_text storage backend', async () => {
    const dir = createTempDir();
    const vaultPath = path.join(dir, 'secrets.enc.json');
    const store = new SafeStorageSecretStore({
      vaultFilePath: vaultPath,
      backend: makeMockSafeStorage(true, 'basic_text'),
    });

    await expect(store.setSecret('ntc:gitea:pat', 'pat-123')).rejects.toThrow(/basic_text|inseguro/i);
  });

  it('SS-07: serializes concurrent setSecret writes without losing keys and rejects symlinks or lax modes', async () => {
    const dir = createTempDir();
    const vaultPath = path.join(dir, 'secrets.enc.json');
    const store = new SafeStorageSecretStore({ vaultFilePath: vaultPath, backend: makeMockSafeStorage(true) });

    await Promise.all([
      store.setSecret(GITEA_PAT_SECRET_KEY, 'pat-val-1'),
      store.setSecret('ntc:llm:gemini', 'gem-val-2'),
      store.setSecret('ntc:llm:openai-compatible', 'oai-val-3'),
    ]);

    expect(await store.getSecret(GITEA_PAT_SECRET_KEY)).toBe('pat-val-1');
    expect(await store.getSecret('ntc:llm:gemini')).toBe('gem-val-2');
    expect(await store.getSecret('ntc:llm:openai-compatible')).toBe('oai-val-3');

    if (process.platform !== 'win32') {
      chmodSync(vaultPath, 0o644);
      await expect(store.getSecret(GITEA_PAT_SECRET_KEY)).rejects.toThrow(/Permissões/i);
      rmSync(vaultPath);
      const target = path.join(dir, 'target.json');
      writeFileSync(target, '{"version":1,"entries":{}}', 'utf8');
      symlinkSync(target, vaultPath);
      await expect(store.getSecret(GITEA_PAT_SECRET_KEY)).rejects.toThrow(/regular seguro/i);
    }
  });
});
