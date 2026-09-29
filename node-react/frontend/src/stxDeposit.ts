import { openStxPopup } from "./api";
import { track } from "./analytics";
import { stxUrl } from "./publicMarketData";

// Add funds to the member's STX account: the exchange's own deposit page, in a
// popup. The ISV never touches those funds.
export function openStxDeposit(): void {
  track("deposit_click");
  openStxPopup(`${stxUrl()}/player/deposit_funds`, "stx_deposit", { w: 540, h: 780 });
}
