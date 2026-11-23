import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getErrnoCode, readNoFollowUtf8, type SecretStorePort } from '@ntc/core';

export const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const MAX_SECRET_KEY_LENGTH = 128;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Minimal subset of Electron `safeStorage` required by `SafeStorageSecretStore`. */
export interface SafeStorageBackend {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const VaultSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.string()),
});

function assertValidSecretKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed || trimmed !== key || trimmed.length > MAX_SECRET_KEY_LENGTH || FORBIDDEN_KEYS.has(key)) {
    throw new Error('Identificador de segredo inválido');
  }
}

/**
 * OS keyring-backed `SecretStorePort` persisting base64-encoded `Electron safeStorage`
 * ciphertexts inside an atomic `0o600` vault file. Never writes plaintext secrets to disk.
 */
export class SafeStorageSecretStore implements SecretStorePort {
  private readonly vaultFilePath: string;
  private readonly backend: SafeStorageBackend;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { readonly vaultFilePath: string; readonly backend: SafeStorageBackend }) {
    this.vaultFilePath = path.resolve(options.vaultFilePath);
    this.backend = options.backend;
  }

  async setSecret(key: string, plaintextValue: string): Promise<void> {
    assertValidSecretKey(key);
    this.assertSecureBackend();
    if (!plaintextValue || plaintextValue.trim().length === 0) {
      throw new Error('Segredo não pode ser vazio');
    }
    if (Buffer.byteLength(plaintextValue, 'utf8') > MAX_SECRET_VALUE_BYTES) {
      throw new Error('Segredo excede o tamanho máximo permitido (64 KB)');
    }

    await this.enqueueWrite(async () => {
      const vault = await this.readVault();
      let cipher: Buffer;
      try {
        cipher = this.backend.encryptString(plaintextValue);
      } catch (error) {
        throw new Error('Falha ao criptografar segredo com safeStorage', { cause: error });
      }
      vault.entries[key] = cipher.toString('base64');
      await this.writeVault(vault);
    });
  }

  async getSecret(key: string): Promise<string | null> {
    assertValidSecretKey(key);
    const vault = await this.readVault();
    const encoded = Object.hasOwn(vault.entries, key) ? vault.entries[key] : undefined;
    if (!encoded) {
      return null;
    }
    this.assertSecureBackend();
    try {
      return this.backend.decryptString(Buffer.from(encoded, 'base64'));
    } catch (error) {
      throw new Error('Falha ao descriptografar segredo com safeStorage', { cause: error });
    }
  }

  async getSecretStatus(key: string): Promise<{ configured: boolean }> {
    assertValidSecretKey(key);
    const vault = await this.readVault();
    const encoded = Object.hasOwn(vault.entries, key) ? vault.entries[key] : undefined;
    return { configured: typeof encoded === 'string' && encoded.length > 0 };
  }

  async deleteSecret(key: string): Promise<void> {
    assertValidSecretKey(key);
    await this.enqueueWrite(async () => {
      const vault = await this.readVault();
      if (!Object.hasOwn(vault.entries, key)) {
        return;
      }
      delete vault.entries[key];
      await this.writeVault(vault);
    });
  }

  private assertSecureBackend(): void {
    if (!this.backend.isEncryptionAvailable()) {
      throw new Error('Cofre Electron safeStorage indisponível neste ambiente');
    }
    if (typeof this.backend.getSelectedStorageBackend === 'function') {
      const selected = this.backend.getSelectedStorageBackend();
      if (selected === 'basic_text' || selected === 'unknown') {
        throw new Error(
          `Cofre safeStorage operando em modo inseguro ('${selected}'): configure keyring do sistema (gnome_libsecret/kwallet)`,
        );
      }
    }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readVault(): Promise<{ version: 1; entries: Record<string, string> }> {
    try {
      const stat = await lstat(this.vaultFilePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('Caminho do cofre não é um arquivo regular seguro');
      }
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error('Permissões do cofre inseguras; esperado 0600');
      }
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        return { version: 1, entries: Object.create(null) as Record<string, string> };
      }
      if (error instanceof Error && error.message.startsWith('Permissões do cofre')) {
        throw error;
      }
      if (error instanceof Error && error.message.startsWith('Caminho do cofre')) {
        throw error;
      }
      throw new Error('Falha ao inspecionar metadados do cofre de segredos', { cause: error });
    }

    let raw: string;
    try {
      raw = await readNoFollowUtf8(this.vaultFilePath, 2 * 1024 * 1024);
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        return { version: 1, entries: Object.create(null) as Record<string, string> };
      }
      throw new Error('Falha ao acessar cofre de segredos criptografado', { cause: error });
    }

    try {
      const parsed = VaultSchema.parse(JSON.parse(raw));
      const cleanEntries = Object.create(null) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (!FORBIDDEN_KEYS.has(k)) {
          cleanEntries[k] = v;
        }
      }
      return { version: 1, entries: cleanEntries };
    } catch (error) {
      throw new Error('Arquivo do cofre de segredos está corrompido ou em formato inválido', {
        cause: error,
      });
    }
  }

  private async writeVault(vault: { version: 1; entries: Record<string, string> }): Promise<void> {
    const dir = path.dirname(this.vaultFilePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.vaultFilePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const flags =
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(tempPath, flags, 0o600);
    try {
      await handle.writeFile(JSON.stringify(vault, null, 2), { encoding: 'utf8' });
      await handle.chmod(0o600).catch(() => undefined);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new Error('Falha ao gravar arquivo temporário do cofre de segredos', { cause: error });
    }
    await handle.close();

    try {
      await rename(tempPath, this.vaultFilePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new Error('Falha ao substituir arquivo do cofre de segredos', { cause: error });
    }
  }
}
