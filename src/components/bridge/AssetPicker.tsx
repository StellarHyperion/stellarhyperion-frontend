"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronRight, Copy, Search } from "lucide-react";
import { parseUnits } from "@hyperion/protocol";
import { DESTINATIONS, type BridgeRoute, type DestinationKey } from "../../config/testnet";
import {
  issuerVerificationLabel,
  MAX_CONVERSION_PATHS,
  trustlineLabel,
  USDC,
  XLM,
  searchAssets,
  type SourceAsset,
} from "../../contracts/assets";
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
export function CopyableAddress({ value, label }: { value: string; label: string }) {
  const [copyStatus, setCopyStatus] = useState<{
    value: string;
    state: "copied" | "failed";
  } | null>(null);
  const copy = async () => {
    setCopyStatus(null);
    try {
      const clipboard = navigator.clipboard as Partial<Clipboard> | undefined;
      if (!clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await clipboard.writeText(value);
      setCopyStatus({ value, state: "copied" });
    } catch {
      setCopyStatus({ value, state: "failed" });
    }
  };
  return (
    <span className={styles.copyAddress}>
      <code>{value}</code>
      <button type="button" aria-label={`Copy ${label}`} onClick={() => void copy()}>
        <Copy size={13} aria-hidden="true" />
      </button>
      {copyStatus?.value === value && copyStatus.state === "copied" && (
        <span role="status">Copied</span>
      )}
      {copyStatus?.value === value && copyStatus.state === "failed" && (
        <span role="alert">Copy failed; select the address to copy it.</span>
      )}
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
  const latestRequest = useRef(0);
  const [query, setQuery] = useState("");
  const [queryVersion, setQueryVersion] = useState(0);
  const [pageLimit, setPageLimit] = useState(25);
  const [selectedId, setSelectedId] = useState(selected.id);
  const [remote, setRemote] = useState<{
    key: string;
    version: number;
    assets: SourceAsset[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const version = queryVersion;
    const requestId = ++latestRequest.current;
    const timer = setTimeout(() => {
      void searchAssets(query, controller.signal)
        .then((assets) => {
          if (!controller.signal.aborted && requestId === latestRequest.current)
            setRemote({ key: query, version, assets, error: null });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted && requestId === latestRequest.current)
            setRemote({ key: query, version, assets: [], error: errorMessage(error) });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, queryVersion]);
  const loading = !!query.trim() && (remote?.key !== query || remote.version !== queryVersion);
  const defaults = [
    ...new Map([USDC, XLM, ...balances].map((asset) => [asset.id, asset])).values(),
  ];
  const rawAssets = query.trim()
    ? remote?.key === query && remote.version === queryVersion
      ? remote.assets
      : []
    : defaults;
  const assets = useMemo(() => {
    const byIdentity = new Map<string, SourceAsset>();
    for (const asset of rawAssets) {
      const identity = `${asset.code}:${asset.issuer ?? "native"}`;
      if (!byIdentity.has(identity)) byIdentity.set(identity, asset);
    }
    return [...byIdentity.values()];
  }, [rawAssets]);
  const visibleAssets = assets.slice(0, pageLimit);
  const hasMore = assets.length > pageLimit;
  const exhausted = !loading && !hasMore && assets.length > 0;
  void selectedId;
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
            setQueryVersion((version) => version + 1);
          }}
        />
      </label>
      <p className={styles.note}>
        Stellar Testnet. Non-USDC quotes compare up to {MAX_CONVERSION_PATHS} Horizon paths by exact
        USDC output. Only paths matching the asset identity and requested source amount qualify.
      </p>
      <div className={styles.list} aria-busy={loading}>
        {loading && <p role="status">Searching Stellar assets...</p>}
        {remote?.key === query && remote.version === queryVersion && remote.error && (
          <p role="alert">{remote.error}</p>
        )}
        {!loading && assets.length === 0 && (
          <p>No matching assets. Try an exact token code or issuer.</p>
        )}
        {visibleAssets.map((asset) => {
          const walletAsset = balances.find((balance) => balance.id === asset.id);
          const currentAsset = walletAsset ?? asset;
          const hasLiabilities =
            walletAsset?.sellingLiabilities && parseUnits(walletAsset.sellingLiabilities, 7) > 0n;
          return (
            <div className={styles.assetChoice} key={asset.id}>
              <button
                className={styles.option}
                type="button"
                onClick={() => {
                  onSelect(currentAsset);
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
                  {walletAsset
                    ? hasLiabilities
                      ? (walletAsset.available ?? walletAsset.balance)
                      : walletAsset.balance
                    : undefined}
                  {selected.id === asset.id && <Check size={16} aria-hidden="true" />}
                </span>
              </button>
              <details className={styles.issuerDetails}>
                <summary>
                  {asset.issuer ? "Inspect issuer and trustline" : "Inspect asset identity"}
                </summary>
                <dl>
                  <div>
                    <dt>Issuer</dt>
                    <dd>
                      {currentAsset.issuer ? (
                        <CopyableAddress value={currentAsset.issuer} label="asset issuer" />
                      ) : (
                        "None. This is native XLM."
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Issuer source</dt>
                    <dd>{issuerVerificationLabel(currentAsset)}</dd>
                  </div>
                  <div>
                    <dt>Trustline</dt>
                    <dd>{trustlineLabel(currentAsset)}</dd>
                  </div>
                  {walletAsset?.balance && (
                    <div>
                      <dt>Total balance</dt>
                      <dd>{walletAsset.balance}</dd>
                    </div>
                  )}
                  {hasLiabilities && walletAsset.sellingLiabilities && (
                    <div>
                      <dt>Selling liabilities</dt>
                      <dd>{walletAsset.sellingLiabilities}</dd>
                    </div>
                  )}
                  {hasLiabilities && walletAsset.available && (
                    <div>
                      <dt>Spendable balance</dt>
                      <dd>{walletAsset.available}</dd>
                    </div>
                  )}
                </dl>
              </details>
            </div>
          );
        })}
        {hasMore && (
          <button type="button" onClick={() => setPageLimit((limit) => limit + 25)}>
            Load more assets
          </button>
        )}
        {exhausted && <p role="status">All matching assets are shown.</p>}
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
            disabled={!item.routes.includes(0)}
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
          <small>Circle CCTP delivers native USDC, distinct from ITS</small>
        </span>
        <ArrowUpRight size={18} aria-hidden="true" />
      </button>
      <button
        className={styles.option}
        type="button"
        disabled={!DESTINATIONS.find((item) => item.key === chain)?.routes.includes(1)}
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
              ? "Axelar ITS representation, distinct from native Circle USDC"
              : "Axelar ITS is configured for Sepolia"}
          </small>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
      <p className={styles.note}>
        Only independently verified testnet lanes are offered. Route availability and receiving
        contracts are checked again before you can sign.
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
