"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronRight, Search } from "lucide-react";
import { DESTINATIONS, type BridgeRoute, type DestinationKey } from "../../config/testnet";
import { USDC, XLM, searchAssets, type SourceAsset } from "../../contracts/assets";
import { errorMessage } from "../../contracts";
import styles from "./AssetPicker.module.css";
import { Dialog } from "../common/Dialog";

export function AssetIcon({ code, network = false }: { code: string; network?: boolean }) {
  return (
    <span className={styles.assetIcon} data-asset={code} data-network={network} aria-hidden="true">
      {code === "USDC" ? "$" : code === "XLM" ? "S" : code.slice(0, 2)}
    </span>
  );
}
export function SourceAssetPicker({
  selected,
  balances,
  onSelect,
  onClose,
}: {
  selected: SourceAsset;
  balances: SourceAsset[];
  onSelect: (asset: SourceAsset) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<{
    key: string;
    assets: SourceAsset[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchAssets(query, controller.signal)
        .then((assets) => {
          if (!controller.signal.aborted) setRemote({ key: query, assets, error: null });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setRemote({ key: query, assets: [], error: errorMessage(error) });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  const loading = !!query.trim() && remote?.key !== query;
  const defaults = [
    ...new Map([USDC, XLM, ...balances].map((asset) => [asset.id, asset])).values(),
  ];
  const assets = query.trim() ? (remote?.key === query ? remote.assets : []) : defaults;
  return (
    <Dialog title="Choose a token" onClose={onClose}>
      <label className={styles.search}>
        <Search size={17} aria-hidden="true" />
        <input
          aria-label="Search Stellar assets"
          placeholder="Token code or issuer address"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </label>
      <p className={styles.note}>
        Stellar Testnet. Assets bridge through USDC when a liquid conversion path exists.
      </p>
      <div className={styles.list} aria-busy={loading}>
        {loading && <p role="status">Searching Stellar assets...</p>}
        {remote?.key === query && remote.error && <p role="alert">{remote.error}</p>}
        {!loading && assets.length === 0 && (
          <p>No matching assets. Try an exact token code or issuer.</p>
        )}
        {assets.map((asset) => (
          <button
            className={styles.option}
            type="button"
            key={asset.id}
            onClick={() => {
              onSelect(asset);
              onClose();
            }}
            aria-pressed={selected.id === asset.id}
          >
            <AssetIcon code={asset.code} />
            <span>
              <strong>{asset.code}</strong>
              <small>
                {asset.id === USDC.id
                  ? "Circle USDC"
                  : asset.issuer
                    ? `${asset.issuer.slice(0, 7)}...${asset.issuer.slice(-7)}`
                    : "Stellar Lumens"}
              </small>
            </span>
            <span className={styles.balance}>
              {balances.find((balance) => balance.id === asset.id)?.balance}
              {selected.id === asset.id && <Check size={16} aria-hidden="true" />}
            </span>
          </button>
        ))}
      </div>
      <p className={styles.note}>
        Token symbols can repeat. Verify the issuer before choosing an asset. Testnet tokens have no
        cash value.
      </p>
    </Dialog>
  );
}
export function DestinationPicker({
  destination,
  route,
  onSelect,
  onClose,
}: {
  destination: DestinationKey;
  route: BridgeRoute;
  onSelect: (destination: DestinationKey, route: BridgeRoute) => void;
  onClose: () => void;
}) {
  const [chain, setChain] = useState(destination);
  return (
    <Dialog title="Choose a destination" onClose={onClose}>
      <p className={styles.label}>NETWORK</p>
      <div className={styles.networks}>
        {DESTINATIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.network}
            aria-pressed={chain === item.key}
            onClick={() => {
              setChain(item.key);
            }}
          >
            <AssetIcon
              code={item.key === "sepolia" ? "ETH" : item.key === "base-sepolia" ? "BA" : "AR"}
              network
            />
            <span>
              {item.name}
              <small>Testnet</small>
            </span>
            {chain === item.key && <Check size={15} aria-hidden="true" />}
          </button>
        ))}
      </div>
      <p className={styles.label}>RECEIVE ASSET AND BRIDGE</p>
      <button
        className={styles.option}
        type="button"
        onClick={() => {
          onSelect(chain, 0);
          onClose();
        }}
        aria-pressed={chain === destination && route === 0}
      >
        <AssetIcon code="USDC" />
        <span>
          <strong>USDC</strong>
          <small>Native USDC via Circle CCTP</small>
        </span>
        <ArrowUpRight size={18} aria-hidden="true" />
      </button>
      <button
        className={styles.option}
        type="button"
        disabled={chain !== "sepolia"}
        onClick={() => {
          onSelect(chain, 1);
          onClose();
        }}
        aria-pressed={chain === destination && route === 1}
      >
        <AssetIcon code="USDC" />
        <span>
          <strong>USDC (ITS)</strong>
          <small>
            {chain === "sepolia"
              ? "Stellar USDC representation via Axelar ITS"
              : "Axelar ITS is configured for Sepolia"}
          </small>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
      <p className={styles.note}>
        Both bridges quote live. Route availability and receiving contracts are checked before you
        can sign.
      </p>
    </Dialog>
  );
}
export function ReviewDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <Dialog title="Review your transfer" onClose={onClose}>
      {children}
    </Dialog>
  );
}
