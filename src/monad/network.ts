export type MonadNetworkName = "mainnet" | "testnet";

export type MonadNetworkConfig = {
  readonly name: MonadNetworkName;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly perplExchangeAddress: string;
  readonly explorerUrl: string;
};

/**
 * Network values are pinned from Monad's network reference and Perpl's
 * official delegated-account repository. Callers must still verify chain ID
 * and deployed bytecode before treating a configured endpoint as usable.
 */
export const MONAD_NETWORKS: Readonly<Record<MonadNetworkName, MonadNetworkConfig>> = {
  mainnet: {
    name: "mainnet",
    chainId: 143,
    rpcUrl: "https://rpc.monad.xyz",
    perplExchangeAddress: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F",
    explorerUrl: "https://monadvision.com"
  },
  testnet: {
    name: "testnet",
    chainId: 10_143,
    rpcUrl: "https://testnet-rpc.monad.xyz",
    perplExchangeAddress: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
    explorerUrl: "https://testnet.monadvision.com"
  }
};

export function resolveMonadNetwork(
  name = process.env.MONAD_NETWORK ?? "testnet",
  rpcUrl = process.env.MONAD_RPC_URL
): MonadNetworkConfig {
  if (name !== "mainnet" && name !== "testnet") {
    throw new Error(`MONAD_NETWORK must be mainnet or testnet, received ${name}`);
  }
  const network = MONAD_NETWORKS[name];
  return { ...network, rpcUrl: rpcUrl?.trim() || network.rpcUrl };
}
