import { DEFAULT_LICENCE_POLICY, type LicencePolicy } from './licence.ts';

export interface Config {
  tatumApiKey: string | undefined;
  tatumRpcUrl: string;
  memwalKey: string | undefined;
  memwalAccountId: string | undefined;
  memwalServerUrl: string;
  /** Prefix of every subject's Walrus Memory namespace: `<base>:<short address>`. */
  namespaceBase: string;
  /** Namespace override for `SHADOWRIGHT_WALLET` (default: the bare base, as in milestone 1). */
  walletNamespace: string | undefined;
  wallet: string | undefined;
  dataDir: string;
  /** Show only the first 4 hex digits of wallet addresses (screenshots, recordings). */
  maskAddresses: boolean;
  licence: LicencePolicy;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tatumApiKey: env.TATUM_API_KEY || undefined,
    // Tatum's Sui GraphQL endpoint (Tatum no longer serves Sui JSON-RPC).
    tatumRpcUrl: env.TATUM_RPC_URL || 'https://sui-mainnet.gateway.tatum.io/graphql',
    memwalKey: env.MEMWAL_PRIVATE_KEY || undefined,
    memwalAccountId: env.MEMWAL_ACCOUNT_ID || undefined,
    memwalServerUrl: env.MEMWAL_SERVER_URL || 'https://relayer.memory.walrus.xyz',
    namespaceBase: 'shadowright-v1',
    walletNamespace: env.SHADOWRIGHT_NAMESPACE || undefined,
    wallet: env.SHADOWRIGHT_WALLET || undefined,
    dataDir: env.SHADOWRIGHT_DATA_DIR || 'data',
    maskAddresses: ['1', 'true', 'yes'].includes((env.SHADOWRIGHT_MASK_ADDRESSES ?? '').toLowerCase()),
    licence: DEFAULT_LICENCE_POLICY,
  };
}

/** Returns the value or throws a message that names the missing variable (never its value). */
export function required(value: string | undefined, envName: string): string {
  if (!value) throw new Error(`Missing ${envName}. Set it in the environment or in .env (see .env.example).`);
  return value;
}
