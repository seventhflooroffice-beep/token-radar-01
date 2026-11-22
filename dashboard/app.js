'use strict';

const DATA = window.RADAR;
const state = { q: '', category: '', chain: '', tvl: 0, watchOnly: false, hideFlagged: false, sortKey: 'rank', sortDir: 1, selected: null };
const $ = (selector) => document.querySelector(selector);

const COLUMNS = [
  { key: 'rank', label: 'Rank' },
  { key: 'name', label: 'Protocol' },
  { key: 'category', label: 'Category' },
  { key: 'chains', label: 'Chains' },
  { key: 'tvl_usd', label: 'TVL' },
  { key: 'change_7d', label: '7d change' },
  { key: 'implied_value_usd', label: 'Implied value' },
  { key: 'implied_tvl_ratio', label: 'Implied / TVL' },
  { key: 'watchlist', label: 'Signal' },
];

function categoryOf(row) { return row.category || 'Uncategorized'; }
function money(value) {
  if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return '$' + (value / 1e6).toFixed(1) + 'M';
  if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(value).toLocaleString('en-US');
}
function fullMoney(value) { return '$' + Math.round(value).toLocaleString('en-US'); }
function pct(value) { return value === null ? 'Not reported' : (value > 0 ? '+' : '') + value.toFixed(2) + '%'; }
function mult(value) { return value.toFixed(3) + 'x'; }
function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function categoryStat(row) { return DATA.categories.find((item) => item.category === categoryOf(row)); }
function flagLabel(flag) {
  if (flag === 'wrapped_or_staked_product') return 'Wrapped / staked product';
  if (flag === 'exchange') return 'Exchange product';
  return 'None';
}
function flagBadge(row) {
  if (!row.product_flag) return '';
  const cls = row.product_flag === 'exchange' ? 'flag-badge flag-exchange' : 'flag-badge flag-wrapped';
  const text = row.product_flag === 'exchange' ? 'EXCHANGE' : 'WRAPPED / STAKED';
  return '<span class="' + cls + '">' + text + '</span>';
}

function renderHero() {
  const meta = DATA.meta;
  $('#heroMeta').innerHTML = [
    ['Snapshot date', meta.as_of], ['Snapshot records', meta.total_protocols],
    ['Model', meta.model_version], ['Watchlist floor', money(meta.floor_usd)],
  ].map(([label, value]) => '<div><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>').join('');
  $('#stats').innerHTML = [
    ['Pre-token rows ranked', meta.board_size, 'Every protocol with no token recorded'],
    ['Watchlist covered', meta.watchlist_count + ' / ' + meta.watchlist_count, 'The required floor is fully included'],
    ['Tokenized peers used', meta.tokenized_count, 'Market evidence, kept off the board'],
    ['Global peer median', mult(DATA.model.global_median_ratio), 'Market cap / TVL across the snapshot'],
  ].map(([label, value, note]) => '<div class="stat"><span>' + label + '</span><b>' + value + '</b><small>' + note + '</small></div>').join('');
  $('#disclaimer').textContent = DATA.model.disclaimer;
}

function renderModelPanel() {
  const model = DATA.model;
  $('#formula').textContent = model.formula;
  $('#modelSummary').textContent = 'Category multiples are learned from this snapshot, not typed in as a list of favored protocols. A category with traded peers uses its median market-cap / TVL ratio; thin categories are pulled toward the global median.';
  const points = [
    '<b>Peer evidence.</b> Tokenized peer ratios are winsorized to ' + model.peer_ratio_floor.toFixed(3) + 'x–' + model.peer_ratio_cap.toFixed(2) + 'x before medians, so one extreme comparable cannot run a category.',
    '<b>Thin categories.</b> With one or two peers, the multiple is (n x category median + ' + model.shrinkage_prior + ' x global median) / (n + ' + model.shrinkage_prior + '). No peers means the global median.',
    '<b>Protocol adjustments.</b> Seven-day TVL change is clamped to ' + model.growth_clamp[0] + '% to +' + model.growth_clamp[1] + '% and weighted ' + model.growth_weight + '. Age rises from ' + model.age_floor_mult + 'x to ' + (model.age_floor_mult + model.age_range).toFixed(2) + 'x over ' + model.age_horizon_days + ' days; unknown age is ' + model.unknown_age_mult.toFixed(2) + 'x.',
    '<b>Breadth.</b> Each extra chain adds ' + Math.round(model.chain_step * 100) + '% to the chain multiplier, capped at ' + model.chain_cap.toFixed(2) + 'x. No name or slug is special-cased.',
    '<b>Structure discount.</b> A row flagged as a wrapped, staked or bridged product, or as an exchange product, is multiplied by ' + model.structure_discount.toFixed(2) + 'x: any token value would likely accrue to the asset or platform that already trades, not to a new standalone token.',
  ];
  $('#modelPoints').innerHTML = points.map((point) => '<div class="model-point">' + point + '</div>').join('');
}

function buildFilterOptions() {
  const categories = [...new Set(DATA.rows.map(categoryOf))].sort();
  $('#category').innerHTML = '<option value="">All categories</option>' + categories.map((item) => '<option>' + esc(item) + '</option>').join('');
  const chains = [...new Set(DATA.rows.flatMap((row) => row.chains))].sort();
  $('#chain').innerHTML = '<option value="">All chains</option>' + chains.map((item) => '<option>' + esc(item) + '</option>').join('');
}

function passesFilters(row) {
  const q = state.q.trim().toLowerCase();
  const haystack = (row.name + ' ' + row.slug + ' ' + categoryOf(row) + ' ' + row.chains.join(' ')).toLowerCase();
  return (!q || haystack.includes(q))
    && (!state.category || categoryOf(row) === state.category)
    && (!state.chain || row.chains.includes(state.chain))
    && row.tvl_usd >= state.tvl
    && (!state.watchOnly || row.watchlist)
    && (!state.hideFlagged || !row.product_flag);
}

function sortValue(row, key) {
  if (key === 'category') return categoryOf(row);
  if (key === 'chains') return row.chains.join(', ');
  if (key === 'watchlist') return row.watchlist ? 1 : 0;
  if (key === 'change_7d') return row.change_7d === null ? -9999 : row.change_7d;
  return row[key];
}
function sortedRows(rows) {
  return [...rows].sort((a, b) => {
    const av = sortValue(a, state.sortKey); const bv = sortValue(b, state.sortKey);
    const cmp = typeof av === 'string' ? av.localeCompare(String(bv)) : Number(av) - Number(bv);
    return (cmp || a.rank - b.rank) * state.sortDir;
  });
}

function renderHead() {
  $('#headRow').innerHTML = COLUMNS.map((column) => {
    const cls = state.sortKey === column.key ? (state.sortDir === 1 ? 'sorted-asc' : 'sorted-desc') : '';
    return '<th class="' + cls + '"><button type="button" data-sort="' + column.key + '">' + column.label + '</button></th>';
  }).join('');
  document.querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => {
    const key = button.getAttribute('data-sort');
    if (state.sortKey === key) state.sortDir *= -1;
    else { state.sortKey = key; state.sortDir = key === 'name' || key === 'category' ? 1 : -1; }
    renderBoard();
  }));
}

function rowHtml(row) {
  const changeClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
  return '<tr tabindex="0" data-slug="' + esc(row.slug) + '">'
    + '<td>#' + row.rank + '</td>'
    + '<td><span class="name">' + esc(row.name) + '</span><span class="slug">' + esc(row.slug) + '</span></td>'
    + '<td class="cat">' + esc(categoryOf(row)) + '</td>'
    + '<td class="chains">' + esc(row.chains.slice(0, 3).join(', ')) + (row.chains.length > 3 ? ' +' + (row.chains.length - 3) : '') + '</td>'
    + '<td>' + money(row.tvl_usd) + '</td>'
    + '<td class="' + changeClass + '">' + pct(row.change_7d) + '</td>'
    + '<td class="money">' + money(row.implied_value_usd) + '</td>'
    + '<td class="ratio">' + row.implied_tvl_ratio.toFixed(2) + 'x</td>'
    + '<td>' + (row.watchlist ? '<span class="badge">WATCHLIST</span>' : '<span class="note">Early</span>') + flagBadge(row) + '</td></tr>';
}

function renderBoard() {
  renderHead();
  const rows = sortedRows(DATA.rows.filter(passesFilters));
  $('#rows').innerHTML = rows.map(rowHtml).join('');
  $('#empty').hidden = rows.length !== 0;
  $('#resultLine').textContent = 'Showing ' + rows.length + ' of ' + DATA.rows.length + ' ranked protocols. Click any row for the model arithmetic and farm plan.';
  document.querySelectorAll('[data-slug]').forEach((row) => {
    row.addEventListener('click', () => openDetail(row.getAttribute('data-slug')));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(row.getAttribute('data-slug')); } });
  });
}

function renderFarmPlan(row) {
  return '<h3>Farm plan</h3><ol class="plan">' + row.farm_steps.map((step) => '<li>' + esc(step) + '</li>').join('') + '</ol>'
    + '<p class="note">A plan is a disciplined way to become a real user if a launch ever happens. It is not an eligibility promise, and position sizes should be reduced to what the reader can afford to lose.</p>';
}

function renderComparables(row) {
  const stat = categoryStat(row);
  if (!stat || stat.peers.length === 0) {
    return '<h3>Category comparables</h3><p class="note">No tokenized peer in this category appears in the snapshot, so this row uses the global median of ' + mult(DATA.model.global_median_ratio) + ' instead of pretending a direct comparable exists.</p>';
  }
  return '<h3>Tokenized comparables in ' + esc(stat.category) + '</h3><table class="comp"><thead><tr><th>Protocol</th><th>Market cap</th><th>TVL</th><th>Ratio</th></tr></thead><tbody>'
    + stat.peers.map((peer) => '<tr><td>' + esc(peer.name) + (peer.symbol ? ' (' + esc(peer.symbol) + ')' : '') + '</td><td>' + money(peer.mcap_usd) + '</td><td>' + money(peer.tvl_usd) + '</td><td>' + peer.ratio.toFixed(3) + 'x</td></tr>').join('')
    + '</tbody></table><p class="note">Peer method: ' + esc(stat.method) + ' from ' + stat.peer_count + ' tokenized peer' + (stat.peer_count === 1 ? '' : 's') + '.</p>';
}

function renderModelBreakdown(row) {
  const stat = categoryStat(row);
  const equation = fullMoney(row.tvl_usd) + ' TVL x ' + row.category_multiple.toFixed(3) + ' category x ' + row.growth_mult.toFixed(3) + ' growth x ' + row.age_mult.toFixed(3) + ' age x ' + row.chain_mult.toFixed(3) + ' chains x ' + row.structure_mult.toFixed(3) + ' structure = <b>' + fullMoney(row.implied_value_usd) + '</b>';
  const facts = [
    ['Rank', '#' + row.rank], ['Category', categoryOf(row)],
    ['TVL', fullMoney(row.tvl_usd)], ['7d TVL change', pct(row.change_7d)],
    ['Category multiple', row.category_multiple.toFixed(4) + 'x'], ['Peer median', stat && stat.peer_median !== null ? stat.peer_median.toFixed(4) + 'x' : 'None'],
    ['Age in snapshot', row.age_days === null ? 'Not reported' : row.age_days + ' days'], ['Listed at', row.listed_at || 'Not reported'],
    ['Chains', row.chains.join(', ')], ['Implied / TVL', row.implied_tvl_ratio.toFixed(3) + 'x'],
    ['Product flag', flagLabel(row.product_flag)], ['Structure multiplier', row.structure_mult.toFixed(2) + 'x'],
  ];
  return '<div class="equation">' + equation + '</div><div class="facts">'
    + facts.map(([label, value]) => '<div class="fact"><span>' + label + '</span><b>' + esc(value) + '</b></div>').join('') + '</div>';
}

function openDetail(slug) {
  const row = DATA.rows.find((item) => item.slug === slug);
  if (!row) return;
  state.selected = slug;
  $('#detail').innerHTML = '<p class="detail-kicker">Rank #' + row.rank + (row.watchlist ? ' · Watchlist' : ' · Early radar') + '</p>'
    + '<h2 id="detailName">' + esc(row.name) + '</h2>'
    + '<p class="detail-sub">' + esc(row.slug) + ' · ' + esc(categoryOf(row)) + ' · ' + esc(row.token_status) + (row.product_flag ? ' · Flagged: ' + flagLabel(row.product_flag) : '') + '</p>'
    + renderModelBreakdown(row)
    + '<h3 style="margin-top:22px">Why this multiple?</h3><p class="note">The category multiple is not a house constant. It is calculated in buildRadar from tokenized protocols in the same sealed snapshot, using the peer rules in the model panel.</p>'
    + renderComparables(row)
    + '<div style="margin-top:22px">' + renderFarmPlan(row) + '</div>';
  $('#scrim').hidden = false;
  $('#drawer').hidden = false;
  $('#closeDetail').focus();
}
function closeDetail() { state.selected = null; $('#scrim').hidden = true; $('#drawer').hidden = true; }

function renderLiveTokens() {
  $('#liveTokens').innerHTML = DATA.live_tokens.map((token) => '<div class="live"><strong>' + token.mcap_tvl_ratio.toFixed(2) + 'x</strong><b>' + esc(token.name) + (token.symbol ? ' · ' + esc(token.symbol) : '') + '</b><span>Market cap ' + money(token.mcap_usd) + ' · TVL ' + money(token.tvl_usd) + '<br>' + esc(token.category || 'Uncategorized') + '</span></div>').join('');
}

function bindControls() {
  $('#search').addEventListener('input', (event) => { state.q = event.target.value; renderBoard(); });
  $('#category').addEventListener('change', (event) => { state.category = event.target.value; renderBoard(); });
  $('#chain').addEventListener('change', (event) => { state.chain = event.target.value; renderBoard(); });
  $('#tvl').addEventListener('change', (event) => { state.tvl = Number(event.target.value); renderBoard(); });
  $('#watchOnly').addEventListener('change', (event) => { state.watchOnly = event.target.checked; renderBoard(); });
  $('#hideFlagged').addEventListener('change', (event) => { state.hideFlagged = event.target.checked; renderBoard(); });
  $('#reset').addEventListener('click', () => {
    state.q = ''; state.category = ''; state.chain = ''; state.tvl = 0; state.watchOnly = false; state.hideFlagged = false; state.sortKey = 'rank'; state.sortDir = 1;
    $('#controls').reset(); renderBoard();
  });
  $('#closeDetail').addEventListener('click', closeDetail);
  $('#scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDetail(); });
}

renderHero();
renderModelPanel();
buildFilterOptions();
bindControls();
renderBoard();
renderLiveTokens();
