"use client";

import type { ReactElement } from "react";
import { EvmWalletButton } from "./EvmWalletButton";
import { StellarWalletButton } from "./StellarWalletButton";

export function WalletButton(): ReactElement {
  return (
    <>
      <StellarWalletButton />
      <EvmWalletButton />
    </>
  );
}

export { StellarWalletButton, EvmWalletButton };
export default WalletButton;
