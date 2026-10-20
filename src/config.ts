import { DEFAULT_LICENCE_POLICY, type LicencePolicy } from './licence.ts';

export interface Config {
  tatumApiKey: string | undefined;
  tatumRpcUrl: string;
  memwalKey: string | undefined;
  memwalAccountId: string | undefined;
  memwalServerUrl: string;
  namespace: string;
  wallet: string | undefined;
  dataDir: string;
  licence: LicencePolicy;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tatumApiKey: env.TATUM_API_KEY || undefined,
    tatumRpcUrl: env.TATUM_RPC_URL || 'https://sui-mainnet.gateway.tatum.io',
    memwalKey: env.MEMWAL_PRIVATE_KEY || undefined,
    memwalAccountId: env.MEMWAL_ACCOUNT_ID || undefined,
    memwalServerUrl: env.MEMWAL_SERVER_URL || 'https://relayer.memory.walrus.xyz',
    namespace: env.SHADOWRIGHT_NAMESPACE || 'shadowright-v1',
    wallet: env.SHADOWRIGHT_WALLET || undefined,
    dataDir: env.SHADOWRIGHT_DATA_DIR || 'data',
    licence: DEFAULT_LICENCE_POLICY,
  };
}

/** Returns the value or throws a message that names the missing variable (never its value). */
export function required(value: string | undefined, envName: string): string {
  if (!value) throw new Error(`Missing ${envName}. Set it in the environment or in .env (see .env.example).`);
  return value;
}
