// Peer-Multiple Radar model.
//
// One sealed snapshot goes in and one deterministic board comes out. The board ranks every
// protocol that records no token. Its central input is not a hand-picked valuation list: for
// each category, protocols whose tokens already trade provide market-cap / TVL observations
// from this same snapshot, and the category multiple is the median of those observations.
//
// implied value = TVL x category multiple x growth multiplier x age multiplier x chain multiplier
//
// Robustness rules, all stated here and repeated on the dashboard:
// - A tokenized peer is a protocol with mcap_usd present and tvl_usd > 0.
// - Peer ratios are winsorized to [0.001, 3.000] before any median is taken, so one tiny or
//   distressed comparable cannot dictate a whole category.
// - With at least three peers, the category multiple is that category's median ratio.
// - With one or two peers, it is shrunk toward the global median:
//     (peer_count x category_median + 3 x global_median) / (peer_count + 3).
// - With no peers, it is the global median. The final multiple is clamped to [0.005, 2.500].
// - Seven-day TVL change is clamped to [-60%, +120%] and contributes half its percentage.
// - Age runs from listed_at to the snapshot's as_of date. The age multiplier rises linearly
//   from 0.85 to 1.15 over 1,095 days; an unknown listing date is neutral at 1.00.
// - Chain breadth adds 3% per additional chain, capped at a 1.24 multiplier.
// - Structure discount: recording no token is not the same as being a future-token candidate.
//   A wrapped, staked or bridged product of an asset whose token already trades, and an
//   exchange product, would see any token value accrue mostly to that existing asset or
//   platform rather than to a new standalone token. Such rows are flagged from the record
//   alone, using the same patterns the house watchlist rule uses (product categories, the
//   whole words wrapped/staked/staking, version-marker name endings, the CEX category and
//   exchange name prefixes), and their implied value is multiplied by 0.25.
// No slug, name, or category receives a bespoke value outside these published rules.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Peer {
  slug: string;
  name: string;
  symbol: string | null;
  category: string;
  mcap_usd: number;
  tvl_usd: number;
  ratio: number;
}

export interface CategoryStat {
  category: string;
  multiple: number;
  peer_median: number | null;
  peer_count: number;
  method: string;
  peers: Peer[];
}

export type ProductFlag = 'wrapped_or_staked_product' | 'exchange' | null;

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  category_multiple: number;
  growth_mult: number;
  age_mult: number;
  chain_mult: number;
  product_flag: ProductFlag;
  structure_mult: number;
  implied_tvl_ratio: number;
  watchlist: boolean;
  token_status: string;
}

export interface LiveToken {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  mcap_tvl_ratio: number;
}

export interface RadarData {
  meta: {
    as_of: string;
    source: string;
    floor_usd: number;
    total_protocols: number;
    pre_token_count: number;
    watchlist_count: number;
    tokenized_count: number;
    board_size: number;
    model_version: string;
  };
  model: {
    formula: string;
    global_median_ratio: number;
    peer_ratio_floor: number;
    peer_ratio_cap: number;
    shrinkage_prior: number;
    growth_clamp: [number, number];
    growth_weight: number;
    age_floor_mult: number;
    age_range: number;
    age_horizon_days: number;
    unknown_age_mult: number;
    chain_step: number;
    chain_cap: number;
    structure_discount: number;
    category_multiple_clamp: [number, number];
    disclaimer: string;
  };
  categories: CategoryStat[];
  rows: BoardRow[];
  live_tokens: LiveToken[];
}

export const MODEL_VERSION = 'peer-multiple-radar-2';

export const MODEL = {
  peerRatioFloor: 0.001,
  peerRatioCap: 3,
  shrinkagePrior: 3,
  categoryMultipleMin: 0.005,
  categoryMultipleMax: 2.5,
  growthLow: -60,
  growthHigh: 120,
  growthWeight: 0.5,
  ageFloorMult: 0.85,
  ageRange: 0.3,
  ageHorizonDays: 1095,
  unknownAgeMult: 1,
  chainStep: 0.03,
  chainCap: 1.24,
  structureDiscount: 0.25,
  liveRows: 24,
  peersPerCategory: 6,
};

export function parseSnapshot(text: string): Snapshot {
  const value = JSON.parse(text) as Snapshot;
  if (value === null || typeof value !== 'object' || !Array.isArray(value.protocols) || !Array.isArray(value.watchlist)) {
    throw new Error('snapshot must be an object with protocols and watchlist arrays');
  }
  if (typeof value.as_of !== 'string' || typeof value.floor_usd !== 'number') {
    throw new Error('snapshot must carry as_of and floor_usd');
  }
  return value;
}

export function isPreToken(protocol: Protocol): boolean {
  return protocol.gecko_id === null && protocol.symbol === null;
}

const WRAPPED_PRODUCT_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Cross Chain Bridge',
]);
const WRAPPED_OR_STAKED_WORD = /\b(wrapped|staked|staking)\b/i;
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCHANGE_NAME_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a pre-token record is nevertheless a poor future-token candidate, judged from the
 * record alone with the same patterns the house watchlist rule uses. A wrapped, staked or
 * bridged product of an asset that already trades is checked first and wins over the
 * exchange classification when both match.
 */
export function productFlag(protocol: Protocol): ProductFlag {
  if (
    (protocol.category !== null && WRAPPED_PRODUCT_CATEGORIES.has(protocol.category))
    || WRAPPED_OR_STAKED_WORD.test(protocol.name)
    || VERSION_MARKER.test(protocol.name)
  ) {
    return 'wrapped_or_staked_product';
  }
  if (protocol.category === 'CEX' || EXCHANGE_NAME_PREFIXES.some((prefix) => protocol.name.startsWith(prefix))) {
    return 'exchange';
  }
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function categoryName(protocol: Protocol): string {
  return protocol.category ?? 'Uncategorized';
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

export function categoryStats(snapshot: Snapshot): { globalMedian: number; categories: CategoryStat[] } {
  const tokenized = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const allRatios = tokenized.map((p) => clamp(p.mcap_usd! / p.tvl_usd, MODEL.peerRatioFloor, MODEL.peerRatioCap));
  const globalMedian = median(allRatios);
  const byCategory = new Map<string, Peer[]>();

  for (const protocol of tokenized) {
    const category = categoryName(protocol);
    const peer: Peer = {
      slug: protocol.slug,
      name: protocol.name,
      symbol: protocol.symbol,
      category,
      mcap_usd: protocol.mcap_usd!,
      tvl_usd: protocol.tvl_usd,
      ratio: clamp(protocol.mcap_usd! / protocol.tvl_usd, MODEL.peerRatioFloor, MODEL.peerRatioCap),
    };
    const list = byCategory.get(category) ?? [];
    list.push(peer);
    byCategory.set(category, list);
  }

  const categoryNames = new Set<string>();
  for (const protocol of snapshot.protocols) categoryNames.add(categoryName(protocol));

  const categories: CategoryStat[] = [...categoryNames].sort().map((category) => {
    const peers = [...(byCategory.get(category) ?? [])].sort((a, b) => b.mcap_usd - a.mcap_usd || a.slug.localeCompare(b.slug));
    if (peers.length === 0) {
      return { category, multiple: globalMedian, peer_median: null, peer_count: 0, method: 'global median (no tokenized peers)', peers: [] };
    }
    const peerMedian = median(peers.map((peer) => peer.ratio));
    const raw = peers.length >= 3
      ? peerMedian
      : (peers.length * peerMedian + MODEL.shrinkagePrior * globalMedian) / (peers.length + MODEL.shrinkagePrior);
    return {
      category,
      multiple: clamp(raw, MODEL.categoryMultipleMin, MODEL.categoryMultipleMax),
      peer_median: peerMedian,
      peer_count: peers.length,
      method: peers.length >= 3 ? 'category median' : 'category median shrunk toward global median',
      peers: peers.slice(0, MODEL.peersPerCategory),
    };
  });
  return { globalMedian, categories };
}

function tvlTier(tvl: number): { label: string; position: string; activity: string } {
  if (tvl >= 1_000_000_000) return { label: 'mega-cap TVL', position: '$5,000-$25,000', activity: '$2,500-$10,000' };
  if (tvl >= 250_000_000) return { label: 'large TVL', position: '$2,500-$10,000', activity: '$1,000-$5,000' };
  if (tvl >= 50_000_000) return { label: 'established TVL', position: '$1,000-$5,000', activity: '$500-$2,500' };
  if (tvl >= 10_000_000) return { label: 'growth-stage TVL', position: '$250-$1,500', activity: '$100-$750' };
  return { label: 'early TVL', position: '$50-$500', activity: '$25-$250' };
}

function networkCost(chain: string): string {
  if (chain === 'Ethereum' || chain === 'Bitcoin') return '$15-$75 in network fees over the full test';
  if (['Solana', 'TON', 'Tron', 'Sui', 'Aptos', 'Near', 'Stellar'].includes(chain)) return '$0.10-$3 in network fees over the full test';
  return '$1-$12 in network fees over the full test';
}

interface FarmContext {
  name: string;
  chain: string;
  chains: string;
  position: string;
  activity: string;
  fees: string;
  tier: string;
}

function fill(template: string, context: FarmContext): string {
  return template
    .replaceAll('{name}', context.name)
    .replaceAll('{chain}', context.chain)
    .replaceAll('{chains}', context.chains)
    .replaceAll('{position}', context.position)
    .replaceAll('{activity}', context.activity)
    .replaceAll('{fees}', context.fees)
    .replaceAll('{tier}', context.tier);
}

const PLAYBOOKS: Record<string, [string, string, string]> = {
  Dexs: [
    'Make {activity} of real swaps on {name} through {chain}, split across several pairs and days rather than one wash-like burst. Cost: {fees}; time: 20 minutes weekly for 10 weeks.',
    'Add a small two-sided liquidity position on {name} and keep it inside the active range; rebalance only when price leaves the range. Cost: a {position} position plus {fees}; time: 30 minutes to open and 10 minutes weekly for 8 weeks.',
    'Use {name} for one recurring trade you would make anyway, such as a weekly stablecoin conversion, and save the transaction receipts. Cost: normal spread plus {fees}; time: 10 minutes weekly for 12 weeks.',
  ],
  Lending: [
    'Supply {position} of a liquid collateral asset to {name} on {chain}; keep utilization and health factor visible in a weekly check. Cost: {fees} and opportunity cost on the deposit; time: 25 minutes to open and 10 minutes weekly for 10 weeks.',
    'Borrow no more than 25% of the supplied value on {name}, repay within seven days, and repeat only twice so the account shows prudent credit use. Cost: quoted interest plus {fees}; time: 20 minutes per cycle across 6 weeks.',
    'Repay in full, withdraw part of the collateral, then redeposit a smaller amount to create a clean second cycle on {name}. Cost: {fees}; time: 30 minutes total, spread over weeks 8-12.',
  ],
  'Uncollateralized Lending': [
    'Complete the public onboarding for {name}, fund only {position}, and choose the shortest available term first. Cost: platform fees stated at confirmation plus {fees}; time: 45 minutes to apply and 10 minutes weekly for 8 weeks.',
    'Make every repayment on {name} early or on time and download the loan record after settlement. Cost: quoted interest on the selected loan; time: 15 minutes per payment over one full term.',
    'Repeat with a second small facility on {name} only after the first is closed, keeping total exposure below {position}. Cost: quoted interest plus {fees}; time: one additional term of 4-8 weeks.',
  ],
  Bridge: [
    'Bridge {activity} to {chain} through {name}, then make the return trip on a different day so both directions form ordinary use. Cost: bridge fee plus {fees}; time: 20 minutes per trip over 8 weeks.',
    'Route one transfer through each of two corridors {name} supports from {chains}, using the smallest amount that remains economical after fees. Cost: two bridge fees plus {fees}; time: 45 minutes total in the first month.',
    'After bridging to {chain}, use a local application once before returning funds, rather than treating {name} as a one-click loop. Cost: {fees}; time: 30 minutes monthly for 3 months.',
  ],
  'Canonical Bridge': [
    'Bridge {activity} from the canonical origin into {chain} with {name} and leave the funds working there for at least two weeks. Cost: source-chain gas, approximately {fees}; time: 25 minutes to bridge and 10 minutes weekly for 8 weeks.',
    'Withdraw a smaller amount through {name} after the waiting period and record the full round trip. Cost: withdrawal gas within {fees}; time: 30 minutes plus the protocol waiting period.',
    'Repeat the deposit at one-quarter of the first size on {name} in a later month, avoiding same-day circular transfers. Cost: {fees}; time: 20 minutes per later deposit across 3 months.',
  ],
  'Cross Chain Bridge': [
    'Send {activity} across two different routes supported by {name}, starting from {chain}, and compare the quoted fee before confirming. Cost: two route fees plus {fees}; time: 40 minutes in week 1.',
    'Keep the destination balance active for 14 days, then bridge half back through {name}; do not split funds into dozens of artificial hops. Cost: return fee plus {fees}; time: 20 minutes in week 3.',
    'Make one monthly transfer through {name} tied to a real portfolio move, and log route, fee and settlement time. Cost: one route fee monthly; time: 15 minutes monthly for 3 months.',
  ],
  'Liquid Staking': [
    'Stake {position} of the base asset through {name} on {chain} and hold the receipt position without leverage. Cost: {fees}; time: 20 minutes to stake and 5 minutes weekly for 12 weeks.',
    'Use a small part of the {name} receipt token in one conservative integration, while keeping at least 80% unstaked from extra contract risk. Cost: integration gas within {fees}; time: 30 minutes in week 3.',
    'Request a partial unstake from {name}, observe the actual exit queue, and restake only after the first exit settles. Cost: {fees}; time: 20 minutes plus the stated unbonding period.',
  ],
  'Liquid Restaking': [
    'Deposit {position} through {name} on {chain} and select the most conservative operator or vault option available. Cost: {fees}; time: 30 minutes to research and deposit, then 10 minutes weekly for 10 weeks.',
    'Hold the {name} receipt for a full month before adding anything, and write down slashing and operator risks in your tracker. Cost: opportunity cost only after the first deposit; time: 15 minutes monthly for 3 months.',
    'Withdraw 25% through {name} after the first month to test liquidity and fees, leaving the rest only if the exit is clean. Cost: {fees}; time: 20 minutes plus any unbonding period.',
  ],
  Restaking: [
    'Restake {position} through {name} on {chain}, choosing the lowest-risk service set rather than the highest advertised reward. Cost: {fees}; time: 40 minutes to compare options and deposit.',
    'Review {name} operator changes and rewards monthly; do not compound automatically until the first withdrawal test succeeds. Cost: {fees} for any change; time: 15 minutes monthly for 3 months.',
    'Exit one-quarter of the {name} position after 8 weeks and compare the realized result with simply staking. Cost: {fees}; time: 20 minutes plus the exit period.',
  ],
  'Restaked BTC': [
    'Deposit {position} of BTC exposure through {name}, using the official {chain} route and a fresh address label for tracking. Cost: {fees}; time: 35 minutes to deposit and verify.',
    'Hold the {name} position for at least 8 weeks and avoid wrapping it through additional leveraged products. Cost: opportunity cost only; time: 10 minutes weekly to check status for 8 weeks.',
    'Withdraw a small slice through {name} before adding more, confirming custody, timing and fees end to end. Cost: {fees}; time: 30 minutes plus the withdrawal window.',
  ],
  'Staking Pool': [
    'Delegate {position} through {name} on {chain}; choose a validator or pool with a public performance record. Cost: {fees}; time: 20 minutes to delegate.',
    'Claim or compound rewards on {name} once a month rather than daily, keeping fee drag visible. Cost: {fees}; time: 10 minutes monthly for 3 months.',
    'Undelegate 20% through {name} after eight weeks to test the exit, then decide whether to redelegate. Cost: {fees}; time: 15 minutes plus the unbonding period.',
  ],
  Derivatives: [
    'Open one small, fully collateralized position on {name} with {position} maximum margin and a predefined exit; avoid liquidation-level leverage. Cost: trading fees plus {fees}; time: 30 minutes to plan and 10 minutes daily while open for 2 weeks.',
    'Close the first {name} trade, export the fill history, and repeat with a different market only after reviewing fees and slippage. Cost: trading fees on both sides; time: two 1-week cycles over 6 weeks.',
    'Use one hedge on {name} against an existing spot position, sized below 25% of that holding. Cost: funding and trading fees shown before entry; time: 20 minutes to open and 10 minutes weekly for 4 weeks.',
  ],
  'Interest Rate Derivatives': [
    'Quote a small fixed-rate position on {name} using {position} maximum collateral and record the implied rate before signing. Cost: quoted premium plus {fees}; time: 40 minutes for the first comparison.',
    'Hold the {name} position to its first reset or expiry rather than churning it, and log the realized rate. Cost: opportunity cost only; time: 10 minutes weekly until expiry.',
    'Roll only half of the matured {name} exposure into a second tenor so the account shows measured, not maximal, use. Cost: second premium plus {fees}; time: 25 minutes at rollover.',
  ],
  Options: [
    'Buy or sell one small, defined-risk option on {name} with premium capped inside {activity}; avoid uncovered exposure. Cost: the quoted premium plus {fees}; time: 35 minutes to select and document the trade.',
    'Hold the {name} option to expiry or close it at a preset level, then save the payoff calculation. Cost: closing fee if exited early; time: 10 minutes weekly until expiry.',
    'Repeat once in a different expiry month on {name}, keeping total premium below {activity}. Cost: second premium plus {fees}; time: 25 minutes for the second trade.',
  ],
  'Options Vault': [
    'Deposit {position} into one conservative {name} vault on {chain}; read the strategy and withdrawal window before confirming. Cost: {fees}; time: 30 minutes to deposit.',
    'Leave the {name} vault through one full epoch and record net performance after fees rather than headline yield. Cost: vault fees already embedded in performance; time: 10 minutes weekly for 6 weeks.',
    'Withdraw 25% at an allowed {name} window, then redeposit only if the realized result and liquidity are acceptable. Cost: {fees}; time: 20 minutes plus the vault epoch.',
  ],
  Yield: [
    'Deposit {position} into the plainest earning position on {name} via {chain}; avoid leveraged or looping variants for the first cycle. Cost: {fees}; time: 25 minutes to open and 10 minutes weekly for 10 weeks.',
    'Harvest or compound once on {name} after four weeks and compare net yield with the deposit-day quote. Cost: {fees}; time: 15 minutes in week 5.',
    'Withdraw one-third from {name} after eight weeks to verify liquidity, fees and the actual exit amount. Cost: {fees}; time: 20 minutes in week 9.',
  ],
  'Yield Aggregator': [
    'Allocate {position} to one diversified {name} vault on {chain}, not the highest-yielding outlier. Cost: {fees}; time: 30 minutes to compare vaults and deposit.',
    'Let {name} rebalance for one full month, then export the position history and calculate net return after all fees. Cost: embedded vault fees; time: 15 minutes monthly for 3 months.',
    'Move 25% to a second {name} vault only if it uses a different underlying strategy; otherwise withdraw it. Cost: {fees}; time: 20 minutes in month 2.',
  ],
  Farm: [
    'Enter one core {name} farm with {position}, split evenly between the paired assets where a pair is required. Cost: {fees} plus possible impermanent loss; time: 35 minutes to open.',
    'Claim rewards from {name} monthly and sell or hold them by a written rule, rather than compounding by habit. Cost: {fees}; time: 10 minutes monthly for 3 months.',
    'Exit 25% of the {name} farm after eight weeks to measure realized return including price movement. Cost: {fees}; time: 20 minutes in week 9.',
  ],
  'Leveraged Farming': [
    'Open {name} at the lowest leverage setting with no more than {position} of equity; set a liquidation alert before confirming. Cost: borrowing interest plus {fees}; time: 40 minutes to model the position.',
    'Reduce the {name} position by one-third after two weeks, even if it is profitable, to prove the exit path. Cost: trading and borrow fees; time: 20 minutes in week 3.',
    'Close the first {name} cycle by week 6 and wait at least two weeks before considering a second, smaller cycle. Cost: closing fees within {fees}; time: 30 minutes to close and review.',
  ],
  'Liquidity Manager': [
    'Place {position} into one managed range on {name} via {chain}; choose the widest conservative range rather than the highest fee tier. Cost: {fees}; time: 35 minutes to configure.',
    'Review the {name} range weekly and rebalance only when the position is out of range for two consecutive checks. Cost: {fees} per rebalance; time: 10 minutes weekly for 10 weeks.',
    'Withdraw 25% from {name} after two months and compare fees earned with impermanent loss. Cost: {fees}; time: 20 minutes in week 9.',
  ],
  CDP: [
    'Mint a small amount of debt on {name} against {position} of collateral, keeping the collateral ratio at least twice the minimum. Cost: {fees}; time: 30 minutes to open and document liquidation levels.',
    'Repay 25% of the {name} debt after two weeks and add collateral if the market has moved against the position. Cost: stability fees plus {fees}; time: 15 minutes in week 3.',
    'Close the {name} position fully by week 8, then reopen at half size only if the first cycle was clean. Cost: repayment fees within {fees}; time: 25 minutes to close.',
  ],
  'CDP Manager': [
    'Open one managed vault on {name} with {position} collateral and a conservative target ratio. Cost: {fees}; time: 35 minutes to configure alerts and automation.',
    'Let the {name} manager run for four weeks without manual leverage changes; log every automated adjustment. Cost: management and stability fees shown in the vault; time: 10 minutes weekly for 4 weeks.',
    'Disable automation on {name}, repay the debt, and withdraw collateral to verify the manual exit. Cost: {fees}; time: 30 minutes in week 6.',
  ],
  'Dual-Token Stablecoin': [
    'Acquire {position} split between the two tokens used by {name}, following its public mint or market route on {chain}. Cost: spread plus {fees}; time: 35 minutes to balance the pair.',
    'Use the stable side of {name} in one low-risk payment or deposit, keeping the volatile side unlevered. Cost: {fees}; time: 20 minutes in week 2.',
    'Redeem or sell one-quarter of the {name} pair after six weeks to test both legs under normal conditions. Cost: spread plus {fees}; time: 25 minutes in week 7.',
  ],
  'Stablecoin Wrapper': [
    'Wrap {position} through {name} on {chain} and hold the wrapped balance without sending it into leveraged strategies. Cost: {fees}; time: 20 minutes to wrap and verify.',
    'Use a small part of the wrapped {name} balance in one ordinary transfer or deposit. Cost: {fees}; time: 15 minutes in week 3.',
    'Unwrap 25% through {name} after six weeks and compare timing and fees with the entry. Cost: {fees}; time: 20 minutes in week 7.',
  ],
  'Anchor BTC': [
    'Deposit {position} of BTC exposure through {name} and label the receiving address for a clean audit trail. Cost: {fees}; time: 30 minutes to deposit.',
    'Hold the {name} position for eight weeks without adding wrapped leverage on top. Cost: opportunity cost only; time: 10 minutes weekly for 8 weeks.',
    'Withdraw a small amount through {name} before increasing size, confirming the full custody path. Cost: {fees}; time: 25 minutes plus the withdrawal window.',
  ],
  'Decentralized BTC': [
    'Move {position} of BTC exposure into {name} through the public {chain} route, starting with a test transfer. Cost: {fees}; time: 40 minutes including the test.',
    'Use the {name} position in one conservative earning or payment flow and avoid additional wrappers. Cost: {fees}; time: 20 minutes in week 3.',
    'Return 25% through {name} after eight weeks to verify settlement and total fees. Cost: {fees}; time: 30 minutes plus network confirmation time.',
  ],
  RWA: [
    'Complete any public eligibility checks for {name}, then allocate {position} to its shortest-duration real-world asset offering. Cost: stated platform fees plus {fees}; time: 60 minutes for review and allocation.',
    'Hold the {name} position through one reporting or interest period and save the statement. Cost: opportunity cost only; time: 15 minutes when the report arrives.',
    'Redeem the smallest allowed slice of {name} at the first window to test liquidity before adding more. Cost: stated redemption fees; time: 20 minutes plus the settlement period.',
  ],
  Indexes: [
    'Buy {position} of one broad {name} index product on {chain}; avoid concentrated thematic baskets for the first position. Cost: spread and product fees plus {fees}; time: 25 minutes to compare holdings.',
    'Add {activity} to {name} monthly rather than trading in and out, and record the underlying exposure each time. Cost: {fees} per purchase; time: 10 minutes monthly for 3 months.',
    'Rebalance or sell 20% of the {name} index after one quarter to test liquidity and tracking. Cost: spread plus {fees}; time: 20 minutes in month 4.',
  ],
  'Onchain Capital Allocator': [
    'Allocate {position} through {name} to its most diversified vault or mandate on {chain}. Cost: {fees}; time: 40 minutes to read the allocation breakdown and deposit.',
    'Track {name} allocation changes monthly and calculate return net of management and performance fees. Cost: embedded fees; time: 20 minutes monthly for 3 months.',
    'Redeem 25% from {name} after the first reporting period to test notice periods and settlement. Cost: {fees}; time: 20 minutes plus any notice period.',
  ],
  'Risk Curators': [
    'Choose one {name}-curated vault with {position}, favoring diversified collateral over the highest quoted yield. Cost: {fees}; time: 45 minutes to review curator allocations.',
    'Monitor {name} vault utilization and collateral changes weekly; set a written exit trigger before depositing more. Cost: no transaction fee for monitoring; time: 15 minutes weekly for 10 weeks.',
    'Withdraw 25% from the {name} vault after six weeks and compare the exit with the stated liquidity. Cost: {fees}; time: 20 minutes in week 7.',
  ],
  'Collateral Markets': [
    'Post {position} as collateral in one {name} market on {chain} without borrowing against it in the first week. Cost: {fees}; time: 25 minutes to deposit.',
    'Borrow a token amount below 20% of collateral value on {name}, then repay it within seven days. Cost: quoted interest plus {fees}; time: 20 minutes for the cycle.',
    'Withdraw one-third of the {name} collateral after the loan is closed and keep the rest for a second month only if pricing is transparent. Cost: {fees}; time: 15 minutes in week 5.',
  ],
  'Collateral Management': [
    'Move {position} of collateral under {name} management on {chain} and set conservative liquidation alerts. Cost: {fees}; time: 35 minutes to configure.',
    'Review {name} collateral ratios weekly and add margin early rather than after a warning. Cost: possible top-up transaction fees; time: 10 minutes weekly for 8 weeks.',
    'Release 25% of collateral from {name} after one full cycle to verify permissions and settlement. Cost: {fees}; time: 20 minutes in week 9.',
  ],
  'Basis Trading': [
    'Open a delta-neutral {name} position with {position}, matching spot and derivative legs as closely as available sizes allow. Cost: trading fees plus {fees}; time: 45 minutes to build and document both legs.',
    'Check {name} funding and basis daily for the first week, then weekly; close if the net carry turns negative for three checks. Cost: funding payments shown by the venue; time: 10 minutes per check for 6 weeks.',
    'Unwind half of the {name} basis trade after one month and compare realized carry with the entry quote. Cost: closing fees on both legs; time: 30 minutes in week 5.',
  ],
  CEX: [
    'Use {name} for ordinary spot trades totaling {activity} over a month, keeping only a working balance on the exchange. Cost: published trading fees; time: 15 minutes weekly for 4 weeks. This is platform use, not a promise of any future token.',
    'Move the majority of funds off {name} to self-custody after trading, leaving no more than {activity} exposed to exchange custody. Cost: published withdrawal fee; time: 20 minutes in week 2.',
    'If {name} publicly offers a launch, learn, or loyalty program, join only the free tier and complete its ordinary tasks. Cost: $0 program fee unless separately disclosed; time: 30 minutes monthly for 3 months.',
  ],
  CeDeFi: [
    'Place {position} in the shortest flexible earning product on {name}; avoid locked terms for the first cycle. Cost: stated product fees; time: 30 minutes to review terms and deposit.',
    'Withdraw interest or a small principal slice from {name} after the first crediting period to test access. Cost: stated withdrawal fee; time: 15 minutes after the first period.',
    'Compare the realized {name} yield with self-custody staking and move funds out if the premium does not compensate custody risk. Cost: withdrawal fee if moved; time: 25 minutes in month 2.',
  ],
  'Crypto Card Issuer': [
    'If {name} offers a public card in your jurisdiction, use it for {activity} of ordinary monthly spending rather than manufactured transactions. Cost: published card and conversion fees; time: normal spending over 8 weeks.',
    'Pay the {name} card balance in full each month and save the rewards statement. Cost: $0 interest when paid in full; time: 10 minutes monthly for 3 months.',
    'Redeem the smallest available {name} reward once to verify the process, keeping the rest under the program terms. Cost: stated redemption fee, if any; time: 15 minutes in month 3.',
  ],
  Payments: [
    'Use {name} for one real payment of {activity} on {chain}, comparing its total fee with your usual rail before sending. Cost: quoted payment fee plus {fees}; time: 20 minutes for the first payment.',
    'Receive one payment through {name} and withdraw it to your normal account or wallet to test the full loop. Cost: stated receiving or withdrawal fee; time: 25 minutes in week 3.',
    'Route one recurring monthly payment through {name} only if the first two tests are cheaper or faster. Cost: quoted fee monthly; time: 10 minutes monthly for 3 months.',
  ],
  Launchpad: [
    'Create a complete {name} profile and join only public, no-fee research or allowlist steps; do not buy allocations solely for activity. Cost: $0 unless a specific sale is separately chosen; time: 30 minutes to set up.',
    'Track two upcoming {name} projects in a written scorecard covering team disclosures, token supply and lockups. Cost: $0; time: 45 minutes weekly for 4 weeks.',
    'If you participate in one {name} sale, cap it at {activity} and record the unlock schedule before paying. Cost: the chosen allocation only; time: 30 minutes on sale day.',
  ],
  'Prediction Market': [
    'Trade {activity} across several liquid {name} markets where you have a genuine view; avoid last-minute illiquid contracts. Cost: spread and platform fees; time: 30 minutes weekly for 8 weeks.',
    'Keep a forecast log for {name}: probability, stake, closing result and calibration error for every position. Cost: $0 beyond trading spread; time: 10 minutes per market over 8 weeks.',
    'Withdraw winnings or remaining balance from {name} monthly to limit platform custody. Cost: stated withdrawal fee plus {fees}; time: 15 minutes monthly for 3 months.',
  ],
  Privacy: [
    'Use {name} for one lawful, ordinary transfer of {activity} on {chain}, after checking the compliance rules that apply to you. Cost: {fees}; time: 30 minutes to prepare and verify.',
    'Keep complete private records of the {name} transfer source and destination; privacy tooling is not a substitute for tax or legal records. Cost: $0; time: 20 minutes at the time of transfer.',
    'Repeat only for a real payment need, at most monthly, and review whether {name} remains appropriate. Cost: {fees}; time: 20 minutes monthly for 3 months.',
  ],
  Chain: [
    'Bridge {activity} to {chain} and use two native applications so the {name} ecosystem sees ordinary, varied activity. Cost: bridge fee plus {fees}; time: 45 minutes in week 1.',
    'Hold a small working balance for {name} gas and make one transaction weekly for eight weeks. Cost: native gas, usually within {fees}; time: 10 minutes weekly for 8 weeks.',
    'Bridge half of the remaining balance back from {name} in week 9 and compare total costs with the entry route. Cost: bridge fee plus {fees}; time: 25 minutes in week 9.',
  ],
  Insurance: [
    'Price cover on {name} for one position you already hold, capped at {position}; buy only if the premium is below your written risk budget. Cost: quoted premium; time: 40 minutes to compare terms.',
    'Save the {name} policy wording, covered events and claim deadline with the underlying position records. Cost: $0; time: 15 minutes at purchase.',
    'Review the {name} cover monthly and let it lapse if the underlying exposure has been closed. Cost: renewal premium only if renewed; time: 10 minutes monthly until expiry.',
  ],
  'Governance Incentives': [
    'Hold {position} of the relevant governance asset only if you already accept its market risk, and vote on two live {name} proposals. Cost: {fees}; time: 30 minutes per proposal over 8 weeks.',
    'Delegate through {name} when you cannot vote directly, choosing a delegate with a public voting record. Cost: {fees}; time: 20 minutes to delegate.',
    'Claim any {name} incentive only after reading its vesting or lock terms; do not let a small reward force a larger holding. Cost: {fees}; time: 15 minutes at claim time.',
  ],
};

const FALLBACK_ACTIONS: [string, string, string] = [
  'Use the core {name} product on {chain} with {activity} of genuine activity, starting with a small test transaction. Cost: {fees}; time: 30 minutes in week 1 and 15 minutes weekly for 8 weeks.',
  'Make one deposit or position of {position} in the plainest {name} option, avoiding leverage and lockups for the first cycle. Cost: {fees} plus any fee quoted before confirmation; time: 25 minutes to open and 10 minutes weekly for 8 weeks.',
  'Withdraw or close 25% of the {name} position after six weeks to verify liquidity, timing and total fees. Cost: {fees}; time: 20 minutes in week 7.',
];

export function farmSteps(protocol: Protocol): string[] {
  const tier = tvlTier(protocol.tvl_usd);
  const chain = protocol.chains[0] ?? 'its primary chain';
  const context: FarmContext = {
    name: protocol.name,
    chain,
    chains: protocol.chains.slice(0, 3).join(', ') || chain,
    position: tier.position,
    activity: tier.activity,
    fees: networkCost(chain),
    tier: tier.label,
  };
  const actions = PLAYBOOKS[protocol.category ?? ''] ?? FALLBACK_ACTIONS;
  const flag = productFlag(protocol);
  const firstStep = flag === 'wrapped_or_staked_product'
    ? fill('Caution: {name} is a wrapped, staked or bridged product of an asset whose token already trades; any token value would likely accrue to that existing asset, so treat this row as low-conviction and size any activity accordingly. Cost: $0; time: 10 minutes to read the issuer documentation before any deposit.', context)
    : flag === 'exchange'
      ? fill('Caution: {name} is an exchange product; any token value would likely accrue to the exchange and its existing platform rather than to a new standalone token, so treat this row as low-conviction and size any activity accordingly. Cost: $0; time: 10 minutes to read the exchange token and listing disclosures before any deposit.', context)
      : fill('Start with a written risk budget for {name}: it is a {tier} protocol on {chain}, so cap the test at {position} and use a fresh wallet label for tracking. Cost: $0 to prepare; time: 30 minutes before any deposit.', context);
  return [
    firstStep,
    ...actions.map((step) => fill(step, context)),
    fill('Review {name} every Sunday for 12 weeks: record balance, fees, realized return and any product changes; stop adding funds if liquidity or terms change. Cost: no transaction fee for the review; time: 15 minutes weekly for 12 weeks.', context),
  ];
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { globalMedian, categories } = categoryStats(snapshot);
  const categoryByName = new Map(categories.map((category) => [category.category, category]));
  const watchlist = new Set(snapshot.watchlist);

  const scored = snapshot.protocols.filter(isPreToken).map((protocol) => {
    const category = categoryByName.get(categoryName(protocol))!;
    const growth = protocol.change_7d === null ? 0 : clamp(protocol.change_7d, MODEL.growthLow, MODEL.growthHigh);
    const growthMult = 1 + (growth / 100) * MODEL.growthWeight;
    const age = ageDays(snapshot.as_of, protocol.listed_at);
    const ageMult = age === null
      ? MODEL.unknownAgeMult
      : MODEL.ageFloorMult + (Math.min(age, MODEL.ageHorizonDays) / MODEL.ageHorizonDays) * MODEL.ageRange;
    const chainMult = Math.min(MODEL.chainCap, 1 + Math.max(0, protocol.chains.length - 1) * MODEL.chainStep);
    const flag = productFlag(protocol);
    const structureMult = flag === null ? 1 : MODEL.structureDiscount;
    const implied = Math.max(1, Math.round(protocol.tvl_usd * category.multiple * growthMult * ageMult * chainMult * structureMult));
    return { protocol, category, age, growthMult, ageMult, chainMult, flag, structureMult, implied };
  });

  scored.sort((a, b) => b.implied - a.implied || b.protocol.tvl_usd - a.protocol.tvl_usd || a.protocol.slug.localeCompare(b.protocol.slug));

  const board: BoardRow[] = scored.map((entry, index) => ({
    slug: entry.protocol.slug,
    name: entry.protocol.name,
    rank: index + 1,
    implied_value_usd: entry.implied,
    farm_steps: farmSteps(entry.protocol),
    category: entry.protocol.category,
    chains: entry.protocol.chains,
    tvl_usd: entry.protocol.tvl_usd,
    change_7d: entry.protocol.change_7d,
    listed_at: entry.protocol.listed_at,
    age_days: entry.age,
    category_multiple: entry.category.multiple,
    growth_mult: entry.growthMult,
    age_mult: entry.ageMult,
    chain_mult: entry.chainMult,
    product_flag: entry.flag,
    structure_mult: entry.structureMult,
    implied_tvl_ratio: entry.implied / entry.protocol.tvl_usd,
    watchlist: watchlist.has(entry.protocol.slug),
    token_status: 'records no token in the snapshot',
  }));

  const liveTokens: LiveToken[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || a.slug.localeCompare(b.slug))
    .slice(0, MODEL.liveRows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      mcap_tvl_ratio: p.mcap_usd! / p.tvl_usd,
    }));

  const radar: RadarData = {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      total_protocols: snapshot.protocols.length,
      pre_token_count: board.length,
      watchlist_count: snapshot.watchlist.length,
      tokenized_count: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
      board_size: board.length,
      model_version: MODEL_VERSION,
    },
    model: {
      formula: 'implied value = TVL x category multiple x growth multiplier x age multiplier x chain multiplier x structure multiplier',
      global_median_ratio: globalMedian,
      peer_ratio_floor: MODEL.peerRatioFloor,
      peer_ratio_cap: MODEL.peerRatioCap,
      shrinkage_prior: MODEL.shrinkagePrior,
      growth_clamp: [MODEL.growthLow, MODEL.growthHigh],
      growth_weight: MODEL.growthWeight,
      age_floor_mult: MODEL.ageFloorMult,
      age_range: MODEL.ageRange,
      age_horizon_days: MODEL.ageHorizonDays,
      unknown_age_mult: MODEL.unknownAgeMult,
      chain_step: MODEL.chainStep,
      chain_cap: MODEL.chainCap,
      structure_discount: MODEL.structureDiscount,
      category_multiple_clamp: [MODEL.categoryMultipleMin, MODEL.categoryMultipleMax],
      disclaimer: 'Implied value is this entry\u2019s own estimate from the sealed snapshot. It is not a prediction that a token will launch, when it would launch, or what it would trade for.',
    },
    categories,
    rows: board,
    live_tokens: liveTokens,
  };
  return { board, radar };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, outside 100-4000`;
  const protocolBySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const seen = new Set<string>();
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (!protocolBySlug.has(row.slug)) return `row ${row.rank} names unknown slug ${row.slug}`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    const expectedFlag = productFlag(protocolBySlug.get(row.slug)!);
    if (row.product_flag !== expectedFlag) return `row ${row.slug} carries product flag ${row.product_flag}, expected ${expectedFlag}`;
    const expectedStructureMult = expectedFlag === null ? 1 : MODEL.structureDiscount;
    if (row.structure_mult !== expectedStructureMult) return `row ${row.slug} carries structure multiplier ${row.structure_mult}, expected ${expectedStructureMult}`;
    if (row.rank !== i + 1) return `row at position ${i + 1} carries rank ${row.rank}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 100_000_000_000_000) return `row ${row.slug} has an invalid implied value`;
    if (i > 0 && row.implied_value_usd > board[i - 1]!.implied_value_usd) return `implied value rises at rank ${row.rank}`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const length = step.trim().length;
      if (length < 20 || length > 600) return `row ${row.slug} has a farm step of ${length} characters`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing`;
    if (productFlag(protocolBySlug.get(slug)!) !== null) return `watchlist slug ${slug} carries a product flag, but the watchlist rule leaves every flagged pattern out`;
  }
  if (board.every((row) => row.implied_value_usd === board[0]!.implied_value_usd)) return 'every implied value is the same';
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar).replaceAll('<', '\\u003c')};\n`;
}
