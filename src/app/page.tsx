import { Column, Footer, Header, Main, Shell } from "../components/chrome";
import { Bridge, ClaimRecovery } from "../components/bridge/Bridge";
export default function HomePage() {
  return (
    <Shell>
      <Header network="Stellar Testnet" />
      <Main>
        <Column>
          <div>
            <h1 className="display">Testnet transfers, on chain.</h1>
            <p className="lede">
              Connect your Stellar wallet, check the available lane, and sign a real transaction.
            </p>
          </div>
          <Bridge />
          <ClaimRecovery />
        </Column>
      </Main>
      <Footer />
    </Shell>
  );
}
